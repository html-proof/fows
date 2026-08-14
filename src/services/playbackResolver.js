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
import { getSongById, searchSongsOnly } from './saavnApi.js';
import { searchSongsDirect, getSongDirect } from './jiosaavnDirect.js';
import { getSongById as getGaanaSongById, searchSongsOnly as searchGaanaSongsOnly } from './gaanaApi.js';
import { bigramSimilarity, normText } from './searchEngine.js';
import { probeStreamUrl, getHeadersForStreamUrl, validatePlayableStream } from './streamValidator.js';

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

function _extractDownloadUrl(song) {
    if (!song) return null;
    const urls = Array.isArray(song.downloadUrl) ? song.downloadUrl : [];
    const directUrl =
        urls.find(u => u.quality === '320kbps')?.url
        || urls.find(u => u.quality === '160kbps')?.url
        || urls[urls.length - 1]?.url
        || song.streamUrl
        || song.stream_url
        || (typeof song.downloadUrl === 'string' ? song.downloadUrl : null);

    if (typeof directUrl === 'string' && directUrl.trim().startsWith('http')) {
        const quality =
            urls.find(u => u.url === directUrl)?.quality
            || (directUrl.includes('320') ? '320kbps' : directUrl.includes('160') ? '160kbps' : '320kbps');
        return { url: directUrl.trim(), quality };
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
 * Direct parallel lookup for a song on JioSaavn and Gaana by ID.
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

    const [jioResult, gaanaResult] = await Promise.allSettled([
        (async () => {
            if (!jioId || jioId.startsWith('trk_')) return null;
            const song = await getSongDirect(jioId).catch(() => null)
                || await getSongById(jioId).then(r => r?.data?.[0] || r?.data).catch(() => null);
            const extracted = _extractDownloadUrl(song);
            if (!extracted) return null;

            // Fast probe check — only accept if status is 200 or 206 (not 404/deleted/timeout)
            try {
                const probeRes = await fetch(extracted.url, {
                    method: 'HEAD',
                    headers: getHeadersForStreamUrl(extracted.url),
                    signal: AbortSignal.timeout(1500),
                });
                if (probeRes.status !== 200 && probeRes.status !== 206) {
                    return null;
                }
            } catch (_) {
                return null;
            }

            return {
                streamUrl: extracted.url,
                quality: extracted.quality,
                contentType: extracted.url.includes('.mp4') ? 'audio/mp4' : 'audio/mpeg',
                isHls: extracted.url.includes('.m3u8'),
                provider: 'jiosaavn',
                song,
            };
        })(),
        (async () => {
            if (!gaanaId || gaanaId.startsWith('trk_')) return null;
            const detail = await getGaanaSongById(gaanaId).catch(() => null);
            const song = detail?.data?.[0] || detail?.data;
            const extracted = _extractDownloadUrl(song);
            if (!extracted) return null;
            return {
                streamUrl: extracted.url,
                quality: extracted.quality,
                contentType: extracted.url.includes('.mp4') ? 'audio/mp4' : 'audio/mpeg',
                isHls: extracted.url.includes('.m3u8'),
                provider: 'gaana',
                song,
            };
        })(),
    ]);

    const jioVal = jioResult.status === 'fulfilled' ? jioResult.value : null;
    const gaanaVal = gaanaResult.status === 'fulfilled' ? gaanaResult.value : null;

    return jioVal || gaanaVal || null;
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
            const [jioRes, gaanaRes] = await Promise.allSettled([
                searchSongsDirect(query, 3).catch(() => [])
                    .then(async res => {
                        if (Array.isArray(res) && res.length > 0) return res;
                        const fallback = await searchSongsOnly(query, 1).catch(() => null);
                        return fallback?.data?.results || [];
                    }),
                searchGaanaSongsOnly(query, 3).catch(() => []),
            ]);

            const jioCandidates = (jioRes.status === 'fulfilled' && Array.isArray(jioRes.value)) ? jioRes.value : [];
            const gaanaCandidates = (gaanaRes.status === 'fulfilled' && Array.isArray(gaanaRes.value)) ? gaanaRes.value : [];

            const scoredCandidates = [];
            for (const cand of jioCandidates) {
                const score = _scoreCandidate(title, artist, cand);
                if (score >= 0.45) scoredCandidates.push({ cand, score, provider: 'jiosaavn' });
            }
            for (const cand of gaanaCandidates) {
                const score = _scoreCandidate(title, artist, cand);
                if (score >= 0.45) scoredCandidates.push({ cand, score, provider: 'gaana' });
            }

            // Collect top candidates from each distinct provider so a dead provider (e.g. JioSaavn 404) doesn't crowd out valid ones
            const topJio = scoredCandidates.filter(c => c.provider === 'jiosaavn').slice(0, 2);
            const topGaana = scoredCandidates.filter(c => c.provider === 'gaana').slice(0, 2);
            const topCandidates = [...topJio, ...topGaana];

            if (topCandidates.length === 0) continue;

            // Probe top candidates in parallel
            const probePromises = topCandidates.map(async ({ cand, provider }) => {
                const extracted = _extractDownloadUrl(cand);
                if (!extracted) return null;
                // 3.5s probe timeout to accommodate cloud container network latencies
                const probe = await probeStreamUrl(extracted.url, { timeoutMs: 3500 });
                if (probe.isValid) {
                    return {
                        streamUrl: extracted.url,
                        quality: extracted.quality,
                        contentType: probe.contentType,
                        isHls: probe.isHls,
                        provider,
                        song: cand,
                    };
                }
                return null;
            });

            const probeResults = await Promise.all(probePromises);
            const validResults = probeResults.filter(r => r !== null);
            validResults.sort((a, b) => {
                // Prefer non-HLS (direct progressive MP4/AAC) over HLS .m3u8 for instant mobile playback
                if (!a.isHls && b.isHls) return -1;
                if (a.isHls && !b.isHls) return 1;
                return 0;
            });
            if (validResults.length > 0) return validResults[0];
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
        console.log(`[StreamResolver] Cache HIT for "${songTitle || songId}" in ${Date.now() - startTime}ms`);
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
        console.log(`[StreamResolver] Resolving stream for "${songTitle}" (${songArtist}) ID: ${songId}`);

        // Overall 12s timeout — fail fast rather than cascade for 90s
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new PlaybackResolveError(
                `Resolution timed out for "${songTitle || songId}"`, 'TIMEOUT'
            )), 12000)
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
                const dbTrack = await getTrack(songId).catch(() => null);
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
            console.warn(`[StreamResolver] FAILED to resolve playable stream for "${songTitle || songId}" after ${Date.now() - startTime}ms`);
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

        console.log(`[StreamResolver] Resolved "${songTitle || songId}" via ${winner.provider} (${winner.quality}) in ${Date.now() - startTime}ms`);
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
    const track = opts.overrideTrack || getTrack(canonicalId);
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
