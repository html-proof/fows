/**
 * Canonical playback-source resolver & unified streaming engine.
 *
 * A canonical track is catalog identity. A stream URL is an expiring playback
 * source. This module resolves verified playable stream URLs by querying
 * JioSaavn and Gaana in parallel, testing candidate streams with fast probe
 * validation (HEAD / Range GET), and caching verified URLs with short TTLs.
 */

import {
    getTrack,
    getProviderTrackId,
} from './identityResolver.js';
import { getSongById, searchSongsOnly, requestJsonWithTimeoutExported } from './saavnApi.js';
import { searchSongsDirect, getSongDirect } from './jiosaavnDirect.js';
import { getSongById as getGaanaSongById, searchSongsOnly as searchGaanaSongsOnly } from './gaanaApi.js';
import { bigramSimilarity, normText } from './searchEngine.js';
import { probeStreamUrl, getHeadersForStreamUrl, validatePlayableStream } from './streamValidator.js';

const SAAVN_PROXY_BASE = 'https://saavn.sumit.co';

export class PlaybackResolveError extends Error {
    constructor(message, code = 'UNRESOLVABLE') {
        super(message);
        this.name = 'PlaybackResolveError';
        this.code = code;
    }
}

// ─── Spotify-style data-saver quality tiers ────────────────────────────────────
// Each song's download URL exists at 320/160/96/48/12 kbps. Streaming the top
// bitrate uses ~8 MB for a 3.5-minute song; the lower tiers keep mobile-data
// use in Spotify's ~1-4 MB range. A tier defines the bitrate ladder the resolver
// walks — the FIRST bitrate the CDN actually serves for that tier wins, so an
// unavailable bitrate transparently falls through to the next best one.
//
//   Tier      Target   ~Data / 3.5-min song    (Spotify equivalent)
//   ────────  ───────  ──────────────────────  ────────────────────
//   low        48kbps  ~1.3 MB                 Low
//   normal     96kbps  ~2.5 MB                 Normal   (default)
//   high      160kbps  ~4.2 MB                 High
//   max       320kbps  ~8.4 MB                 Very High
export const QUALITY_LADDERS = {
    low:    ['48kbps', '96kbps', '12kbps', '160kbps', '320kbps'],
    normal: ['96kbps', '160kbps', '48kbps', '320kbps', '12kbps'],
    high:   ['160kbps', '320kbps', '96kbps', '48kbps', '12kbps'],
    max:    ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps'],
};

export const DEFAULT_QUALITY = 'normal';

/**
 * Coerce any client-supplied quality hint into a canonical tier name.
 * Accepts tier names (low/normal/high/max), Spotify-style aliases
 * (data_saver, very_high, auto), or a raw bitrate ('96', '160kbps', 320).
 */
export function normalizeQuality(input) {
    if (input === undefined || input === null || input === '') return DEFAULT_QUALITY;
    const s = String(input).trim().toLowerCase();
    if (QUALITY_LADDERS[s]) return s;
    switch (s) {
        case 'auto':
        case 'automatic':
        case 'standard':
        case 'medium':
            return 'normal';
        case 'data_saver':
        case 'datasaver':
        case 'saver':
        case 'lowest':
        case 'economy':
            return 'low';
        case 'very_high':
        case 'veryhigh':
        case 'highest':
        case 'lossless':
        case 'best':
            return 'max';
    }
    // Raw bitrate hint, e.g. "96", "160kbps", "320"
    const kbps = parseInt(s, 10);
    if (Number.isFinite(kbps)) {
        if (kbps <= 60) return 'low';
        if (kbps <= 128) return 'normal';
        if (kbps <= 224) return 'high';
        return 'max';
    }
    return DEFAULT_QUALITY;
}

// ─── Short TTL Memory Stream URL Cache ─────────────────────────────────────────
// JioSaavn & Gaana CDN tokens typically expire in 20-60 mins.
// We set a 15-minute TTL to ensure fresh playable URLs.
// Cache entries are keyed per quality tier so a "low" request never returns a
// previously cached "max" (320kbps) URL and vice-versa.
const STREAM_CACHE_TTL_MS = 15 * 60 * 1000;
const memoryStreamCache = new Map();

function _cacheKey(trackKey, quality) {
    return `${trackKey}::${normalizeQuality(quality)}`;
}

// In-flight resolution deduplication locks (keyed by track key)
const inFlightResolves = new Map();

export function getCachedStream(trackKey, quality = DEFAULT_QUALITY) {
    if (!trackKey) return null;
    const entry = memoryStreamCache.get(_cacheKey(trackKey, quality));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        memoryStreamCache.delete(_cacheKey(trackKey, quality));
        return null;
    }
    return entry;
}

export function setCachedStream(trackKey, streamData, quality = DEFAULT_QUALITY) {
    if (!trackKey || !streamData?.streamUrl) return;
    memoryStreamCache.set(_cacheKey(trackKey, quality), {
        ...streamData,
        expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
        cachedAt: Date.now(),
    });
}

export function invalidateStreamCache(trackKey, quality) {
    if (!trackKey) return;
    // No tier given → drop every cached tier for this track.
    if (quality === undefined) {
        for (const tier of Object.keys(QUALITY_LADDERS)) {
            memoryStreamCache.delete(_cacheKey(trackKey, tier));
        }
        return;
    }
    memoryStreamCache.delete(_cacheKey(trackKey, quality));
}

export function generateTrackKey(id, title = '', artist = '', album = '') {
    if (id && String(id).trim().length > 0) {
        return String(id).trim();
    }
    const clean = normText(`${title} ${artist} ${album}`);
    let hash = 0;
    for (let i = 0; i < clean.length; i++) {
        hash = (Math.imul(31, hash) + clean.charCodeAt(i)) | 0;
    }
    return `trk_${Math.abs(hash).toString(36)}`;
}

/**
 * Return every playable download URL for a song, ordered best-quality first.
 *
 * JioSaavn download URLs are fabricated by string-swapping the bitrate token
 * (see jiosaavnDirect._buildDownloadUrls), so a `_320`/`_160` URL is NOT
 * guaranteed to exist on the CDN — some tracks only encode lower bitrates.
 * Returning the full ordered list lets the caller probe down the ladder and
 * pick the first bitrate the CDN actually serves, instead of blindly handing
 * the player a 320kbps URL that 404s.
 */
function _labelForUrl(u) {
    if (u.includes('_320') || u.includes('320')) return '320kbps';
    if (u.includes('_160') || u.includes('160')) return '160kbps';
    if (u.includes('_96')  || u.includes('96'))  return '96kbps';
    if (u.includes('_48')  || u.includes('48'))  return '48kbps';
    if (u.includes('_12')  || u.includes('12'))  return '12kbps';
    return '320kbps';
}

function _extractDownloadCandidates(song, quality = DEFAULT_QUALITY) {
    if (!song) return [];
    const urls = Array.isArray(song.downloadUrl) ? song.downloadUrl : [];

    // Collect one URL per available bitrate label.
    const byQuality = new Map();
    const add = (url, q) => {
        if (typeof url !== 'string') return;
        const u = url.trim();
        if (!u.startsWith('http')) return;
        const label = q || _labelForUrl(u);
        if (!byQuality.has(label)) byQuality.set(label, u);
    };
    for (const entry of urls) add(entry?.url, entry?.quality);
    // Legacy single-string shapes.
    add(song.streamUrl);
    add(song.stream_url);
    if (typeof song.downloadUrl === 'string') add(song.downloadUrl);

    // Order by the requested tier's ladder so the target bitrate is probed
    // first and the resolver settles on the lowest-data URL that actually plays.
    const ladder = QUALITY_LADDERS[normalizeQuality(quality)] || QUALITY_LADDERS[DEFAULT_QUALITY];
    const ordered = [];
    const seenUrl = new Set();
    for (const q of ladder) {
        const u = byQuality.get(q);
        if (u && !seenUrl.has(u)) { seenUrl.add(u); ordered.push({ url: u, quality: q }); }
    }
    // Any bitrate labels not covered by the ladder, appended last.
    for (const [q, u] of byQuality) {
        if (!seenUrl.has(u)) { seenUrl.add(u); ordered.push({ url: u, quality: q }); }
    }
    return ordered;
}

/**
 * Walk a song's download candidates best-quality first and return the first
 * one the CDN actually serves (probe-verified 200/206). Restores the module's
 * "verified playable URLs only" guarantee for the direct-by-ID lane, so the
 * 302 fast-path never redirects the player to a dead/404 CDN URL.
 *
 * Bounded to the top few bitrates so cold-start latency stays low: a valid
 * 320kbps hit returns after a single probe RTT.
 */
async function _firstPlayableCandidate(song, provider, { maxCandidates = 3, timeoutMs = 1800, quality = DEFAULT_QUALITY } = {}) {
    const candidates = _extractDownloadCandidates(song, quality).slice(0, maxCandidates);
    for (const c of candidates) {
        const probe = await probeStreamUrl(c.url, { timeoutMs });
        if (probe.isValid) {
            return {
                streamUrl: c.url,
                quality: c.quality,
                contentType: probe.contentType || (c.url.includes('.mp4') ? 'audio/mp4' : 'audio/mpeg'),
                isHls: probe.isHls || c.url.includes('.m3u8'),
                provider,
                song,
            };
        }
    }
    return null;
}

function _songArtist(song) {
    return Array.isArray(song?.artists?.primary)
        ? song.artists.primary.map(a => a.name ?? '').join(' ')
        : (song?.primaryArtists ?? song?.artist ?? '');
}

function _songAlbum(song) {
    return typeof song?.album === 'string'
        ? song.album
        : (song?.album?.name ?? song?.albumName ?? '');
}

function _scoreCandidate(targetTitle, targetArtist, candidate) {
    const candTitle = normText(candidate.name || candidate.title || '');
    const candArtist = normText(_songArtist(candidate));
    const titleSim = bigramSimilarity(normText(targetTitle || ''), candTitle);
    const artistSim = targetArtist ? bigramSimilarity(normText(targetArtist), candArtist) : 0.6;
    let score = titleSim * 0.7 + artistSim * 0.3;
    // Boost direct progressive download candidates (JioSaavn MP4/AAC) for instant universal compatibility
    if (Array.isArray(candidate?.downloadUrl) && candidate.downloadUrl.length > 0) {
        score += 0.20;
    }
    return score;
}

/**
 * Direct parallel lookup for a song on JioSaavn (direct + proxy) and Gaana by ID.
 *
 * Runs three lanes in parallel:
 *   Lane A: JioSaavn direct API (fast when server is in India; may lack encrypted_media_url otherwise)
 *   Lane B: saavn.sumit.co proxy (geo-transparent; returns pre-decrypted CDN URLs)
 *   Lane C: Gaana direct API
 *
 * First lane to return a usable stream wins.
 */
async function _resolveDirectById(songId, quality = DEFAULT_QUALITY) {
    if (!songId) return null;

    let jioId = songId;
    let gaanaId = songId;

    // If songId is a canonical ID (trk_...), look up mapped provider IDs from SQLite
    if (songId.startsWith('trk_')) {
        try {
            const mappedJio = getProviderTrackId(songId, 'jiosaavn');
            if (mappedJio) jioId = mappedJio;
            const mappedGaana = getProviderTrackId(songId, 'gaana');
            if (mappedGaana) gaanaId = mappedGaana;
            if (!mappedJio && !mappedGaana) return null;
        } catch (_) {
            return null;
        }
    }

    // Probe-verify the chosen CDN URL (walking bitrates best→worst) before a
    // lane is allowed to win. Without this, an unverified 320kbps URL that the
    // CDN never encoded 404s straight through the 302 fast-path to the player.
    const makeResult = (song, provider) => _firstPlayableCandidate(song, provider, { quality });

    const lanes = [
        // Lane A: JioSaavn direct API (fastest when running from Indian region)
        (async () => {
            if (!jioId || jioId.startsWith('trk_')) return null;
            const song = await getSongDirect(jioId).catch(() => null);
            return makeResult(song, 'jiosaavn');
        })(),

        // Lane B: saavn.sumit.co proxy — geo-transparent third-party wrapper.
        // Returns pre-decrypted CDN URLs so no DES/encryption step needed here.
        // 5 s timeout: proxy may be cold but is the most reliable non-Indian path.
        (async () => {
            if (!jioId || jioId.startsWith('trk_')) return null;
            try {
                const res = await requestJsonWithTimeoutExported(
                    `${SAAVN_PROXY_BASE}/api/songs/${encodeURIComponent(jioId)}`,
                    { timeoutMs: 5000, label: 'saavn-proxy song' },
                );
                // Proxy may return { data: song } or { data: [song] }
                const song = Array.isArray(res?.data) ? res.data[0] : res?.data;
                return makeResult(song, 'jiosaavn');
            } catch (_) {
                return null;
            }
        })(),

        // Lane C: Gaana direct API
        (async () => {
            if (!gaanaId || gaanaId.startsWith('trk_')) return null;
            const detail = await getGaanaSongById(gaanaId).catch(() => null);
            const song = detail?.data?.[0] || detail?.data;
            return makeResult(song, 'gaana');
        })(),
    ];

    // TRUE RACE: return the first lane that yields a usable progressive (non-HLS)
    // stream the instant it arrives — do NOT wait for the slowest lane's 5s timeout.
    // If no lane produces a non-HLS source, fall back to the first HLS/any result
    // once every lane has settled. This is the single biggest cold-start win:
    // a fast JioSaavn-direct hit (~300ms) is no longer blocked behind the proxy.
    return new Promise((resolve) => {
        let remaining = lanes.length;
        let fallback = null;
        for (const lane of lanes) {
            lane.then((r) => {
                if (r && !r.isHls) {
                    resolve(r);              // best case — return immediately
                } else if (r && !fallback) {
                    fallback = r;            // keep first HLS/any as a fallback
                }
            }).catch(() => {}).finally(() => {
                remaining -= 1;
                if (remaining === 0) resolve(fallback);
            });
        }
    });
}

/**
 * Fallback parallel search across JioSaavn and Gaana for song title + artist.
 */
async function _resolveBySearch(title, artist = '', album = '', quality = DEFAULT_QUALITY) {
    const cleanTitle = title.replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').replace(/[,\-_]/g, ' ').trim();
    const primaryArtist = artist.split(',')[0].split('&')[0].replace(/[,\-_]/g, ' ').trim();

    const queries = [
        [cleanTitle, primaryArtist].filter(Boolean).join(' '),
        cleanTitle,
    ].filter(q => q && q.trim().length > 1);

    for (const query of queries) {
        try {
            const [jioRes, gaanaRes, proxyRes] = await Promise.allSettled([
                searchSongsDirect(query, 3).catch(() => [])
                    .then(async res => {
                        if (Array.isArray(res) && res.length > 0) return res;
                        const fallback = await searchSongsOnly(query, 1).catch(() => null);
                        return fallback?.data?.results || [];
                    }),
                searchGaanaSongsOnly(query, 3).catch(() => []),
                // saavn.sumit.co proxy search — geo-transparent; returns pre-decrypted URLs
                requestJsonWithTimeoutExported(
                    `${SAAVN_PROXY_BASE}/api/search/songs?query=${encodeURIComponent(query)}&limit=3`,
                    { timeoutMs: 5000, label: 'saavn-proxy search' },
                ).then(r => r?.data?.results || []).catch(() => []),
            ]);

            const jioCandidates  = (jioRes.status   === 'fulfilled' && Array.isArray(jioRes.value))   ? jioRes.value   : [];
            const gaanaCandidates = (gaanaRes.status === 'fulfilled' && Array.isArray(gaanaRes.value)) ? gaanaRes.value : [];
            const proxyCandidates = (proxyRes.status === 'fulfilled' && Array.isArray(proxyRes.value)) ? proxyRes.value : [];

            const scoredCandidates = [];
            for (const cand of jioCandidates) {
                const score = _scoreCandidate(title, artist, cand);
                if (score >= 0.45) scoredCandidates.push({ cand, score, provider: 'jiosaavn' });
            }
            for (const cand of gaanaCandidates) {
                const score = _scoreCandidate(title, artist, cand);
                if (score >= 0.45) scoredCandidates.push({ cand, score, provider: 'gaana' });
            }
            // Proxy results already have pre-decrypted URLs — give them a small boost
            for (const cand of proxyCandidates) {
                const score = _scoreCandidate(title, artist, cand);
                if (score >= 0.45) scoredCandidates.push({ cand, score: score + 0.05, provider: 'jiosaavn' });
            }

            // Collect top candidates from each distinct provider so a dead provider doesn't crowd out valid ones
            const topJio   = scoredCandidates.filter(c => c.provider === 'jiosaavn').slice(0, 2);
            const topGaana = scoredCandidates.filter(c => c.provider === 'gaana').slice(0, 2);
            const topCandidates = [...topJio, ...topGaana];

            if (topCandidates.length === 0) continue;

            // Race probes in parallel — return the first valid result (non-HLS preferred).
            // 2000ms timeout: CDN URLs need slightly more time than local probes.
            const probePromises = topCandidates.map(({ cand, provider }) =>
                _firstPlayableCandidate(cand, provider, { maxCandidates: 2, timeoutMs: 2000, quality })
            );

            // Race probes — resolve as soon as the first valid result arrives.
            // Prefer non-HLS (progressive MP4/AAC); fall back to HLS if that's all that's available.
            // This is a true race: we don't wait for slow/failing probes.
            const winner = await Promise.any(
                probePromises.map(p => p.then(r => { if (!r || r.isHls) throw new Error('skip'); return r; }))
            ).catch(() =>
                Promise.any(probePromises.map(p => p.then(r => { if (!r) throw new Error('skip'); return r; })))
                    .catch(() => null)
            );
            if (winner) return winner;
        } catch (_) {}
    }

    return null;
}

/**
 * Unified Stream Resolution Engine
 *
 * Resolves a validated, playable direct audio stream URL with headers.
 * Guaranteed response time under 2.5s when upstream source is active.
 *
 * @param {object} params - { id, title, artist, album, language }
 * @returns {Promise<object>}
 */
export async function resolvePlayableStream(params = {}) {
    const startTime = Date.now();
    const songId = String(params.id || '').trim();
    const songTitle = String(params.title || '').trim();
    const songArtist = String(params.artist || '').trim();
    const songAlbum = String(params.album || '').trim();
    const quality = normalizeQuality(params.quality);

    if (!songId && !songTitle) {
        throw new PlaybackResolveError('Song ID or title is required for resolution', 'BAD_REQUEST');
    }

    const trackKey = generateTrackKey(songId, songTitle, songArtist, songAlbum);
    const lockKey = _cacheKey(trackKey, quality);

    // 1. Fast Memory Cache Check (Instant 0ms) — per quality tier
    const cached = getCachedStream(trackKey, quality);
    if (cached && cached.streamUrl) {
        return {
            id: trackKey,
            title: songTitle || cached.title,
            artist: songArtist || cached.artist,
            streamUrl: cached.streamUrl,
            proxyUrl: `/api/stream/${trackKey}`,
            bitrate: cached.bitrate || '320kbps',
            quality,
            contentType: cached.contentType || 'audio/mp4',
            isHls: cached.isHls || false,
            headers: getHeadersForStreamUrl(cached.streamUrl),
            isPlayable: true,
            provider: cached.provider || 'jiosaavn',
            expiresIn: Math.max(60, Math.round(((cached.expiresAt || 0) - Date.now()) / 1000)),
            resolvedAt: new Date(cached.cachedAt || Date.now()).toISOString(),
            cached: true,
        };
    }

    // 2. Single-flight lock: deduplicate concurrent requests for the same track+tier
    const activeLock = inFlightResolves.get(lockKey);
    if (activeLock) {
        return activeLock;
    }

    const resolvePromise = (async () => {

        // Overall 7s timeout — parallel lanes resolve in 2–5s; 7s catches stragglers
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new PlaybackResolveError(
                `Resolution timed out for "${songTitle || songId}"`, 'TIMEOUT'
            )), 7000)
        );

        return Promise.race([timeoutPromise, (async () => {
        // Step A: Direct lookup by ID if available
        let winner = await _resolveDirectById(songId, quality);

        // Step B: Fallback search if direct lookup gave no playable stream
        if (!winner) {
            let searchTitle = songTitle;
            let searchArtist = songArtist;
            let searchAlbum = songAlbum;

            if (!searchTitle && songId) {
                let dbTrack = null;
                try { dbTrack = getTrack(songId); } catch (_) {}
                if (dbTrack) {
                    searchTitle = dbTrack.title || dbTrack.name || '';
                    searchArtist = dbTrack.artist || '';
                    searchAlbum = dbTrack.album || '';
                }
            }

            if (searchTitle.length > 0 || searchArtist.length > 0) {
                winner = await _resolveBySearch(searchTitle, searchArtist, searchAlbum, quality);
            }
        }

        if (!winner || !winner.streamUrl) {
            console.error(`[StreamResolver] No stream found for "${songTitle || songId}" after ${Date.now() - startTime}ms`);
            throw new PlaybackResolveError(`No playable stream found for "${songTitle || songId}"`, 'STREAM_NOT_FOUND');
        }

        const headers = getHeadersForStreamUrl(winner.streamUrl);
        const resolvedData = {
            id: trackKey,
            title: songTitle,
            artist: songArtist,
            streamUrl: winner.streamUrl,
            proxyUrl: `/api/stream/${trackKey}`,
            bitrate: winner.quality || '320kbps',
            quality,
            contentType: winner.contentType || 'audio/mp4',
            isHls: winner.isHls || false,
            headers,
            isPlayable: true,
            provider: winner.provider,
            expiresIn: Math.round(STREAM_CACHE_TTL_MS / 1000),
            resolvedAt: new Date().toISOString(),
            cached: false,
        };

        // Cache the verified playable stream under its quality tier
        setCachedStream(trackKey, {
            ...resolvedData,
            title: songTitle,
            artist: songArtist,
        }, quality);

        return resolvedData;
        })()]); // end Promise.race
    })().finally(() => {
        inFlightResolves.delete(lockKey);
    });

    inFlightResolves.set(lockKey, resolvePromise);
    return resolvePromise;
}

/**
 * Backward compatibility wrapper for canonical catalog routes (`/v1/catalog/resolve/:id`)
 */
export async function resolveStream(canonicalId, opts = {}) {
    let track;
    try {
        track = opts.overrideTrack || getTrack(canonicalId);
    } catch (_) {
        track = null;
    }
    const resolved = await resolvePlayableStream({
        id: canonicalId,
        title: track?.title ?? opts.overrideTrack?.title ?? '',
        artist: track?.artist_name ?? track?.artist ?? opts.overrideTrack?.artist_name ?? '',
        album: track?.album_name ?? track?.album ?? opts.overrideTrack?.album_name ?? '',
        language: track?.language ?? opts.overrideTrack?.language ?? '',
        quality: opts.quality,
    });

    return {
        url: resolved.streamUrl,
        quality: resolved.bitrate,
        provider: resolved.provider,
        canonicalId,
        confidence: 100,
        validationStatus: 'verified-playable',
        resolvedAt: resolved.resolvedAt,
    };
}

export function evictStream(trackKey) {
    invalidateStreamCache(trackKey);
}
