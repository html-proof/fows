import express from 'express';
import { request } from 'undici';
import { getSongDirect, searchSongsDirect } from '../services/jiosaavnDirect.js';
import { getSongById as getSaavnSongById, searchSongsOnly as searchSaavnSongsOnly } from '../services/saavnApi.js';
import { getSongById as getGaanaSongById, searchSongsOnly as searchGaanaSongsOnly } from '../services/gaanaApi.js';
import { normText, bigramSimilarity } from '../services/searchEngine.js';
import { getSpoofedHeaders } from '../middleware/spoofHeaders.js';

const router = express.Router();

// Memory cache for resolved stream URLs to avoid re-resolving on every chunk request
const resolvedUrlCache = new Map();
const URL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCachedUrl(songId) {
    const entry = resolvedUrlCache.get(songId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        resolvedUrlCache.delete(songId);
        return null;
    }
    return entry.url;
}

function setCachedUrl(songId, url) {
    resolvedUrlCache.set(songId, {
        url,
        expiresAt: Date.now() + URL_CACHE_TTL_MS,
    });
}

function _extractDownloadUrl(song) {
    if (!song) return null;
    const urls = Array.isArray(song.downloadUrl) ? song.downloadUrl : [];
    return urls.find(u => u.quality === '320kbps')?.url
        || urls.find(u => u.quality === '160kbps')?.url
        || urls[urls.length - 1]?.url
        || song.streamUrl
        || song.stream_url
        || null;
}

/**
 * Validate that an upstream URL is active, returns HTTP 200/206, and has an audio/stream content-type.
 */
async function validateStreamUrl(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        return false;
    }
    try {
        const outboundHeaders = getSpoofedHeaders('stream', {
            'Range': 'bytes=0-1023',
        });
        const res = await request(url, {
            method: 'GET',
            headers: outboundHeaders,
            headersTimeout: 4000,
            bodyTimeout: 4000,
        });

        const status = res.statusCode;
        const contentType = (res.headers['content-type'] ?? '').toLowerCase();

        // Valid if 200/206 and content-type is audio, mp4, or hls
        const isValidStatus = status === 200 || status === 206;
        const isValidContentType =
            contentType.startsWith('audio/') ||
            contentType.startsWith('video/mp4') ||
            contentType.includes('mp4') ||
            contentType.includes('mpeg') ||
            contentType.includes('x-mpegurl') ||
            contentType.includes('vnd.apple.mpegurl') ||
            contentType.includes('octet-stream');

        await res.body.dump();
        return isValidStatus && isValidContentType;
    } catch {
        return false;
    }
}

/**
 * Resolve the upstream playable audio URL from JioSaavn or Gaana.
 */
async function resolveUpstreamAudioUrl(songId, queryHint = '', songTitle = '', songArtist = '') {
    // 1. Check memory cache first
    const cached = getCachedUrl(songId);
    if (cached) return cached;

    let searchHint = (queryHint || '').trim();

    // 2. Direct JioSaavn lookup by ID
    try {
        const jioSong = await getSongDirect(songId).catch(() => null)
            || await getSaavnSongById(songId).then(r => r?.data?.[0]).catch(() => null);
        if (jioSong) {
            if (!searchHint) {
                searchHint = [jioSong.name || jioSong.title, jioSong.primaryArtists || jioSong.artist].filter(Boolean).join(' ');
            }
            const jioUrl = _extractDownloadUrl(jioSong);
            if (jioUrl && await validateStreamUrl(jioUrl)) {
                setCachedUrl(songId, jioUrl);
                return jioUrl;
            }
        }
    } catch (_) {}

    // 3. Direct Gaana lookup by ID
    try {
        const gaanaDetail = await getGaanaSongById(songId).catch(() => null);
        const gaanaSong = gaanaDetail?.data?.[0];
        if (gaanaSong) {
            if (!searchHint) {
                searchHint = [gaanaSong.name || gaanaSong.title, gaanaSong.primaryArtists || gaanaSong.artist].filter(Boolean).join(' ');
            }
            const gaanaUrl = _extractDownloadUrl(gaanaSong);
            if (gaanaUrl && await validateStreamUrl(gaanaUrl)) {
                setCachedUrl(songId, gaanaUrl);
                return gaanaUrl;
            }
        }
    } catch (_) {}

    // 4. Fallback parallel search on JioSaavn and Gaana
    const searchTarget = [songTitle, songArtist, searchHint, songId.replace(/[-_]/g, ' ')].filter(Boolean)[0] || '';
    if (searchTarget.length > 1) {
        try {
            const [jioResults, gaanaResults] = await Promise.allSettled([
                searchSongsDirect(searchTarget, 5),
                searchGaanaSongsOnly(searchTarget, 5),
            ]);

            const jioSongs = jioResults.status === 'fulfilled' && Array.isArray(jioResults.value) ? jioResults.value : [];
            const gaanaSongs = gaanaResults.status === 'fulfilled' && Array.isArray(gaanaResults.value) ? gaanaResults.value : [];

            for (const cand of [...gaanaSongs, ...jioSongs]) {
                const candUrl = _extractDownloadUrl(cand);
                if (candUrl && await validateStreamUrl(candUrl)) {
                    setCachedUrl(songId, candUrl);
                    return candUrl;
                }
            }
        } catch (_) {}
    }

    return null;
}

/**
 * Stream proxy handler supporting byte-range requests (GET /stream/:songId)
 */
async function handleStreamRequest(req, res) {
    const songId = req.params.songId;
    const queryHint = req.query.title || req.query.q || '';
    const songTitle = req.query.title || '';
    const songArtist = req.query.artist || '';

    if (!songId) {
        return res.status(400).json({ error: 'Song ID is required' });
    }

    // 1. Resolve real audio URL from JioSaavn / Gaana with validation
    const realAudioUrl = await resolveUpstreamAudioUrl(songId, queryHint, songTitle, songArtist);
    if (!realAudioUrl) {
        return res.status(404).json({
            error: 'Unable to resolve playable audio stream for this song',
            code: 'STREAM_NOT_FOUND',
        });
    }

    // 2. Prepare headers with browser spoofing and incoming Range
    const rangeHeader = req.headers['range'];
    const outboundHeaders = getSpoofedHeaders('stream', {
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
    });

    try {
        // 3. Make server-side request to upstream real URL
        const upstreamRes = await request(realAudioUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: outboundHeaders,
            headersTimeout: 10000,
            bodyTimeout: 30000,
        });

        const statusCode = upstreamRes.statusCode;
        const headers = upstreamRes.headers;

        // 4. Set standard streaming & CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Content-Type');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=1800');

        if (headers['content-type']) {
            res.setHeader('Content-Type', headers['content-type']);
        }
        if (headers['content-length']) {
            res.setHeader('Content-Length', headers['content-length']);
        }
        if (headers['content-range']) {
            res.setHeader('Content-Range', headers['content-range']);
        }

        // 5. Set status 206 for Range responses, 200 otherwise
        res.status(statusCode);

        if (req.method === 'HEAD') {
            await upstreamRes.body.dump();
            return res.end();
        }

        // 6. Pipe upstream stream directly to client
        const stream = upstreamRes.body;
        req.on('close', () => {
            try {
                stream.destroy();
            } catch (_) {}
        });

        for await (const chunk of stream) {
            if (!res.write(chunk)) {
                await new Promise(resolve => res.once('drain', resolve));
            }
        }
        res.end();
    } catch (err) {
        if (!res.headersSent) {
            res.status(502).json({ error: 'Failed to stream audio from upstream provider', detail: err.message });
        } else {
            res.end();
        }
    }
}

router.get('/:songId', handleStreamRequest);
router.head('/:songId', handleStreamRequest);

export default router;
