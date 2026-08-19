import { createDecipheriv } from 'crypto';
import { GEO_CLIENT_IP, GAANA_COOKIE } from '../config/headers.js';

// Primary Modern apiv2 stream decryption key (constructed safely to avoid shell variable expansion)
const PRIMARY_KEY = Buffer.from(['g','y','1','t','#','b','@','j','l','(','b','$','w','t','m','e'].join(''), 'utf8');
const PRIMARY_IV = Buffer.from('xC4dmVJAq14BfntX', 'utf8');

// Legacy cyberboysumanjay stream decryption key (for backwards compatibility)
const LEGACY_KEY = Buffer.from(['g','@','1','n','!','(','f','1','#','r','.','0','$',')','&','%'].join(''), 'utf8');
const LEGACY_IV = Buffer.from('asd!@#!@#@!12312', 'utf8');

const HLS_BASE_URL = 'https://vodhlsgaana-ebw.akamaized.net/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/**
 * Extracts seokey or slug from a full Gaana URL or returns clean string
 * E.g. "https://gaana.com/song/chaleya" -> "chaleya"
 * E.g. "https://gaana.com/song/dinkiri-pattalam" -> "dinkiri-pattalam"
 */
export function extractSeokeyFromUrl(input) {
    if (!input || typeof input !== 'string') return '';
    const clean = input.trim();
    if (!clean.includes('/')) return clean;

    try {
        const urlObj = new URL(clean.startsWith('http') ? clean : `https://${clean}`);
        const parts = urlObj.pathname.split('/').filter(Boolean);
        // /song/chaleya -> 'chaleya'
        if (parts.length >= 2 && parts[0] === 'song') {
            return parts[1];
        }
        return parts[parts.length - 1] || clean;
    } catch {
        const match = clean.match(/\/song\/([a-zA-Z0-9-_]+)/);
        if (match && match[1]) return match[1];
        return clean.replace(/^.*[\\\/]/, '');
    }
}

/**
 * Upscales Gaana artwork URLs to high resolution (up to 640x640)
 */
export function fixAlbumArt(url, targetSize = '640x640') {
    if (!url || typeof url !== 'string') return '';
    return url
        .replace(/175x175/g, targetSize)
        .replace(/150x150/g, targetSize)
        .replace(/50x50/g, targetSize);
}

export function decryptStreamPath(encryptedData) {
    if (!encryptedData || typeof encryptedData !== 'string') return '';
    try {
        if (encryptedData.startsWith('http')) return encryptedData;

        const offset = parseInt(encryptedData[0], 10);
        if (isNaN(offset)) return '';

        const ciphertextB64 = encryptedData.substring(offset + 16);
        const ciphertext = Buffer.from(ciphertextB64 + '==', 'base64');

        const decipher = createDecipheriv('aes-128-cbc', PRIMARY_KEY, PRIMARY_IV);
        decipher.setAutoPadding(false);

        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        let rawText = decrypted.toString('utf8').replace(/\0/g, '').trim();
        rawText = rawText
            .split('')
            .filter((c) => {
                const code = c.charCodeAt(0);
                return code >= 32 && code <= 126;
            })
            .join('');

        if (rawText.includes('/hls/')) {
            const pathStart = rawText.indexOf('hls/');
            const cleanPath = rawText.substring(pathStart);
            return HLS_BASE_URL + cleanPath;
        }
        if (rawText.startsWith('http')) return rawText;
        return '';
    } catch (error) {
        return '';
    }
}

// Search fan-out means many concurrent Gaana calls; a stalled one must not
// hold a user request open for the full 8s default.
const SEARCH_REQUEST_TIMEOUT_MS = 2500;
// Detail hydration is the expensive part of a Gaana search: one songDetail
// request per hit, plus one stream-url request on top. Fan those out without a
// cap and a single search turns into ~80 HTTP calls, which is what made search
// slow enough to time out into "no results".
const SEARCH_DETAIL_CONCURRENCY = 6;
// Same reasoning as the JioSaavn client: overlapping lanes ask for the same
// query concurrently, so collapse those onto a single upstream search.
const SEARCH_DEDUPE_TTL_MS = 30_000;
const searchInFlight = new Map();
const searchMicroCache = new Map();

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function _mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length).fill(null);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            try {
                results[index] = await worker(items[index], index);
            } catch {
                results[index] = null;
            }
        }
    });

    await Promise.all(runners);
    return results;
}

async function fetchFromGaana(url, method = 'GET', body = null, options = {}) {
    const headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8,ml;q=0.7',
        'Origin': 'https://gaana.com',
        'Referer': 'https://gaana.com/',
        'X-Forwarded-For': GEO_CLIENT_IP,
        'Client-IP': GEO_CLIENT_IP,
        'Cookie': GAANA_COOKIE,
    };

    if (body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const res = await fetch(url, {
        method,
        headers,
        body: body ? body.toString() : undefined,
        signal: AbortSignal.timeout(
            Number.isFinite(options?.timeoutMs) ? options.timeoutMs : 8000
        ),
    });

    if (!res.ok) {
        throw new Error(`Gaana API returned status code ${res.status}`);
    }

    return res.json();
}

function _normalise(raw, id) {
    if (!raw) return null;
    
    const seokey = raw.seokey ?? id ?? '';
    if (!seokey) return null;

    const trackId = raw.track_id ?? raw.id ?? '';
    const name = raw.track_title ?? raw.title ?? '';
    const albumName = raw.album_title ?? raw.album_name ?? '';
    
    const artistsArr = Array.isArray(raw.artist) ? raw.artist : [];
    const primaryArtists = artistsArr.map(a => a.name).join(', ');
    const artistsObj = {
        primary: artistsArr.map(a => ({ id: a.e_id || null, name: a.name }))
    };

    const rawArt = raw.artwork_large || raw.artwork_web || raw.artwork || '';
    const highResArt = fixAlbumArt(rawArt, '640x640');

    const image = [
        { quality: '50x50', url: raw.artwork ?? '' },
        { quality: '150x150', url: raw.artwork_web ?? '' },
        { quality: '500x500', url: raw.artwork_large ?? '' },
        { quality: '640x640', url: highResArt }
    ].filter(i => i.url);

    return {
        id: String(seokey),
        provider: 'gaana',
        providerTrackId: String(trackId),
        seokey: String(seokey),
        name,
        title: name,
        primaryArtists,
        artists: artistsObj,
        album: { id: String(raw.album_id ?? ''), name: albumName },
        albumId: String(raw.album_id ?? ''),
        duration: String(raw.duration ?? ''),
        language: raw.language ?? '',
        year: raw.released ? String(raw.released).slice(-4) : '',
        label: '',
        image,
        artwork_max: highResArt,
        downloadUrl: []
    };
}

async function _getStream(trackId) {
    if (!trackId) return null;
    try {
        const streamUrlEndpoint = 'https://gaana.com/api/stream-url';
        const streamParams = new URLSearchParams({
            quality: 'high',
            track_id: trackId,
            stream_format: 'mp4'
        });

        const streamResponse = await fetchFromGaana(streamUrlEndpoint, 'POST', streamParams);
        if (streamResponse.api_status === 'success' && streamResponse.data?.stream_path) {
            return decryptStreamPath(streamResponse.data.stream_path);
        }
    } catch (_) {}
    return null;
}

export async function getSongById(idOrUrl) {
    const seokey = extractSeokeyFromUrl(idOrUrl);
    if (!seokey) return { success: false, data: [] };

    try {
        const songDetailUrl = `https://gaana.com/apiv2?type=songDetail&seokey=${encodeURIComponent(seokey)}`;
        const songDetails = await fetchFromGaana(songDetailUrl, 'POST');

        if (songDetails.tracks && songDetails.tracks.length > 0) {
            const normalized = _normalise(songDetails.tracks[0], seokey);
            if (normalized) {
                const streamUrl = await _getStream(normalized.providerTrackId);
                if (streamUrl) {
                    normalized.downloadUrl = [
                        { quality: '320kbps', url: streamUrl },
                        { quality: '160kbps', url: streamUrl },
                        { quality: '96kbps', url: streamUrl }
                    ];
                }
                return { success: true, data: [normalized] };
            }
        }
    } catch (_) {}
    return { success: false, data: [] };
}

/**
 * cyberboysumanjay-style direct URL resolver
 * Returns formatted metadata and playable stream URL from any Gaana link
 */
export async function getSongFromUrl(url) {
    const res = await getSongById(url);
    if (!res.success || !res.data?.length) {
        return { success: false, error: 'Song not found' };
    }

    const song = res.data[0];
    const streamUrl = song.downloadUrl?.[0]?.url ?? '';

    return {
        success: true,
        data: {
            song_title: song.title,
            artist_name: song.primaryArtists,
            album_name: song.album?.name ?? '',
            album_art: song.artwork_max || song.image?.[0]?.url || '',
            duration: parseInt(song.duration, 10) || 0,
            language: song.language,
            year: song.year,
            bitrate: '320 kbps',
            track_id: song.providerTrackId,
            seokey: song.seokey,
            stream_url: streamUrl,
            has_stream: !!streamUrl,
            raw: song
        }
    };
}

/**
 * @param {object} [options]
 * @param {number} [options.timeoutMs]    per-request budget
 * @param {boolean} [options.withStreams] fetch a playable URL per hit (default
 *   true for playback callers; search callers should pass false)
 */
export async function searchSongsOnly(query, limit = 20, options = {}) {
    const cacheKey = `${String(query ?? '').toLowerCase()}|${limit}|${options?.withStreams !== false}`;

    const cached = searchMicroCache.get(cacheKey);
    if (cached && Date.now() - cached.storedAt <= SEARCH_DEDUPE_TTL_MS) return cached.songs;
    if (cached) searchMicroCache.delete(cacheKey);

    const inFlight = searchInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = _searchSongsOnlyUncached(query, limit, options)
        .then((songs) => {
            if (Array.isArray(songs) && songs.length > 0) {
                searchMicroCache.set(cacheKey, { storedAt: Date.now(), songs });
                while (searchMicroCache.size > 200) {
                    const oldest = searchMicroCache.keys().next().value;
                    if (oldest === undefined) break;
                    searchMicroCache.delete(oldest);
                }
            }
            return songs;
        });

    searchInFlight.set(cacheKey, promise);
    promise.catch(() => {}).finally(() => searchInFlight.delete(cacheKey));

    return promise;
}

async function _searchSongsOnlyUncached(query, limit, options) {
    const withStreams = options?.withStreams !== false;
    const detailTimeoutMs = Number.isFinite(options?.timeoutMs)
        ? options.timeoutMs
        : SEARCH_REQUEST_TIMEOUT_MS;
    try {
        const cleanQuery = String(query || '')
            .replace(/[,\-_&]/g, ' ')
            .replace(/\(.*?\)/g, '')
            .replace(/\[.*?\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleanQuery) return [];
        const searchUrl = `https://gaana.com/apiv2?type=search&keyword=${encodeURIComponent(cleanQuery)}`;
        const searchResult = await fetchFromGaana(searchUrl, 'POST', null, { timeoutMs: detailTimeoutMs });

        const gr = searchResult.gr ?? [];
        if (!gr.length) return [];

        const trackSeokeys = [];
        for (const group of gr) {
            for (const item of (group.gd || [])) {
                if (item.seo && !trackSeokeys.includes(item.seo)) {
                    trackSeokeys.push(item.seo);
                    if (trackSeokeys.length >= limit) break;
                }
            }
            if (trackSeokeys.length >= limit) break;
        }

        if (trackSeokeys.length === 0) return [];

        // Hydrate details with bounded concurrency. Callers that only need
        // metadata (search/browse) skip the per-track stream lookup entirely —
        // playback resolves Gaana streams by track id later, so fetching them
        // here doubled the request count for URLs nobody read.
        const songs = await _mapWithConcurrency(trackSeokeys, SEARCH_DETAIL_CONCURRENCY, async (seokey) => {
            const songDetailUrl = `https://gaana.com/apiv2?type=songDetail&seokey=${encodeURIComponent(seokey)}`;
            const detailResult = await fetchFromGaana(songDetailUrl, 'POST', null, { timeoutMs: detailTimeoutMs });
            if (!detailResult.tracks?.length) return null;

            const normalized = _normalise(detailResult.tracks[0], seokey);
            if (!normalized) return null;

            if (withStreams) {
                const streamUrl = await _getStream(normalized.providerTrackId);
                if (streamUrl) {
                    normalized.downloadUrl = [
                        { quality: '320kbps', url: streamUrl },
                        { quality: '160kbps', url: streamUrl },
                        { quality: '96kbps', url: streamUrl }
                    ];
                }
            }
            return normalized;
        });

        return songs.filter(Boolean);
    } catch (_) {
        return [];
    }
}

export async function resolveSongStream(song) {
    const trackId = String(song?.providerTrackId ?? song?.track_id ?? song?.id ?? '').trim();
    const streamUrl = await _getStream(trackId);
    if (!streamUrl) return null;
    return { quality: '320kbps', url: streamUrl };
}

export default {
    getSongById,
    getSongFromUrl,
    extractSeokeyFromUrl,
    fixAlbumArt,
    searchSongsOnly,
    resolveSongStream,
};
