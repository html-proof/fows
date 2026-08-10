/**
 * Deezer API client — search enrichment layer.
 *
 * No authentication required for search.  Rate limit is generous (≈ 50 req/s).
 * Used for two purposes:
 *   1. Enrich JioSaavn results with clean metadata (title, artist, album, artwork).
 *   2. Obtain ISRC per track — the strongest cross-provider canonical identity.
 *
 * Deezer is NOT used for playback (previews are 30 s only).
 * JioSaavn remains the sole playback provider.
 */

import { request } from 'undici';
import { normText, bigramSimilarity } from './searchEngine.js';

const BASE          = 'https://api.deezer.com';
const CONNECT_MS    = 3000;
const BODY_MS       = 4000;
const CACHE_TTL_MS  = 10 * 60 * 1000; // 10 min
const CACHE_MAX     = 200;

// ─── Simple in-process cache ──────────────────────────────────────────────────

const _cache = new Map(); // key → { value, expiresAt }

function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
    return entry.value;
}

function _cacheSet(key, value) {
    if (_cache.size >= CACHE_MAX) {
        // evict oldest
        const oldest = _cache.keys().next().value;
        _cache.delete(oldest);
    }
    _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function _get(path, params = {}) {
    const url = new URL(path, BASE);
    url.searchParams.set('output', 'json');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const { statusCode, body } = await request(url.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        connectTimeout: CONNECT_MS,
        bodyTimeout: BODY_MS,
    });

    if (statusCode !== 200) throw new Error(`Deezer HTTP ${statusCode}`);
    const json = await body.json();
    if (json?.error) throw new Error(`Deezer API error: ${json.error.message}`);
    return json;
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function _normalise(raw) {
    return {
        deezerId:   String(raw.id ?? ''),
        title:      raw.title_short ?? raw.title ?? '',
        titleFull:  raw.title ?? '',
        artist:     raw.artist?.name ?? '',
        artistId:   String(raw.artist?.id ?? ''),
        album:      raw.album?.title ?? '',
        albumId:    String(raw.album?.id ?? ''),
        isrc:       raw.isrc ?? null,        // ← key field for canonical identity
        durationMs: (raw.duration ?? 0) * 1000,
        rank:       raw.rank ?? 0,
        artworkSm:  raw.album?.cover_small  ?? raw.album?.cover ?? null,
        artworkMd:  raw.album?.cover_medium ?? null,
        artworkLg:  raw.album?.cover_xl     ?? raw.album?.cover_big ?? null,
        explicit:   raw.explicit_lyrics ?? false,
        previewUrl: raw.preview ?? null,    // 30-second mp3 — NOT for playback
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search Deezer for tracks matching a query.
 * Returns up to `limit` normalised track objects.
 */
export async function searchDeezer(query, { limit = 20 } = {}) {
    const clean = String(query ?? '').trim();
    if (!clean) return [];

    const cacheKey = `search:${limit}:${clean.toLowerCase()}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    try {
        const data = await _get('/search', { q: clean, limit: Math.min(limit, 50) });
        const tracks = (data?.data ?? []).map(_normalise);
        _cacheSet(cacheKey, tracks);
        return tracks;
    } catch (err) {
        console.warn(`[Deezer] search failed for "${clean}": ${err.message}`);
        return [];
    }
}

/**
 * Match a single JioSaavn song to the best Deezer candidate and return the
 * enriched metadata (including ISRC).  Returns null when no confident match
 * is found (score < threshold) so the original song is never corrupted.
 *
 * Matching criteria (weighted):
 *   title similarity  60 %
 *   artist similarity 30 %
 *   duration delta    10 %   (bonus when within 5 s, penalty beyond 15 s)
 */
export function matchSaavnToDeezer(saavnSong, deezerTracks) {
    if (!deezerTracks?.length) return null;

    const sTitle  = normText(saavnSong?.name ?? saavnSong?.title ?? '');
    const sArtist = normText(
        saavnSong?.primaryArtists
        ?? (Array.isArray(saavnSong?.artists?.primary)
            ? saavnSong.artists.primary.map(a => a?.name ?? '').join(' ')
            : '')
    );
    const sDurSec = parseInt(saavnSong?.duration ?? 0, 10);

    let best = null, bestScore = -Infinity;

    for (const track of deezerTracks) {
        const ts = bigramSimilarity(sTitle,  normText(track.title));
        const as = bigramSimilarity(sArtist, normText(track.artist));

        let score = ts * 60 + as * 30;

        // Exact title match bonus
        if (normText(track.title) === sTitle) score += 15;

        // Duration match
        if (sDurSec > 0 && track.durationMs > 0) {
            const diffSec = Math.abs(sDurSec - track.durationMs / 1000);
            if (diffSec <= 5)       score += 10;
            else if (diffSec <= 15) score += 3;
            else if (diffSec > 30)  score -= 10;
        }

        if (score > bestScore) { bestScore = score; best = track; }
    }

    // Require title similarity ≥ 0.5 and overall score ≥ 50 before trusting match
    if (!best) return null;
    const titleSim = bigramSimilarity(sTitle, normText(best.title));
    if (titleSim < 0.5 || bestScore < 50) return null;

    return best;
}

/**
 * Enrich an array of JioSaavn songs with Deezer metadata.
 *
 * Adds `deezerMeta` to each song that has a confident match.  The most
 * important field is `deezerMeta.isrc` — used downstream by identityResolver
 * for canonical ID assignment.
 *
 * Songs without a Deezer match are returned unchanged.
 */
export async function enrichSongsWithDeezer(songs, query) {
    if (!songs?.length) return songs;

    const deezerTracks = await searchDeezer(query, { limit: 30 });
    if (!deezerTracks.length) return songs;

    return songs.map(song => {
        const match = matchSaavnToDeezer(song, deezerTracks);
        if (!match) return song;
        return { ...song, deezerMeta: match };
    });
}
