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

// ─── Search budget & response cache ───────────────────────────────────────────

// A search must answer within a predictable wall-clock window. Providers are
// raced against this budget and whatever has arrived is ranked and returned;
// a lane that is still in flight is simply dropped rather than waited on.
const SEARCH_BUDGET_MS = 4500;
// Number of query variants fanned out to the smart-search path. Each variant
// is itself a multi-variant, multi-provider search, so this multiplies fast —
// keeping it small is what stops the provider from rate-limiting us into
// empty results.
const SEARCH_MAX_VARIANTS = 3;
const SEARCH_RESPONSE_CACHE_TTL_MS = 60 * 1000;
const SEARCH_RESPONSE_CACHE_MAX = 200;

const searchResponseCache = new Map();

function readSearchCache(key) {
    const hit = searchResponseCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.storedAt > SEARCH_RESPONSE_CACHE_TTL_MS) {
        searchResponseCache.delete(key);
        return null;
    }
    // Hand out a copy: the caller passes this list through personalisation and
    // canonical-ID attachment, and the cached entry is shared by every user.
    return hit.songs.slice();
}

function writeSearchCache(key, songs) {
    if (!Array.isArray(songs) || songs.length === 0) return; // never cache a miss
    searchResponseCache.set(key, { storedAt: Date.now(), songs: songs.slice() });
    while (searchResponseCache.size > SEARCH_RESPONSE_CACHE_MAX) {
        const oldest = searchResponseCache.keys().next().value;
        if (oldest === undefined) break;
        searchResponseCache.delete(oldest);
    }
}

/**
 * Wait for every lane, but stop early on either of two conditions:
 *   - `budgetMs` is spent (stragglers are dropped, partial data survives), or
 *   - `isEnough` reports that the lanes which already settled carry a good
 *     enough answer, so the remaining ones are redundant.
 * Each lane records its own result as it settles, so nothing already fetched is
 * thrown away in either case.
 */
async function settleWithinBudget(lanes, budgetMs, isEnough) {
    let timer;
    let resolveEarly;

    const budget = new Promise(resolve => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref?.();
    });
    const early = new Promise(resolve => { resolveEarly = resolve; });

    let pending = lanes.length;
    for (const lane of lanes) {
        lane.settled.finally(() => {
            pending -= 1;
            if (pending === 0) return resolveEarly();
            try {
                if (isEnough?.(lanes)) resolveEarly();
            } catch { /* a predicate failure must never stall the search */ }
        });
    }

    await Promise.race([early, budget]);
    clearTimeout(timer);
}

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

    const startedAt = Date.now();

    try {
        const analysis = analyzeQuery(rawQ);
        const primaryQ = analysis.cleanTitle || rawQ;
        const cacheKey = `${primaryQ.toLowerCase()}|${page}|${limit}`;

        let songs = readSearchCache(cacheKey);

        if (!songs) {
            const searchVariants = buildSearchVariants(analysis).slice(0, SEARCH_MAX_VARIANTS);

            // Parallel multi-provider search: JioSaavn variants + Gaana direct.
            // `waitForFresh` is deliberately off — a slightly stale cached hit
            // returned instantly beats a fresh one the user waited seconds for,
            // and the smart-search layer refreshes it in the background.
            const lanes = [
                {
                    source: 'gaana',
                    weight: 0.90,
                    songs: [],
                    promise: searchGaanaSongsOnly(primaryQ, Math.min(limit, 12), { withStreams: false }),
                },
                ...searchVariants.map((variant, index) => ({
                    source: index === 0 ? 'exact' : `variant:${index}`,
                    weight: Math.max(0.45, 1 - index * 0.15),
                    songs: [],
                    promise: searchSongsSmart(variant || primaryQ, { preferredLanguages: [] })
                        .catch(async () => {
                            const payload = await searchSongsOnly(variant || primaryQ, page).catch(() => null);
                            return payload?.data?.results ?? [];
                        }),
                })),
            ];

            for (const lane of lanes) {
                lane.settled = lane.promise.then(
                    (value) => {
                        lane.songs = Array.isArray(value) ? value : (value?.data?.results ?? []);
                    },
                    () => { lane.songs = []; },
                );
            }

            // The primary ("exact") lane is the one that decides the answer;
            // the rest only broaden it. Once it has come back with a full page
            // of candidates there is nothing to gain by waiting on the others.
            const primaryLane = lanes.find(lane => lane.source === 'exact');
            await settleWithinBudget(lanes, SEARCH_BUDGET_MS, () => (
                (primaryLane?.songs?.length ?? 0) >= Math.min(limit, 20)
            ));

            const candidateGroups = lanes.map(({ source, weight, songs: laneSongs }) => ({
                source,
                weight,
                songs: laneSongs,
            }));

            // An empty or slow search is the failure mode users actually feel,
            // and it is invisible from the outside (it still returns HTTP 200).
            // Log which lane came up short so it can be diagnosed from the logs.
            const elapsedMs = Date.now() - startedAt;
            if (candidateGroups.every(group => group.songs.length === 0) || elapsedMs > SEARCH_BUDGET_MS) {
                console.warn('[catalog/search] degraded', {
                    q: rawQ,
                    ms: elapsedMs,
                    lanes: candidateGroups.map(g => `${g.source}=${g.songs.length}`).join(' '),
                });
            }

            // Deduplicate → rank
            songs = filterRelevantSongs(
                fuseSongCandidates(candidateGroups, analysis),
                analysis,
                { minKeep: Math.min(12, limit) },
            ).slice(0, limit);

            writeSearchCache(cacheKey, songs);
        }

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
