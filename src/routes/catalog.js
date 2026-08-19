/**
 * /v1/catalog — Canonical catalog API
 *
 * The Flutter app talks to these endpoints for everything music-related.
 * It never needs to know whether data came from iTunes, JioSaavn, Gaana, or the DB.
 *
 * Routes:
 *   GET  /v1/catalog/search?q=...            - parallel multi-provider search (JioSaavn + Gaana)
 *   GET  /v1/catalog/tracks/:id              - canonical track details
 *   GET  /v1/catalog/resolve/:id             - resolve canonical → stream URL
 *   GET  /v1/catalog/play/:id                - stable playback redirect URL
 *   GET  /v1/playback/song/:id               - alias for stable playback URL
 *   GET  /v1/home                            - dynamic home feed sections
 */

import { Router } from 'express';
import { auth } from '../config/firebase.js';
import {
    analyzeQuery,
    buildSearchVariants,
    fuseSongCandidates,
    filterRelevantSongs,
} from '../services/searchEngine.js';
import {
    searchSongsOnly,
    searchSongsSmart,
    getArtistById,
    getAlbumById,
} from '../services/saavnApi.js';
import { 
    searchSongsOnly as searchGaanaSongsOnly,
    getSongFromUrl,
    getSongById as getGaanaSongById
} from '../services/gaanaApi.js';
import {
    attachCanonicalIds,
    getTrack,
    getProviderTrackId,
} from '../services/identityResolver.js';
import {
    resolveStream,
    PlaybackResolveError,
} from '../services/playbackResolver.js';
import { getUserPreferences, getGlobalTrending, getRecentActivity } from '../services/database.js';
import { generateRecommendations } from '../services/recommendation.js';
import { rerankSongsForUser } from '../services/personalizationModel.js';
import { normalizeSongMetadata, normalizeSongList } from '../services/metadataService.js';

const router = Router();

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function resolveUid(req) {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return null;
    try {
        const decoded = await auth.verifyIdToken(header.slice(7));
        return decoded.uid;
    } catch {
        return null;
    }
}

// ─── Shape a canonical song for API responses ─────────────────────────────────

function shapeSong(song) {
    return normalizeSongMetadata(song);
}

// ─── GET /v1/catalog/search ───────────────────────────────────────────────────

router.get('/catalog/search', async (req, res) => {
    const rawQ = (req.query.q ?? '').trim();
    if (!rawQ) return res.status(400).json({ error: 'q is required' });

    const uid   = await resolveUid(req);
    const page  = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    const limit = Math.min(40, Math.max(5, parseInt(req.query.limit ?? '40', 10) || 40));

    try {
        const analysis = analyzeQuery(rawQ);
        const primaryQ = analysis.cleanTitle || rawQ;
        const searchVariants = buildSearchVariants(analysis);

        // Parallel multi-provider search: JioSaavn variants + Gaana direct
        const [gaanaResults, ...variantResults] = await Promise.all([
            searchGaanaSongsOnly(primaryQ, limit).catch(() => []),
            ...searchVariants.map(variant =>
                searchSongsSmart(variant || primaryQ, { preferredLanguages: [], waitForFresh: true })
                    .catch(async () => {
                        const payload = await searchSongsOnly(variant || primaryQ, page).catch(() => null);
                        return payload?.data?.results ?? [];
                    })
            )
        ]);

        const candidateGroups = [
            { source: 'gaana', weight: 0.90, songs: Array.isArray(gaanaResults) ? gaanaResults : [] },
            ...variantResults.map((songs, index) => ({
                source: index === 0 ? 'exact' : `variant:${index}`,
                weight: Math.max(0.45, 1 - index * 0.15),
                songs: Array.isArray(songs) ? songs : (songs?.data?.results ?? []),
            }))
        ];

        // Deduplicate → rank
        let songs = filterRelevantSongs(
            fuseSongCandidates(candidateGroups, analysis),
            analysis,
            { minKeep: Math.min(12, limit) },
        ).slice(0, limit);

        // Personalise if user is known
        if (uid) {
            songs = await rerankSongsForUser({
                uid,
                songs,
                query: rawQ,
                preferredLanguages: [],
                mode: 'search',
            }).catch(() => songs);
        }

        // Assign canonical IDs
        songs = attachCanonicalIds(songs);

        return res.json({
            query:   rawQ,
            page,
            results: songs.map(shapeSong),
            meta: { total: songs.length },
        });
    } catch (err) {
        console.error('[catalog/search]', err);
        return res.status(500).json({ error: 'Search failed' });
    }
});

// ─── GET /v1/catalog/tracks/:id ──────────────────────────────────────────────

router.get('/catalog/tracks/:id', async (req, res) => {
    const canonicalId = req.params.id;
    if (!canonicalId?.startsWith('trk_')) {
        return res.status(400).json({ error: 'Invalid canonical track ID' });
    }

    const track = getTrack(canonicalId);
    if (!track) return res.status(404).json({ error: 'Track not found' });

    const jiosaavnId = getProviderTrackId(canonicalId, 'jiosaavn');

    return res.json({
        type:        'song',
        id:          canonicalId,
        providerId:  jiosaavnId,
        title:       track.title,
        artist:      [{ id: track.artist_id, name: track.artist_name }],
        album:       { id: track.album_id, name: track.album_name },
        artwork:     track.artwork_url,
        durationMs:  track.duration_ms,
        language:    track.language,
        genre:       track.genre,
        isExplicit:  track.is_explicit === 1,
        isrc:        track.isrc,
        year:        track.release_year,
    });
});

// ─── GET /v1/catalog/resolve/:id ─────────────────────────────────────────────

router.get('/catalog/resolve/:id', async (req, res) => {
    const canonicalId = req.params.id;
    const hasOverride = !!(req.query.title || req.query.artist);
    if (!canonicalId?.startsWith('trk_') && !hasOverride) {
        return res.status(400).json({ error: 'Invalid canonical track ID' });
    }

    try {
        const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
        const failedUrl = typeof req.query.failedUrl === 'string'
            ? req.query.failedUrl
            : undefined;

        let overrideTrack = null;
        if (hasOverride) {
            overrideTrack = {
                title: req.query.title ?? '',
                artist_name: req.query.artist ?? '',
                album_name: req.query.album ?? '',
                duration_ms: req.query.duration ? (parseInt(req.query.duration, 10) * 1000) : undefined,
                language: req.query.language ?? ''
            };
        }

        const track = overrideTrack || getTrack(canonicalId);
        const durationSec = track && track.duration_ms ? Math.round(track.duration_ms / 1000) : 0;
        const result = await resolveStream(canonicalId, {
            forceRefresh: forceRefresh || !!overrideTrack,
            failedUrl,
            overrideTrack,
            quality: req.query.quality,
        });
        return res.json({
            songId: canonicalId,
            canonicalId,
            metadata: {
                title: track?.title ?? '',
                artist: track?.artist_name ?? '',
                album: track?.album_name ?? '',
                artwork: track?.artwork_url ?? null,
                duration: durationSec,
                language: track?.language ?? null,
            },
            playback: {
                status: 'ready',
                provider: result.provider,
                streamUrl: `/v1/catalog/play/${canonicalId}`,
                directStreamUrl: result.url,
                quality: result.quality,
                fallback: result.fallbackProvider ?? null,
                fallbackUrl: result.fallbackUrl ?? null,
                validationStatus: result.validationStatus ?? 'verified-playable',
                confidence: result.confidence ?? null,
                resolvedAt: result.resolvedAt ?? new Date().toISOString(),
            },
            title: track?.title ?? '',
            artist: track?.artist_name ?? '',
            album: track?.album_name ?? '',
            duration: durationSec,
            streamUrl: result.url,
            quality:   result.quality,
            provider:  result.provider,
            confidence: result.confidence ?? null,
            resolvedAt: result.resolvedAt ?? new Date().toISOString(),
            validationStatus: result.validationStatus ?? 'cached-or-provider',
            stream: {
                provider: result.provider,
                url: result.url,
                fallbackProvider: result.fallbackProvider ?? null,
                fallbackUrl: result.fallbackUrl ?? null,
            }
        });
    } catch (err) {
        if (err instanceof PlaybackResolveError) {
            const status = err.code === 'NOT_FOUND' ? 404 : 503;
            return res.status(status).json({ error: err.message, code: err.code });
        }
        console.error('[catalog/resolve]', err);
        return res.status(500).json({ error: 'Resolution failed' });
    }
});

// ─── GET /v1/catalog/play/:id ────────────────────────────────────────────────
// Stable playback URL redirect endpoint. Audio players stream directly from this.

async function handlePlaybackRedirect(req, res) {
    const canonicalId = req.params.id;
    const hasOverride = !!(req.query.title || req.query.artist);
    if (!canonicalId?.startsWith('trk_') && !hasOverride) {
        return res.status(400).json({ error: 'Invalid canonical track ID' });
    }

    try {
        const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
        const failedUrl = typeof req.query.failedUrl === 'string' ? req.query.failedUrl : undefined;

        let overrideTrack = null;
        if (hasOverride) {
            overrideTrack = {
                title: req.query.title ?? '',
                artist_name: req.query.artist ?? '',
                album_name: req.query.album ?? '',
                duration_ms: req.query.duration ? (parseInt(req.query.duration, 10) * 1000) : undefined,
                language: req.query.language ?? ''
            };
        }

        const result = await resolveStream(canonicalId, {
            forceRefresh: forceRefresh || !!overrideTrack,
            failedUrl,
            overrideTrack,
            quality: req.query.quality,
        });

        if (result.url) {
            // Redirect to the resolved media stream URL (typically Akamai or JioSaavn CDN)
            res.redirect(302, result.url);
        } else {
            res.status(404).json({ error: 'No playable stream found for this track' });
        }
    } catch (err) {
        if (err instanceof PlaybackResolveError) {
            const status = err.code === 'NOT_FOUND' ? 404 : 503;
            return res.status(status).json({ error: err.message, code: err.code });
        }
        console.error('[catalog/play]', err);
        return res.status(500).json({ error: 'Playback resolution failed' });
    }
}

router.get('/catalog/play/:id', handlePlaybackRedirect);
router.get('/playback/song/:id', handlePlaybackRedirect);

// ─── GET /v1/catalog/gaana (Direct Gaana Link / URL Resolver) ─────────────────
// Supports direct Gaana URLs (e.g. ?url=https://gaana.com/song/chaleya or ?url=chaleya)

async function handleGaanaDirectUrl(req, res) {
    const rawUrl = (req.query.url ?? req.query.link ?? req.query.song ?? req.query.q ?? '').trim();
    if (!rawUrl) {
        return res.status(400).json({ error: 'url or link query parameter is required' });
    }

    try {
        const result = await getSongFromUrl(rawUrl);
        if (!result.success) {
            return res.status(404).json({ error: result.error || 'Song not found' });
        }
        return res.json(result.data);
    } catch (err) {
        console.error('[gaana/url]', err);
        return res.status(500).json({ error: 'Failed to resolve Gaana song' });
    }
}

router.get('/catalog/gaana', handleGaanaDirectUrl);
router.get('/gaana', handleGaanaDirectUrl);
router.get('/gaana/result', handleGaanaDirectUrl);
router.get('/gaana/song', handleGaanaDirectUrl);

// ─── GET /v1/home ─────────────────────────────────────────────────────────────
// Returns dynamic sections. Each section type is rendered by HomeScreen.

router.get('/home', async (req, res) => {
    const uid = await resolveUid(req);
    if (!uid) return res.status(401).json({ error: 'Authentication required' });

    const languages = ((req.query.languages ?? '') + '').split(',').filter(Boolean);

    try {
        // Fire all section sources in parallel
        const [
            recentlyPlayed,
            recommended,
            trending,
        ] = await Promise.allSettled([
            _fetchRecentlyPlayed(uid),
            _fetchRecommended(uid, languages),
            _fetchTrending(languages),
        ]);

        const sections = [];

        // 1. Continue Listening — if user has a recent play
        const recent = recentlyPlayed.status === 'fulfilled' ? recentlyPlayed.value : [];
        if (recent.length > 0) {
            sections.push({ type: 'continue_listening', title: 'Continue Listening', items: recent.slice(0, 1) });
        }

        // 2. Recently Played
        if (recent.length > 0) {
            sections.push({ type: 'recently_played', title: 'Recently Played', items: recent.slice(0, 12) });
        }

        // 3. Recommended For You
        const recs = recommended.status === 'fulfilled' ? recommended.value : [];
        if (recs.length > 0) {
            sections.push({ type: 'recommended', title: 'Recommended For You', items: recs.slice(0, 20) });
        }

        // 4. Trending
        const trend = trending.status === 'fulfilled' ? trending.value : [];
        if (trend.length > 0) {
            sections.push({ type: 'trending', title: 'Trending Now', items: trend.slice(0, 20) });
        }

        return res.json({ sections });
    } catch (err) {
        console.error('[home]', err);
        return res.status(500).json({ error: 'Home feed failed' });
    }
});

// ─── Section fetchers ─────────────────────────────────────────────────────────

import { db as firebaseDb } from '../config/firebase.js';

async function _fetchRecentlyPlayed(uid) {
    const snap = await firebaseDb.ref(`users/${uid}/activity`)
        .orderByChild('timestamp')
        .limitToLast(30)
        .get();

    if (!snap.exists()) return [];

    const events = [];
    snap.forEach(child => {
        const v = child.val();
        if (v.type === 'play' && v.songId) events.push(v);
    });

    events.sort((a, b) => b.timestamp - a.timestamp);

    // Deduplicate by songId
    const seen = new Set();
    const unique = [];
    for (const e of events) {
        if (!seen.has(e.songId)) { seen.add(e.songId); unique.push(e); }
    }

    return unique.slice(0, 15).map(e => {
        const img = e.imageUrl ?? e.artwork ?? null;
        return {
            type:      'song',
            id:        e.canonicalId ?? e.songId,
            providerId: e.songId,
            title:     e.songName ?? '',
            artist:    [{ id: null, name: e.artist ?? e.artistName ?? '' }],
            imageUrl:  img,
            image:     img ? [{ quality: '500x500', url: img }] : [],
            artwork:   img,
            durationMs: null,
        };
    });
}

async function _fetchRecommended(uid, languages) {
    try {
        const prefs = await getUserPreferences(uid);
        if (!prefs) return [];
        const langs = languages.length ? languages : (prefs.languages ?? []);
        const songs = await generateRecommendations(
            { languages: langs, favoriteArtists: prefs.favoriteArtists ?? [] },
            uid,
        );
        return attachCanonicalIds(songs ?? []).map(shapeSong).slice(0, 20);
    } catch {
        // Fall back to a language-based query so home never returns empty
        try {
            const prefs = await getUserPreferences(uid).catch(() => null);
            const langs = languages.length ? languages : (prefs?.languages ?? ['hindi']);
            const lang = langs[Math.floor(Math.random() * langs.length)] ?? 'hindi';
            const raw = await searchSongsOnly(`top ${lang} songs`, 1, 25);
            return attachCanonicalIds(raw?.data?.results ?? []).map(shapeSong);
        } catch {
            return [];
        }
    }
}

async function _fetchTrending(languages) {
    try {
        // First try real global trending from Firebase activity data
        const trending = await getGlobalTrending(25);
        if (trending.length >= 5) {
            // Trending entries have { songId, songName, artist, language, playCount }
            // Re-fetch full song objects from Saavn for the top ones so artwork is present
            const topIds = trending.slice(0, 10).map(t => t.songId).filter(Boolean);
            if (topIds.length > 0) {
                const { getSongById } = await import('../services/saavnApi.js');
                const fetched = await Promise.allSettled(topIds.map(id => getSongById(id)));
                const songs = fetched
                    .filter(r => r.status === 'fulfilled')
                    .map(r => r.value?.data?.[0] ?? r.value?.data ?? null)
                    .filter(Boolean);
                if (songs.length >= 3) {
                    return attachCanonicalIds(songs).map(shapeSong);
                }
            }
        }
    } catch { /* fall through */ }

    // Fallback: language-based Saavn search
    try {
        const lang = languages[0] ?? 'hindi';
        const raw = await searchSongsOnly(`trending ${lang}`, 1, 20);
        return attachCanonicalIds(raw?.data?.results ?? []).map(shapeSong);
    } catch {
        return [];
    }
}

export default router;
