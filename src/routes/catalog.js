/**
 * /v1/catalog — Canonical catalog API
 *
 * The Flutter app talks to these endpoints for everything music-related.
 * It never needs to know whether data came from iTunes, JioSaavn, or the DB.
 *
 * Routes:
 *   GET  /v1/catalog/search?q=...            - search, returns canonical entities
 *   GET  /v1/catalog/tracks/:id              - canonical track details
 *   GET  /v1/catalog/resolve/:id             - resolve canonical → stream URL
 *   GET  /v1/home                            - dynamic home feed sections
 */

import { Router } from 'express';
import { auth } from '../config/firebase.js';
import {
    analyzeQuery,
    buildSearchVariants,
    rankSongs,
    deduplicateSongs,
} from '../services/searchEngine.js';
import {
    searchSongsOnly,
    searchSongsSmart,
    getArtistById,
    getAlbumById,
} from '../services/saavnApi.js';
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
import { rerankSongsForUser } from '../services/personalizationModel.js';
import { generateRecommendations } from '../services/recommendation.js';

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
    const artwork = Array.isArray(song.image)
        ? (song.image.find(i => i.quality === '500x500')?.url ?? song.image.slice(-1)[0]?.url)
        : (song.image ?? null);

    const artist = Array.isArray(song.artists?.primary)
        ? song.artists.primary.map(a => ({ id: a.id, name: a.name }))
        : [{ id: null, name: song.primaryArtists ?? song.artist ?? '' }];

    const albumName = typeof song.album === 'string' ? song.album
        : (song.album?.name ?? song.albumName ?? '');

    return {
        type:          'song',
        id:            song.canonicalId ?? song.id,
        providerId:    song.id,
        title:         song.name ?? song.title ?? '',
        artist,
        album: {
            id:        song.album?.id ?? song.albumId ?? null,
            name:      albumName,
        },
        artwork,
        durationMs:    (parseInt(song.duration ?? 0, 10) || 0) * 1000,
        language:      song.language ?? null,
        hasDownloadUrl: !!(song.downloadUrl?.length || song.streamUrl?.length),
        year:          song.year ? parseInt(song.year, 10) : null,
    };
}

// ─── GET /v1/catalog/search ───────────────────────────────────────────────────

router.get('/catalog/search', async (req, res) => {
    const rawQ = (req.query.q ?? '').trim();
    if (!rawQ) return res.status(400).json({ error: 'q is required' });

    const uid   = await resolveUid(req);
    const page  = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    const limit = Math.min(20, Math.max(5, parseInt(req.query.limit ?? '20', 10) || 20));

    try {
        const analysis = analyzeQuery(rawQ);
        const primaryQ = analysis.cleanTitle || rawQ;

        // JioSaavn search
        const saavnRaw = await searchSongsSmart(primaryQ, { page, limit: limit + 10, preferredLanguages: [] })
            .catch(() => searchSongsOnly(primaryQ, page, limit + 10).catch(() => []));

        // Deduplicate → rank
        let songs = rankSongs(deduplicateSongs(saavnRaw ?? []), analysis).slice(0, limit);

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
    if (!canonicalId?.startsWith('trk_')) {
        return res.status(400).json({ error: 'Invalid canonical track ID' });
    }

    try {
        const result = await resolveStream(canonicalId);
        return res.json({
            canonicalId,
            streamUrl: result.url,
            quality:   result.quality,
            provider:  result.provider,
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

        return res.json({ sections, uid });
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

    return unique.slice(0, 15).map(e => ({
        type:      'song',
        id:        e.canonicalId ?? e.songId,
        providerId: e.songId,
        title:     e.songName ?? '',
        artist:    [{ id: null, name: e.artistName ?? '' }],
        artwork:   e.imageUrl ?? null,
        durationMs: null,
    }));
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
            return attachCanonicalIds(raw ?? []).map(shapeSong);
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
        return attachCanonicalIds(raw ?? []).map(shapeSong);
    } catch {
        return [];
    }
}

export default router;
