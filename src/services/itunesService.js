/**
 * iTunes Search API — metadata enrichment provider.
 *
 * iTunes is used ONLY for catalog metadata (title, artist, artwork, genre,
 * duration, ISRC). It is never used as an audio source. All playback goes
 * through JioSaavn or other licensed providers.
 *
 * Design principles:
 *  - iTunes is additive. If it fails, search still works via JioSaavn.
 *  - Circuit breaker: after FAIL_THRESHOLD consecutive failures, skip iTunes
 *    for COOLDOWN_MS to avoid hammering a blocked/rate-limited endpoint.
 *  - 429 handling: back off immediately, don't retry, serve from cache.
 *  - 1–2 high-quality queries per user search, never a fan-out of 5+.
 *  - Cache all successful responses (5 min TTL).
 *  - Structured logs: every outcome is classified and logged consistently.
 */

import { request } from 'undici';
import { normText, bigramSimilarity } from './searchEngine.js';

const ITUNES_BASE = 'https://itunes.apple.com/search';

// ─── Timeouts ─────────────────────────────────────────────────────────────────
const CONNECT_TIMEOUT_MS = 3000;
const BODY_TIMEOUT_MS    = 4000;

// ─── Cache (5 min TTL, max 500 entries) ──────────────────────────────────────
const _cache = new Map();
const CACHE_TTL_MS  = 5 * 60 * 1000;
const CACHE_MAX     = 500;

function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
    return entry.value;
}

function _cacheSet(key, value) {
    if (_cache.size >= CACHE_MAX) {
        // evict oldest 10%
        const evict = [..._cache.keys()].slice(0, Math.ceil(CACHE_MAX * 0.1));
        for (const k of evict) _cache.delete(k);
    }
    _cache.set(key, { ts: Date.now(), value });
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────
const FAIL_THRESHOLD  = 3;
const COOLDOWN_MS     = 10 * 60 * 1000;  // 10 min
const RATE_LIMIT_BACKOFF_MS = 60 * 1000; // 1 min on 429

const _cb = {
    state:        'HEALTHY',   // HEALTHY | DEGRADED | OPEN
    failCount:    0,
    openUntil:    0,
    lastError:    null,
    successCount: 0,
};

function _cbIsOpen() {
    if (_cb.state === 'OPEN') {
        if (Date.now() < _cb.openUntil) return true;
        // cooldown expired — move to DEGRADED and allow one probe
        _cb.state     = 'DEGRADED';
        _cb.failCount = 0;
        console.info('[iTunes] circuit HALF-OPEN — probing');
    }
    return false;
}

function _cbOnSuccess() {
    _cb.failCount    = 0;
    _cb.successCount++;
    _cb.lastError    = null;
    if (_cb.state !== 'HEALTHY') {
        _cb.state = 'HEALTHY';
        console.info('[iTunes] circuit CLOSED — provider healthy again');
    }
}

function _cbOnFailure(reason, extraMs = COOLDOWN_MS) {
    _cb.failCount++;
    _cb.lastError = reason;
    if (_cb.failCount >= FAIL_THRESHOLD) {
        _cb.state     = 'OPEN';
        _cb.openUntil = Date.now() + extraMs;
        console.warn(
            `[iTunes] circuit OPEN — disabled for ${Math.round(extraMs / 60000)} min` +
            ` after ${_cb.failCount} failures. Last: ${reason}`
        );
    } else {
        _cb.state = 'DEGRADED';
    }
}

// ─── Error classification ─────────────────────────────────────────────────────
function _classifyError(err, statusCode) {
    if (statusCode === 429) return 'HTTP_429_RATE_LIMITED';
    if (statusCode === 403) return 'HTTP_403_FORBIDDEN';
    if (statusCode === 404) return 'HTTP_404_NOT_FOUND';
    if (statusCode >= 500)  return `HTTP_${statusCode}_SERVER_ERROR`;
    if (statusCode >= 400)  return `HTTP_${statusCode}_CLIENT_ERROR`;

    const code = err?.code || err?.cause?.code || '';
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'TIMEOUT';
    if (code === 'ECONNREFUSED')  return 'NETWORK_CONNECTION_REFUSED';
    if (code === 'ENOTFOUND')     return 'NETWORK_DNS_FAILURE';
    if (code === 'ECONNRESET')    return 'NETWORK_CONNECTION_RESET';
    if (code.startsWith('UND_'))  return `NETWORK_${code}`;

    const msg = err?.message || err?.cause?.message || String(err);
    if (/json/i.test(msg))    return 'INVALID_JSON';
    if (/timeout/i.test(msg)) return 'TIMEOUT';
    if (/abort/i.test(msg))   return 'ABORTED';
    return `UNKNOWN(${msg.slice(0, 60)})`;
}

// ─── Core HTTP request ────────────────────────────────────────────────────────

async function _itunesRequest(params) {
    const url = new URL(ITUNES_BASE);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const urlStr = url.toString();
    const startedAt = Date.now();

    let statusCode = null;
    let rawBody    = null;

    try {
        const resp = await request(urlStr, {
            method: 'GET',
            headers: {
                'Accept':     'application/json',
                'User-Agent': 'MusicHubBackend/2.0',
            },
            connectTimeout:  CONNECT_TIMEOUT_MS,
            bodyTimeout:     BODY_TIMEOUT_MS,
            headersTimeout:  CONNECT_TIMEOUT_MS,
        });

        statusCode = resp.statusCode;
        const latency = Date.now() - startedAt;

        if (statusCode === 429) {
            rawBody = await resp.body.text().catch(() => '');
            const errType = 'HTTP_429_RATE_LIMITED';
            console.warn(`[iTunes] SEARCH FAILED | status=${statusCode} | latency=${latency}ms | reason=${errType} | action=cooldown`);
            _cbOnFailure(errType, RATE_LIMIT_BACKOFF_MS);
            return null;
        }

        if (statusCode !== 200) {
            rawBody = await resp.body.text().catch(() => '');
            const errType = _classifyError(null, statusCode);
            console.warn(`[iTunes] SEARCH FAILED | url=${urlStr} | status=${statusCode} | latency=${latency}ms | reason=${errType}`);
            _cbOnFailure(errType);
            return null;
        }

        let json;
        try {
            json = await resp.body.json();
        } catch (jsonErr) {
            const errType = 'INVALID_JSON';
            console.warn(`[iTunes] SEARCH FAILED | url=${urlStr} | status=${statusCode} | latency=${latency}ms | reason=${errType}`);
            _cbOnFailure(errType);
            return null;
        }

        const count = json?.resultCount ?? (json?.results?.length ?? 0);
        console.info(`[iTunes] HTTP ${statusCode} | results=${count} | latency=${latency}ms | query="${params.term}"`);

        _cbOnSuccess();
        return json;

    } catch (err) {
        const latency  = Date.now() - startedAt;
        const errType  = _classifyError(err, statusCode);
        const detail   = err?.code || err?.cause?.code || err?.message || err?.cause?.message || String(err);
        console.warn(`[iTunes] SEARCH FAILED | url=${urlStr} | latency=${latency}ms | reason=${errType} | detail=${detail}`);
        _cbOnFailure(errType);
        return null;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search iTunes for songs.
 * Constructs a clean, targeted query rather than passing raw user input.
 *
 * @param {string} query        - already-cleaned title (from analyzeQuery.cleanTitle)
 * @param {{ limit?, country?, entity? }} opts
 * @returns {Promise<ItunesTrack[]>}
 */
export async function searchItunes(query, { limit = 25, country = 'IN', entity = 'song' } = {}) {
    if (!query?.trim()) return [];
    if (_cbIsOpen()) return [];

    const cacheKey = `${entity}:${country}:${limit}:${query.trim().toLowerCase()}`;
    const cached   = _cacheGet(cacheKey);
    if (cached) {
        console.info(`[iTunes] CACHE HIT | query="${query}" | results=${cached.length}`);
        return cached;
    }

    console.info(`[iTunes] SEARCH START | query="${query}" | country=${country} | entity=${entity} | limit=${limit}`);

    const json = await _itunesRequest({
        term:    query.trim(),
        limit:   Math.min(limit, 50),
        country,
        entity,
        media:   'music',
    });

    if (!json) return [];

    const results = json.results ?? [];
    if (results.length === 0) {
        console.info(`[iTunes] EMPTY RESULTS | query="${query}" — not an error, no match in iTunes catalog`);
        // Cache empty too (avoid hammering for same query)
        _cacheSet(cacheKey, []);
        return [];
    }

    const tracks = results.map(normaliseItunesTrack);
    _cacheSet(cacheKey, tracks);
    return tracks;
}

export async function searchItunesAlbums(query, { limit = 10, country = 'IN' } = {}) {
    return searchItunes(query, { limit, country, entity: 'album' });
}

export async function searchItunesArtists(query, { limit = 10, country = 'IN' } = {}) {
    return searchItunes(query, { limit, country, entity: 'musicArtist' });
}

/**
 * Build the best 1–2 iTunes search queries for a given query analysis.
 * Never fan out to 5+ queries — Apple rate-limits at ~20 req/min.
 *
 * @param {{ cleanTitle, artist?, movie?, language? }} analysis
 * @returns {string[]}  ordered list of queries (most specific first)
 */
export function buildItunesQueries(analysis) {
    const { cleanTitle, movie, language } = analysis;
    const queries = [];

    // Most specific: title + movie (strong signal for Indian film music)
    if (movie && cleanTitle && movie.toLowerCase() !== cleanTitle.toLowerCase()) {
        queries.push(`${cleanTitle} ${movie}`);
    }

    // Title alone (always include)
    if (cleanTitle) queries.push(cleanTitle);

    // Cap at 2 to stay comfortably under rate limit
    return [...new Set(queries)].slice(0, 2);
}

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ItunesTrack
 * @property {string}  itunesId
 * @property {string}  title
 * @property {string}  artist
 * @property {string}  album
 * @property {string}  genre
 * @property {number}  year
 * @property {number}  durationMs
 * @property {string}  artworkUrl      - 3000×3000
 * @property {string}  artworkUrl300   - 300×300
 * @property {boolean} isExplicit
 * @property {number}  trackNumber
 * @property {string}  country
 */
function normaliseItunesTrack(raw) {
    const artworkBase = (raw.artworkUrl100 ?? '').replace('100x100bb', '{w}x{h}bb');
    return {
        itunesId:      String(raw.trackId ?? raw.collectionId ?? ''),
        title:         raw.trackName      ?? raw.collectionName ?? '',
        artist:        raw.artistName     ?? '',
        album:         raw.collectionName ?? '',
        genre:         raw.primaryGenreName ?? '',
        year:          raw.releaseDate ? new Date(raw.releaseDate).getFullYear() : 0,
        durationMs:    raw.trackTimeMillis ?? 0,
        artworkUrl:    artworkBase.replace('{w}x{h}', '3000x3000'),
        artworkUrl300: (raw.artworkUrl100 ?? '').replace('100x100bb', '300x300bb'),
        isExplicit:    raw.trackExplicitness === 'explicit',
        trackNumber:   raw.trackNumber ?? 0,
        country:       raw.country ?? 'USA',
    };
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/**
 * Find the best-matching iTunes track for a JioSaavn song.
 * Returns { track, score } or null if no confident match.
 */
export function matchSaavnToItunes(saavnSong, candidates) {
    if (!candidates?.length) return null;

    const saavnTitle  = normText(saavnSong?.name ?? saavnSong?.title ?? '');
    const saavnArtist = normText(
        saavnSong?.primaryArtists
        ?? (Array.isArray(saavnSong?.artists?.primary)
            ? saavnSong.artists.primary.map(a => a?.name ?? '').join(' ')
            : '')
        ?? ''
    );
    const saavnAlbum  = normText(
        typeof saavnSong?.album === 'string' ? saavnSong.album
        : (saavnSong?.album?.name ?? '')
    );
    const saavnDurSec = parseInt(saavnSong?.duration ?? 0, 10);

    let best = null, bestScore = -Infinity;

    for (const track of candidates) {
        const itTitle  = normText(track.title);
        const itArtist = normText(track.artist);
        const itAlbum  = normText(track.album);
        const itDurSec = Math.round(track.durationMs / 1000);

        let score = 0;

        const titleSim = bigramSimilarity(saavnTitle, itTitle);
        score += titleSim * 60;
        if (saavnTitle === itTitle) score += 20;

        const artistSim = bigramSimilarity(saavnArtist, itArtist);
        score += artistSim * 30;

        const albumSim = bigramSimilarity(saavnAlbum, itAlbum);
        score += albumSim * 15;

        if (saavnDurSec > 0 && itDurSec > 0) {
            const diff = Math.abs(saavnDurSec - itDurSec);
            if (diff <= 10)      score += 15;
            else if (diff <= 30) score += 8;
            else if (diff > 90)  score -= 10;
        }

        if (score > bestScore) { bestScore = score; best = { track, score }; }
    }

    return (!best || best.score < 30) ? null : best;
}

/**
 * Enrich a list of JioSaavn songs with iTunes metadata.
 * Songs without a confident match get itunesMeta: null.
 */
export function enrichSongsWithItunes(songs, itunes) {
    if (!itunes?.length) return songs.map(s => ({ ...s, itunesMeta: null, itunesBoost: 0 }));

    return songs.map(song => {
        const match = matchSaavnToItunes(song, itunes);
        if (!match) return { ...song, itunesMeta: null, itunesBoost: 0 };

        const itunesBoost = Math.min(25, Math.round(match.score / 5));
        return {
            ...song,
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

export function buildItunesArtistMeta(itunesArtists) {
    return (itunesArtists ?? []).map(raw => ({
        itunesId:   raw.itunesId,
        name:       raw.artist ?? raw.title,
        genre:      raw.genre,
        artworkUrl: raw.artworkUrl,
    }));
}

/** Circuit breaker status — useful for a /healthz endpoint. */
export function itunesHealthStatus() {
    return {
        state:        _cb.state,
        failCount:    _cb.failCount,
        successCount: _cb.successCount,
        lastError:    _cb.lastError,
        openUntil:    _cb.openUntil > Date.now() ? new Date(_cb.openUntil).toISOString() : null,
    };
}

export { normText, bigramSimilarity };
