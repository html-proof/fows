/**
 * iTunes Search API — metadata enrichment and identity confirmation.
 *
 * iTunes is used ONLY for metadata and match scoring, never for audio streams.
 * All playback goes through JioSaavn. iTunes gives us:
 *   - Canonical artist / title / album names (reduces transliteration variance)
 *   - High-res artwork (3000×3000 via `{w}x{h}bb.jpg` URL hack)
 *   - Genre, release year, duration
 *   - Track count / disc number for album context
 *
 * No API key required. Rate limit: ~20 req/s per IP — safe for search use.
 */

import { request } from 'undici';
import { normText, bigramSimilarity } from './searchEngine.js';

const ITUNES_BASE = 'https://itunes.apple.com/search';
const ITUNES_TIMEOUT_MS = 4000;

// ─── Circuit breaker ──────────────────────────────────────────────────────────
// After 3 consecutive failures, pause iTunes for 10 minutes so we don't spam
// logs on environments where itunes.apple.com is unreachable (e.g. firewalled
// Docker deployments).
let _failCount = 0;
let _disabledUntil = 0;
const FAIL_THRESHOLD = 3;
const DISABLED_TTL_MS = 10 * 60 * 1000;

// ─── Simple in-process cache (5 min TTL) ────────────────────────────────────
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
    return entry.value;
}

function _cacheSet(key, value) {
    if (_cache.size > 500) {
        // Evict oldest 100 entries
        const keys = [..._cache.keys()].slice(0, 100);
        for (const k of keys) _cache.delete(k);
    }
    _cache.set(key, { ts: Date.now(), value });
}

// ─── Core search ─────────────────────────────────────────────────────────────

/**
 * Search iTunes for songs matching `query`.
 * Returns up to `limit` raw iTunes track objects (already normalised).
 *
 * @param {string} query
 * @param {{ limit?: number, country?: string, entity?: string }} opts
 * @returns {Promise<ItunesTrack[]>}
 */
export async function searchItunes(query, { limit = 25, country = 'IN', entity = 'song' } = {}) {
    // Circuit breaker: skip if repeatedly failing
    if (_disabledUntil > Date.now()) return [];

    const cacheKey = `${entity}:${country}:${limit}:${query}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return cached;

    const url = new URL(ITUNES_BASE);
    url.searchParams.set('term', query);
    url.searchParams.set('limit', String(Math.min(limit, 50)));
    url.searchParams.set('country', country);
    url.searchParams.set('entity', entity);
    url.searchParams.set('media', 'music');

    try {
        const { statusCode, body } = await request(url.toString(), {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'User-Agent': 'MusicHubBackend/2.0' },
            bodyTimeout: ITUNES_TIMEOUT_MS,
            headersTimeout: ITUNES_TIMEOUT_MS,
        });

        if (statusCode !== 200) throw new Error(`iTunes HTTP ${statusCode}`);
        const json = await body.json();
        const tracks = (json.results ?? []).map(normaliseItunesTrack);
        _failCount = 0; // reset on success
        _cacheSet(cacheKey, tracks);
        return tracks;
    } catch (err) {
        // iTunes is optional — never block the main search
        const msg = err?.message || err?.code || err?.cause?.message || err?.cause?.code || String(err);
        _failCount++;
        if (_failCount >= FAIL_THRESHOLD) {
            _disabledUntil = Date.now() + DISABLED_TTL_MS;
            console.warn(`[iTunes] disabled for 10 min after ${_failCount} consecutive failures. Last error: ${msg}`);
        } else {
            console.warn(`[iTunes] search failed (${_failCount}/${FAIL_THRESHOLD}):`, msg);
        }
        return [];
    }
}

/**
 * Search iTunes for albums matching `query`.
 */
export async function searchItunesAlbums(query, { limit = 10, country = 'IN' } = {}) {
    return searchItunes(query, { limit, country, entity: 'album' });
}

/**
 * Search iTunes for artists matching `query`.
 */
export async function searchItunesArtists(query, { limit = 10, country = 'IN' } = {}) {
    return searchItunes(query, { limit, country, entity: 'musicArtist' });
}

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ItunesTrack
 * @property {string}  itunesId
 * @property {string}  title
 * @property {string}  artist
 * @property {string}  album
 * @property {string}  genre
 * @property {number}  year           - release year (0 if unknown)
 * @property {number}  durationMs
 * @property {string}  artworkUrl     - 3000×3000 artwork URL
 * @property {string}  artworkUrl300  - 300×300 fallback
 * @property {boolean} isExplicit
 * @property {number}  trackNumber
 * @property {string}  country
 */
function normaliseItunesTrack(raw) {
    const artworkBase = (raw.artworkUrl100 ?? '').replace('100x100bb', '{w}x{h}bb');
    return {
        itunesId:     String(raw.trackId ?? raw.collectionId ?? ''),
        title:        raw.trackName ?? raw.collectionName ?? '',
        artist:       raw.artistName ?? '',
        album:        raw.collectionName ?? '',
        genre:        raw.primaryGenreName ?? '',
        year:         raw.releaseDate ? new Date(raw.releaseDate).getFullYear() : 0,
        durationMs:   raw.trackTimeMillis ?? 0,
        artworkUrl:   artworkBase.replace('{w}x{h}', '3000x3000'),
        artworkUrl300: (raw.artworkUrl100 ?? '').replace('100x100bb', '300x300bb'),
        isExplicit:   raw.trackExplicitness === 'explicit',
        trackNumber:  raw.trackNumber ?? 0,
        country:      raw.country ?? 'USA',
    };
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/**
 * Find the best-matching iTunes track for a JioSaavn song.
 * Returns { track, score } or null if no confident match.
 *
 * @param {object}        saavnSong   - JioSaavn song object
 * @param {ItunesTrack[]} candidates  - iTunes results for the same query
 * @returns {{ track: ItunesTrack, score: number } | null}
 */
export function matchSaavnToItunes(saavnSong, candidates) {
    if (!candidates.length) return null;

    const saavnTitle  = normText(saavnSong?.name ?? saavnSong?.title ?? '');
    const saavnArtist = normText(
        saavnSong?.primaryArtists
        ?? (Array.isArray(saavnSong?.artists?.primary)
            ? saavnSong.artists.primary.map(a => a?.name ?? '').join(' ')
            : '')
        ?? ''
    );
    const saavnAlbum  = normText(
        typeof saavnSong?.album === 'string' ? saavnSong.album :
        (saavnSong?.album?.name ?? '')
    );
    const saavnDurSec = parseInt(saavnSong?.duration ?? 0, 10);

    let best = null;
    let bestScore = -Infinity;

    for (const track of candidates) {
        const itTitle  = normText(track.title);
        const itArtist = normText(track.artist);
        const itAlbum  = normText(track.album);
        const itDurSec = Math.round(track.durationMs / 1000);

        let score = 0;

        // Title similarity (0–60)
        const titleSim = bigramSimilarity(saavnTitle, itTitle);
        score += titleSim * 60;
        if (saavnTitle === itTitle) score += 20; // exact bonus

        // Artist similarity (0–30)
        const artistSim = bigramSimilarity(saavnArtist, itArtist);
        score += artistSim * 30;

        // Album similarity (0–15) — lower weight, albums names vary across regions
        const albumSim = bigramSimilarity(saavnAlbum, itAlbum);
        score += albumSim * 15;

        // Duration match (±10s → full bonus, ±30s → partial)
        if (saavnDurSec > 0 && itDurSec > 0) {
            const diff = Math.abs(saavnDurSec - itDurSec);
            if (diff <= 10) score += 15;
            else if (diff <= 30) score += 8;
            else if (diff > 90) score -= 10; // very different duration = different song
        }

        if (score > bestScore) {
            bestScore = score;
            best = { track, score };
        }
    }

    // Confidence threshold: title must be a reasonable match (sim > 0.4 = 24pts)
    // + at least a weak artist match
    if (!best || best.score < 30) return null;
    return best;
}

/**
 * Enrich a list of JioSaavn songs with matched iTunes metadata.
 * Songs that don't match get `itunesMeta: null`.
 *
 * @param {object[]}      songs      - JioSaavn songs
 * @param {ItunesTrack[]} itunes     - iTunes candidates for the query
 * @returns {object[]}               - songs with `itunesMeta` and `itunesBoost` attached
 */
export function enrichSongsWithItunes(songs, itunes) {
    if (!itunes.length) return songs.map(s => ({ ...s, itunesMeta: null, itunesBoost: 0 }));

    return songs.map(song => {
        const match = matchSaavnToItunes(song, itunes);
        if (!match) return { ...song, itunesMeta: null, itunesBoost: 0 };

        // Boost score based on match confidence (0–25 pts)
        const itunesBoost = Math.min(25, Math.round(match.score / 5));

        return {
            ...song,
            // Prefer iTunes artwork when it's higher quality
            image: [
                { quality: '500x500', url: match.track.artworkUrl300 },
                { quality: '150x150', url: match.track.artworkUrl300 },
            ],
            itunesMeta: {
                id:          match.track.itunesId,
                artwork:     match.track.artworkUrl,
                artwork300:  match.track.artworkUrl300,
                genre:       match.track.genre,
                year:        match.track.year,
                durationMs:  match.track.durationMs,
                isExplicit:  match.track.isExplicit,
                trackNumber: match.track.trackNumber,
                matchScore:  match.score,
            },
            itunesBoost,
        };
    });
}

/**
 * Given iTunes artist/album results, build enriched metadata objects
 * for the search results page.
 */
export function buildItunesArtistMeta(itunesArtists) {
    return (itunesArtists ?? []).map(raw => ({
        itunesId:    raw.itunesId,
        name:        raw.artist ?? raw.title,
        genre:       raw.genre,
        artworkUrl:  raw.artworkUrl,
    }));
}

// Re-export helpers used in route layer
export { normText, bigramSimilarity };
