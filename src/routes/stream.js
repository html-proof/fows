import express from 'express';
import { request } from 'undici';
import { getSongDirect, searchSongsDirect } from '../services/jiosaavnDirect.js';
import { getSongById as getSaavnSongById } from '../services/saavnApi.js';
import { getSongById as getGaanaSongById, searchSongsOnly as searchGaanaSongsOnly } from '../services/gaanaApi.js';
import { getSpoofedHeaders } from '../middleware/spoofHeaders.js';

const router = express.Router();

// Fast memory cache for resolved stream URLs
const resolvedUrlCache = new Map();
const URL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
 * Fast 1.5s probe timeout to never block playback.
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
            headersTimeout: 2000,
            bodyTimeout: 2000,
        });

        const status = res.statusCode;
        const contentType = (res.headers['content-type'] ?? '').toLowerCase();

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
 * Fast parallel upstream playable audio URL resolver.
 */
async function resolveUpstreamAudioUrl(songId, queryHint = '', songTitle = '', songArtist = '') {
    // 1. Check memory cache first (instant 0ms)
    const cached = getCachedUrl(songId);
    if (cached) return cached;

    // 2. Parallel direct lookups on JioSaavn and Gaana
    const [jioRes, gaanaRes] = await Promise.allSettled([
        (async () => {
            const jioSong = await getSongDirect(songId).catch(() => null)
                || await getSaavnSongById(songId).then(r => r?.data?.[0]).catch(() => null);
            const jioUrl = _extractDownloadUrl(jioSong);
            if (jioUrl && await validateStreamUrl(jioUrl)) {
                return jioUrl;
            }
            return null;
        })(),
        (async () => {
            const gaanaDetail = await getGaanaSongById(songId).catch(() => null);
            const gaanaSong = gaanaDetail?.data?.[0];
            const gaanaUrl = _extractDownloadUrl(gaanaSong);
            if (gaanaUrl && await validateStreamUrl(gaanaUrl)) {
                return gaanaUrl;
            }
            return null;
        })(),
    ]);

    const directWinner = (jioRes.status === 'fulfilled' ? jioRes.value : null)
        || (gaanaRes.status === 'fulfilled' ? gaanaRes.value : null);

    if (directWinner) {
        setCachedUrl(songId, directWinner);
        return directWinner;
    }

    // 3. Fallback parallel search if direct lookups yielded no stream
    const searchTarget = [songTitle, songArtist, queryHint, songId.replace(/[-_]/g, ' ')].filter(Boolean)[0] || '';
    if (searchTarget.length > 1) {
        try {
            const [jioResults, gaanaResults] = await Promise.allSettled([
                searchSongsDirect(searchTarget, 5),
                searchGaanaSongsOnly(searchTarget, 5),
            ]);

            const jioSongs = jioResults.status === 'fulfilled' && Array.isArray(jioResults.value) ? jioResults.value : [];
            const gaanaSongs = gaanaResults.status === 'fulfilled' && Array.isArray(gaanaResults.value) ? gaanaResults.value : [];
            const candidates = [...gaanaSongs, ...jioSongs];

            // Probe top candidates in parallel
            const probePromises = candidates.map(async (cand) => {
                const candUrl = _extractDownloadUrl(cand);
                if (candUrl && await validateStreamUrl(candUrl)) {
                    return candUrl;
                }
                return null;
            });

            const results = await Promise.all(probePromises);
            const validWinner = results.find(url => url !== null);
            if (validWinner) {
                setCachedUrl(songId, validWinner);
                return validWinner;
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

    // 1. Fast parallel resolution
    const realAudioUrl = await resolveUpstreamAudioUrl(songId, queryHint, songTitle, songArtist);
    if (!realAudioUrl) {
        return res.status(404).json({
            error: 'Unable to resolve playable audio stream for this song',
            code: 'STREAM_NOT_FOUND',
        });
    }

    // 2. Forward Range headers
    const rangeHeader = req.headers['range'];
    const outboundHeaders = getSpoofedHeaders('stream', {
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
    });

    try {
        const upstreamRes = await request(realAudioUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: outboundHeaders,
            headersTimeout: 6000,
            bodyTimeout: 30000,
        });

        const statusCode = upstreamRes.statusCode;
        const headers = upstreamRes.headers;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Content-Type');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600');

        if (headers['content-type']) {
            res.setHeader('Content-Type', headers['content-type']);
        }
        if (headers['content-length']) {
            res.setHeader('Content-Length', headers['content-length']);
        }
        if (headers['content-range']) {
            res.setHeader('Content-Range', headers['content-range']);
        }

        res.status(statusCode);

        if (req.method === 'HEAD') {
            await upstreamRes.body.dump();
            return res.end();
        }

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
