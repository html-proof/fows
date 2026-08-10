/**
 * iTunes Search API — metadata enrichment provider.
 *
 * iTunes is used ONLY for catalog metadata (title, artist, artwork, genre,
 * duration). It is NEVER used as an audio source.
 *
 * Call discipline:
 *   - Only called for real song/artist/movie queries (never mood/genre/playlist)
 *   - Max 2 high-quality queries per user search (never raw JioSaavn metadata)
 *   - In-flight deduplication: concurrent identical queries share one HTTP call
 *   - Sliding-window circuit breaker: opens when ≥60% of last 10 requests fail
 *   - Single retry on ETIMEDOUT (transient, not a rate-limit signal)
 *   - 429 → 2 min backoff, no retry
 */

import { request } from 'undici';
import { normText, bigramSimilarity } from './searchEngine.js';

const ITUNES_BASE = 'https://itunes.apple.com/search';
const CONNECT_TIMEOUT_MS  = 2000;
const BODY_TIMEOUT_MS     = 3000;

// ─── Cache ────────────────────────────────────────────────────────────────────
const _cache    = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 500;

function _cacheGet(key) {
    const e = _cache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL) { _cache.delete(key); return null; }
    return e.value;
}
function _cacheSet(key, value) {
    if (_cache.size >= CACHE_MAX) {
        for (const k of [..._cache.keys()].slice(0, 50)) _cache.delete(k);
    }
    _cache.set(key, { ts: Date.now(), value });
}

// ─── In-flight deduplication ──────────────────────────────────────────────────
const _inFlight = new Map(); // cacheKey → Promise<ItunesTrack[]>

// ─── Sliding-window circuit breaker ──────────────────────────────────────────
// Tracks last CB_WINDOW outcomes ('ok'|'fail').
// Opens when ≥CB_FAIL_RATE of outcomes are 'fail' AND window is ≥CB_MIN_SAMPLE.
const CB_WINDOW      = 10;
const CB_FAIL_RATE   = 0.6;   // open at 60% failure rate
const CB_MIN_SAMPLE  = 4;     // need at least 4 samples before opening
const CB_COOLDOWN_MS = 5 * 60 * 1000;  // 5 min when circuit opens normally
const CB_429_MS      = 2 * 60 * 1000;  // 2 min backoff on rate-limit

const _cb = {
    outcomes:     [],   // 'ok' | 'fail'
    state:        'HEALTHY',
    openUntil:    0,
    lastError:    null,
    totalSuccess: 0,
    totalFail:    0,
};

function _cbIsOpen() {
    if (_cb.state !== 'OPEN') return false;
    if (Date.now() >= _cb.openUntil) {
        _cb.state = 'DEGRADED';
        _cb.outcomes = [];
        console.info('[iTunes] circuit HALF-OPEN — probing');
        return false;
    }
    return true;
}

function _cbRecord(ok, cooldownMs = CB_COOLDOWN_MS) {
    _cb.outcomes.push(ok ? 'ok' : 'fail');
    if (_cb.outcomes.length > CB_WINDOW) _cb.outcomes.shift();

    if (ok) {
        _cb.totalSuccess++;
        _cb.lastError = null;
        if (_cb.state !== 'HEALTHY') {
            _cb.state = 'HEALTHY';
            console.info('[iTunes] circuit HEALTHY — provider recovered');
        }
        return;
    }

    _cb.totalFail++;
    const fails   = _cb.outcomes.filter(o => o === 'fail').length;
    const rate    = fails / _cb.outcomes.length;
    const enough  = _cb.outcomes.length >= CB_MIN_SAMPLE;

    if (enough && rate >= CB_FAIL_RATE && _cb.state !== 'OPEN') {
        _cb.state     = 'OPEN';
        _cb.openUntil = Date.now() + cooldownMs;
        const mins    = Math.round(cooldownMs / 60000);
        console.warn(
            `[iTunes] circuit OPEN — ${fails}/${_cb.outcomes.length} recent requests failed` +
            ` (${Math.round(rate * 100)}%). Cooldown ${mins} min. Last: ${_cb.lastError}`
        );
    } else if (_cb.state === 'HEALTHY') {
        _cb.state = 'DEGRADED';
    }
}

// ─── Query guards ─────────────────────────────────────────────────────────────

// Words that indicate a mood/genre/playlist query — useless for iTunes catalog search.
const MOOD_WORDS = new Set([
    'songs', 'music', 'hits', 'playlist', 'top', 'best', 'latest', 'trending',
    'popular', 'party', 'chill', 'sad', 'happy', 'romantic', 'workout',
    'evergreen', 'chartbuster', 'classics', 'classic', 'today', 'now',
    'new', 'most', 'played', 'releases', 'Tamil', 'Malayalam', 'Telugu',
    'Hindi', 'Kannada', 'Punjabi', 'Bengali', 'Marathi',
]);
// lowercase version for matching
const _moodLower = new Set([...MOOD_WORDS].map(w => w.toLowerCase()));

/**
 * Returns true if the query is a mood/genre/playlist search that iTunes
 * cannot meaningfully answer (e.g. "tamil party songs", "trending now").
 */
function _isMoodQuery(query) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length > 5) return false; // long queries are probably real song titles
    const moodCount = tokens.filter(t => _moodLower.has(t)).length;
    // Mood if >50% of tokens are mood words
    return moodCount / tokens.length > 0.5;
}

/**
 * Sanitize a query before sending to iTunes:
 *  - Strip parenthetical suffixes "(Original Motion Picture Soundtrack)" etc.
 *  - Remove obvious JioSaavn noise words
 *  - Cap at 5 tokens (iTunes doesn't improve with longer queries)
 */
function _sanitize(query) {
    let q = query
        .replace(/\s*\([^)]{8,}\)/g, '')   // remove long parentheticals
        .replace(/\s*\[[^\]]{8,}\]/g, '')   // remove long bracket groups
        .replace(/\b(instrumental|official|audio|video|full\s+song|hd|4k|lyrics?)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length > 5) q = tokens.slice(0, 5).join(' ');
    return q.trim();
}

// ─── Error classification ─────────────────────────────────────────────────────
function _classify(err, statusCode) {
    if (statusCode === 429) return 'HTTP_429_RATE_LIMITED';
    if (statusCode === 403) return 'HTTP_403_FORBIDDEN';
    if (statusCode >= 500)  return `HTTP_${statusCode}_SERVER_ERROR`;
    if (statusCode >= 400)  return `HTTP_${statusCode}_CLIENT_ERROR`;

    const code = err?.code || err?.cause?.code || '';
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'ETIMEDOUT';
    if (code === 'ECONNREFUSED')  return 'ECONNREFUSED';
    if (code === 'ENOTFOUND')     return 'DNS_FAILURE';
    if (code === 'ECONNRESET')    return 'ECONNRESET';
    if (code.startsWith('UND_'))  return code;

    const msg = err?.message || err?.cause?.message || String(err);
    if (/timeout/i.test(msg)) return 'ETIMEDOUT';
    if (/json/i.test(msg))    return 'INVALID_JSON';
    return `UNKNOWN(${msg.slice(0, 80)})`;
}

// ─── Core HTTP request (single attempt) ──────────────────────────────────────
async function _httpRequest(urlStr) {
    const t0 = Date.now();
    let statusCode = null;

    const resp = await request(urlStr, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'MusicHubBackend/2.0' },
        connectTimeout:  CONNECT_TIMEOUT_MS,
        bodyTimeout:     BODY_TIMEOUT_MS,
        headersTimeout:  CONNECT_TIMEOUT_MS,
    });

    statusCode = resp.statusCode;
    const latency = Date.now() - t0;

    if (statusCode !== 200) {
        await resp.body.text().catch(() => null); // drain body
        const reason = _classify(null, statusCode);
        return { ok: false, statusCode, latency, reason };
    }

    const json = await resp.body.json();
    return { ok: true, statusCode, latency, json };
}

// ─── Fetch with single ETIMEDOUT retry ───────────────────────────────────────
async function _fetch(urlStr, queryLabel) {
    let attempt = 0;
    while (attempt < 2) {
        attempt++;
        try {
            const r = await _httpRequest(urlStr);
            if (!r.ok) {
                const isCooldown = r.statusCode === 429 ? CB_429_MS : CB_COOLDOWN_MS;
                console.warn(
                    `[iTunes] SEARCH FAILED | status=${r.statusCode} | latency=${r.latency}ms` +
                    ` | reason=${r.reason} | query="${queryLabel}"`
                );
                _cb.lastError = r.reason;
                _cbRecord(false, isCooldown);
                return null;
            }
            console.info(
                `[iTunes] HTTP ${r.statusCode} | results=${r.json?.resultCount ?? 0}` +
                ` | latency=${r.latency}ms | query="${queryLabel}"`
            );
            _cbRecord(true);
            return r.json;
        } catch (err) {
            const reason = _classify(err, null);
            const detail = err?.code || err?.cause?.code || err?.message || err?.cause?.message || String(err);
            console.warn(
                `[iTunes] SEARCH FAILED | attempt=${attempt} | latency=${Date.now()}ms` +
                ` | reason=${reason} | detail=${detail} | query="${queryLabel}"`
            );
            _cb.lastError = reason;

            // Retry once on transient connection failures
            if (attempt < 2 && (reason === 'ETIMEDOUT' || reason === 'ECONNRESET')) {
                console.info(`[iTunes] retrying once after ${reason}…`);
                continue;
            }

            _cbRecord(false);
            return null;
        }
    }
    return null;
}

// ─── Public: searchItunes ─────────────────────────────────────────────────────

/**
 * Search iTunes for songs.
 *
 * @param {string} query   - clean song/artist/movie name (NOT raw user input)
 * @param {{ limit?, country?, entity? }} opts
 * @returns {Promise<ItunesTrack[]>}
 */
export async function searchItunes(query, { limit = 25, country = 'IN', entity = 'song' } = {}) {
    const clean = _sanitize(query ?? '');
    if (!clean) return [];

    // Skip mood/genre queries entirely
    if (_isMoodQuery(clean)) {
        console.info(`[iTunes] SKIPPED mood query: "${clean}"`);
        return [];
    }

    // Circuit breaker
    if (_cbIsOpen()) return [];

    const cacheKey = `${entity}:${country}:${limit}:${clean.toLowerCase()}`;

    // Cache hit
    const cached = _cacheGet(cacheKey);
    if (cached !== null) {
        console.info(`[iTunes] CACHE HIT | query="${clean}" | results=${cached.length}`);
        return cached;
    }

    // In-flight dedup: if same query is already running, share the promise
    if (_inFlight.has(cacheKey)) {
        console.info(`[iTunes] IN-FLIGHT DEDUP | query="${clean}"`);
        return _inFlight.get(cacheKey);
    }

    const url = new URL(ITUNES_BASE);
    url.searchParams.set('term',   clean);
    url.searchParams.set('limit',  String(Math.min(limit, 50)));
    url.searchParams.set('country', country);
    url.searchParams.set('entity', entity);
    url.searchParams.set('media',  'music');
    const urlStr = url.toString();

    console.info(`[iTunes] SEARCH START | query="${clean}" | country=${country} | entity=${entity} | limit=${limit}`);

    const promise = _fetch(urlStr, clean).then(json => {
        _inFlight.delete(cacheKey);

        if (!json) {
            _cacheSet(cacheKey, []); // cache failure too (5 min) to avoid hammering
            return [];
        }

        const results = json.results ?? [];
        if (results.length === 0) {
            console.info(`[iTunes] EMPTY RESULTS | query="${clean}" — no catalog match`);
            _cacheSet(cacheKey, []);
            return [];
        }

        const tracks = results.map(_normalise);
        _cacheSet(cacheKey, tracks);
        return tracks;
    }).catch(err => {
        _inFlight.delete(cacheKey);
        console.warn('[iTunes] unexpected error:', err?.message ?? String(err));
        return [];
    });

    _inFlight.set(cacheKey, promise);
    return promise;
}

export async function searchItunesAlbums(query, { limit = 10, country = 'IN' } = {}) {
    return searchItunes(query, { limit, country, entity: 'album' });
}
export async function searchItunesArtists(query, { limit = 10, country = 'IN' } = {}) {
    return searchItunes(query, { limit, country, entity: 'musicArtist' });
}

// ─── Query builder ────────────────────────────────────────────────────────────

/**
 * Build 1–2 targeted iTunes queries from analyzeQuery output.
 * Never passes raw user input or JioSaavn metadata to iTunes.
 *
 * Returns [] for mood/genre queries so the caller skips iTunes entirely.
 *
 * @param {{ cleanTitle, movie, language, isMoodSearch }} analysis
 * @returns {string[]}
 */
export function buildItunesQueries(analysis) {
    const { cleanTitle, movie, isMoodSearch } = analysis;

    // No iTunes for mood/discovery queries
    if (isMoodSearch) return [];
    if (!cleanTitle) return [];

    const title = _sanitize(cleanTitle);
    if (!title || _isMoodQuery(title)) return [];

    const queries = [];

    // Most specific: title + movie (strong for Indian film music)
    if (movie) {
        const movieClean = _sanitize(movie);
        if (movieClean && movieClean.toLowerCase() !== title.toLowerCase()) {
            queries.push(`${title} ${movieClean}`);
        }
    }

    queries.push(title);

    // Deduplicate, cap at 2
    return [...new Set(queries)].slice(0, 2);
}

// ─── Normalisation ────────────────────────────────────────────────────────────

/** @typedef {{ itunesId,title,artist,album,genre,year,durationMs,artworkUrl,artworkUrl300,isExplicit,trackNumber,country }} ItunesTrack */
function _normalise(raw) {
    const base = (raw.artworkUrl100 ?? '').replace('100x100bb', '{w}x{h}bb');
    return {
        itunesId:      String(raw.trackId ?? raw.collectionId ?? ''),
        title:         raw.trackName      ?? raw.collectionName ?? '',
        artist:        raw.artistName     ?? '',
        album:         raw.collectionName ?? '',
        genre:         raw.primaryGenreName ?? '',
        year:          raw.releaseDate ? new Date(raw.releaseDate).getFullYear() : 0,
        durationMs:    raw.trackTimeMillis ?? 0,
        artworkUrl:    base.replace('{w}x{h}', '3000x3000'),
        artworkUrl300: (raw.artworkUrl100 ?? '').replace('100x100bb', '300x300bb'),
        isExplicit:    raw.trackExplicitness === 'explicit',
        trackNumber:   raw.trackNumber ?? 0,
        country:       raw.country ?? 'USA',
    };
}

// ─── Matching ─────────────────────────────────────────────────────────────────

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
        typeof saavnSong?.album === 'string'
            ? saavnSong.album
            : (saavnSong?.album?.name ?? '')
    );
    const saavnDurSec = parseInt(saavnSong?.duration ?? 0, 10);

    let best = null, bestScore = -Infinity;

    for (const track of candidates) {
        const ts = bigramSimilarity(saavnTitle, normText(track.title));
        const as = bigramSimilarity(saavnArtist, normText(track.artist));
        const al = bigramSimilarity(saavnAlbum,  normText(track.album));

        let score = ts * 60 + as * 30 + al * 15;
        if (saavnTitle === normText(track.title)) score += 20;

        if (saavnDurSec > 0 && track.durationMs) {
            const diff = Math.abs(saavnDurSec - track.durationMs / 1000);
            if (diff <= 10)      score += 15;
            else if (diff <= 30) score += 8;
            else if (diff > 90)  score -= 10;
        }

        if (score > bestScore) { bestScore = score; best = { track, score }; }
    }

    return (!best || best.score < 30) ? null : best;
}

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

export function itunesHealthStatus() {
    const recent   = _cb.outcomes.length;
    const fails    = _cb.outcomes.filter(o => o === 'fail').length;
    return {
        state:        _cb.state,
        failRate:     recent ? `${fails}/${recent}` : '0/0',
        lastError:    _cb.lastError,
        openUntil:    _cb.openUntil > Date.now() ? new Date(_cb.openUntil).toISOString() : null,
        totalSuccess: _cb.totalSuccess,
        totalFail:    _cb.totalFail,
    };
}

export { normText, bigramSimilarity };
