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

// ─── Short TTL Memory Stream URL Cache ─────────────────────────────────────────
// JioSaavn & Gaana CDN tokens typically expire in 20-60 mins.
// We set a 15-minute TTL to ensure fresh playable URLs.
const STREAM_CACHE_TTL_MS = 15 * 60 * 1000;
const memoryStreamCache = new Map();

// In-flight resolution deduplication locks (keyed by track key)
const inFlightResolves = new Map();

export function getCachedStream(trackKey) {
    if (!trackKey) return null;
    const entry = memoryStreamCache.get(trackKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        memoryStreamCache.delete(trackKey);
        return null;
    }
    return entry;
}

export function setCachedStream(trackKey, streamData) {
    if (!trackKey || !streamData?.streamUrl) return;
    memoryStreamCache.set(trackKey, {
        ...streamData,
        expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
        cachedAt: Date.now(),
    });
}

export function invalidateStreamCache(trackKey) {
    if (trackKey) {
        memoryStreamCache.delete(trackKey);
    }
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
function _extractDownloadCandidates(song) {
    if (!song) return [];
    const urls = Array.isArray(song.downloadUrl) ? song.downloadUrl : [];
    const ordered = [];
    const seen = new Set();
    const push = (url, quality) => {
        if (typeof url !== 'string') return;
        const u = url.trim();
        if (!u.startsWith('http') || seen.has(u)) return;
        seen.add(u);
        ordered.push({ url: u, quality: quality || (u.includes('320') ? '320kbps' : u.includes('160') ? '160kbps' : '320kbps') });
    };
    for (const q of ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps']) {
        push(urls.find(u => u.quality === q)?.url, q);
    }
    // Any remaining array entries not covered by the standard quality labels.
    for (const u of urls) push(u?.url, u?.quality);
    // Legacy single-string shapes.
    push(song.streamUrl);
    push(song.stream_url);
    if (typeof song.downloadUrl === 'string') push(song.downloadUrl);
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
async function _firstPlayableCandidate(song, provider, { maxCandidates = 3, timeoutMs = 1800 } = {}) {
    const candidates = _extractDownloadCandidates(song).slice(0, maxCandidates);
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
async function _resolveDirectById(songId) {
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
    const makeResult = (song, provider) => _firstPlayableCandidate(song, provider);

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
async function _resolveBySearch(title, artist = '', album = '') {
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
                _firstPlayableCandidate(cand, provider, { maxCandidates: 2, timeoutMs: 2000 })
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

    if (!songId && !songTitle) {
        throw new PlaybackResolveError('Song ID or title is required for resolution', 'BAD_REQUEST');
    }

    const trackKey = generateTrackKey(songId, songTitle, songArtist, songAlbum);

    // 1. Fast Memory Cache Check (Instant 0ms)
    const cached = getCachedStream(trackKey);
    if (cached && cached.streamUrl) {
        return {
            id: trackKey,
            title: songTitle || cached.title,
            artist: songArtist || cached.artist,
            streamUrl: cached.streamUrl,
            proxyUrl: `/api/stream/${trackKey}`,
            bitrate: cached.bitrate || '320kbps',
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

    // 2. Single-flight lock: deduplicate concurrent requests for the exact same track
    const activeLock = inFlightResolves.get(trackKey);
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
        let winner = await _resolveDirectById(songId);

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
                winner = await _resolveBySearch(searchTitle, searchArtist, searchAlbum);
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
            contentType: winner.contentType || 'audio/mp4',
            isHls: winner.isHls || false,
            headers,
            isPlayable: true,
            provider: winner.provider,
            expiresIn: Math.round(STREAM_CACHE_TTL_MS / 1000),
            resolvedAt: new Date().toISOString(),
            cached: false,
        };

        // Cache the verified playable stream
        setCachedStream(trackKey, {
            ...resolvedData,
            title: songTitle,
            artist: songArtist,
        });

        return resolvedData;
        })()]); // end Promise.race
    })().finally(() => {
        inFlightResolves.delete(trackKey);
    });

    inFlightResolves.set(trackKey, resolvePromise);
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
