import express from 'express';
import { request } from 'undici';
import {
    resolvePlayableStream,
    getCachedStream,
    invalidateStreamCache,
    generateTrackKey,
    PlaybackResolveError,
} from '../services/playbackResolver.js';
import { getHeadersForStreamUrl } from '../services/streamValidator.js';

const router = express.Router();

// ─── CORS headers applied to every streaming response ─────────────────────────
function setStreamCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range, Accept, Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type, X-Stream-Provider');
    res.setHeader('Accept-Ranges', 'bytes');
}

// ─── Build outbound headers for upstream audio request ────────────────────────
function buildAudioOutboundHeaders(streamUrl, req) {
    const headers = {
        ...getHeadersForStreamUrl(streamUrl),
        // Tell CDN never to compress — gzip breaks Content-Length / Content-Range
        // calculations that ExoPlayer/AVPlayer require for byte-accurate seeking.
        'Accept-Encoding': 'identity',
    };
    const rangeHeader = req.headers['range'];
    if (rangeHeader) headers['Range'] = rangeHeader;
    const ifRangeHeader = req.headers['if-range'];
    if (ifRangeHeader) headers['If-Range'] = ifRangeHeader;
    return headers;
}

// ─── Forward response headers from upstream to client ─────────────────────────
function forwardUpstreamHeaders(upstreamHeaders, res) {
    const forwardList = [
        'content-type',
        'content-length',
        'content-range',
        'last-modified',
        'etag',
        'expires',
    ];
    for (const name of forwardList) {
        if (upstreamHeaders[name]) res.setHeader(name, upstreamHeaders[name]);
    }
}

// ─── Pipe upstream body to client, honouring backpressure ─────────────────────
async function pipeBody(upstreamBody, req, res) {
    req.on('close', () => {
        try { upstreamBody.destroy(); } catch (_) {}
    });
    for await (const chunk of upstreamBody) {
        if (!res.write(chunk)) {
            await new Promise(resolve => res.once('drain', resolve));
        }
    }
    res.end();
}

// ─── POST & GET /resolve (Stream Resolution Endpoint) ────────────────────────
// Request Body / Query: { id, title, artist, album, language }
// Returns validated direct streamUrl, proxyUrl, headers, and metadata.

async function handleStreamResolve(req, res) {
    const params = {
        id: req.body?.id || req.query?.id || '',
        title: req.body?.title || req.query?.title || req.query?.q || '',
        artist: req.body?.artist || req.query?.artist || '',
        album: req.body?.album || req.query?.album || '',
        language: req.body?.language || req.query?.language || '',
    };

    if (!params.id && !params.title) {
        return res.status(400).json({
            success: false,
            error: 'Song ID or title is required for stream resolution',
            code: 'BAD_REQUEST',
        });
    }

    try {
        const resolved = await resolvePlayableStream(params);
        return res.json({
            success: true,
            data: resolved,
        });
    } catch (err) {
        if (err instanceof PlaybackResolveError) {
            const status = err.code === 'BAD_REQUEST' ? 400 : 404;
            return res.status(status).json({
                success: false,
                error: err.message,
                code: err.code,
            });
        }
        console.error('[stream/resolve] Error:', err);
        return res.status(500).json({
            success: false,
            error: 'Failed to resolve playable stream',
            code: 'RESOLVER_ERROR',
        });
    }
}

router.post('/resolve', handleStreamResolve);
router.get('/resolve', handleStreamResolve);

// ─── GET & HEAD /chunk (Audio Segment Proxy for HLS .ts chunks) ──────────────
// Injects desktop Chrome Referer & User-Agent on every chunk to prevent 403 errors.

async function handleChunkProxy(req, res) {
    const chunkUrl = req.query.url;
    if (!chunkUrl || typeof chunkUrl !== 'string' || !chunkUrl.startsWith('http')) {
        return res.status(400).json({ error: 'Valid chunk URL is required' });
    }

    const outboundHeaders = {
        ...getHeadersForStreamUrl(chunkUrl),
        'Accept-Encoding': 'identity',
        ...(req.headers['range'] ? { 'Range': req.headers['range'] } : {}),
        ...(req.headers['if-range'] ? { 'If-Range': req.headers['if-range'] } : {}),
    };

    try {
        const upstreamRes = await request(chunkUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: outboundHeaders,
            headersTimeout: 6000,
            // HLS .ts chunks are small; 30s is enough
            bodyTimeout: 30000,
            maxRedirections: 5,
        });

        setStreamCorsHeaders(res);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        forwardUpstreamHeaders(upstreamRes.headers, res);
        res.status(upstreamRes.statusCode);

        if (req.method === 'HEAD') {
            await upstreamRes.body.dump();
            return res.end();
        }

        await pipeBody(upstreamRes.body, req, res);
    } catch (err) {
        if (!res.headersSent) {
            res.status(502).json({ error: 'Failed to proxy media chunk', detail: err.message });
        } else {
            res.end();
        }
    }
}

router.get('/chunk', handleChunkProxy);
router.head('/chunk', handleChunkProxy);

// ─── GET & HEAD /:songId (Byte-Range Audio Proxy) ─────────────────────────────
// Supports HTTP Range / If-Range headers (ExoPlayer byte-range seeking).
// Retries with a fresh CDN URL on 401 / 403 / 410 from upstream (expired tokens).

async function handleStreamProxy(req, res) {
    const songId = req.params.songId;
    if (!songId || songId === 'resolve' || songId === 'chunk') {
        return res.status(400).json({ error: 'Song ID is required' });
    }

    const songTitle  = req.query.title  || req.query.q || '';
    const songArtist = req.query.artist || '';
    const songAlbum  = req.query.album  || '';
    const trackKey   = generateTrackKey(songId, songTitle, songArtist, songAlbum);

    // ── Resolve CDN URL (cache-first) ─────────────────────────────────────────
    let streamData = getCachedStream(trackKey) || getCachedStream(songId);
    if (!streamData?.streamUrl) {
        try {
            streamData = await resolvePlayableStream({
                id: songId,
                title: songTitle,
                artist: songArtist,
                album: songAlbum,
            });
        } catch (err) {
            return res.status(404).json({
                error: 'Stream not found or could not be resolved',
                code: 'STREAM_NOT_FOUND',
                detail: err.message,
            });
        }
    }

    let realAudioUrl = streamData.streamUrl;
    const isHls = streamData.isHls || realAudioUrl.includes('.m3u8');

    // ── Attempt upstream fetch (with one retry on expired token) ──────────────
    let upstreamRes;
    let attempt = 0;
    while (attempt < 2) {
        attempt++;
        const outboundHeaders = buildAudioOutboundHeaders(realAudioUrl, req);
        try {
            upstreamRes = await request(realAudioUrl, {
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: outboundHeaders,
                headersTimeout: 8000,
                // 120s: gives Render time to stream large progressive files without
                // Cloudflare's 90s Worker timeout becoming the bottleneck.
                bodyTimeout: 120000,
                maxRedirections: 5,
            });

            const statusCode = upstreamRes.statusCode;

            // 401 / 403 / 410 = expired or revoked CDN token — re-resolve once
            if ((statusCode === 401 || statusCode === 403 || statusCode === 410) && attempt === 1) {
                console.warn(`[stream] Upstream ${statusCode} for ${songId} (attempt ${attempt}) — invalidating cache and re-resolving CDN URL`);
                await upstreamRes.body.dump();  // drain body to avoid connection leak
                invalidateStreamCache(trackKey);
                invalidateStreamCache(songId);
                try {
                    streamData = await resolvePlayableStream({
                        id: songId,
                        title: songTitle,
                        artist: songArtist,
                        album: songAlbum,
                    });
                    realAudioUrl = streamData.streamUrl;
                } catch (resolveErr) {
                    console.error(`[stream] Re-resolve failed for ${songId}:`, resolveErr.message);
                    return res.status(502).json({
                        error: 'Stream URL expired and re-resolution failed',
                        code: 'STREAM_EXPIRED',
                    });
                }
                continue;  // retry the loop with fresh URL
            }

            break;  // success or non-retryable status — exit the retry loop
        } catch (fetchErr) {
            if (attempt >= 2) throw fetchErr;
            console.warn(`[stream] Fetch error attempt ${attempt} for ${songId}:`, fetchErr.message);
            // On a network error on attempt 1, try re-resolving and retrying
            invalidateStreamCache(trackKey);
            invalidateStreamCache(songId);
            try {
                streamData = await resolvePlayableStream({
                    id: songId, title: songTitle, artist: songArtist, album: songAlbum,
                });
                realAudioUrl = streamData.streamUrl;
            } catch (_) {
                throw fetchErr;  // re-throw original error
            }
        }
    }

    const statusCode  = upstreamRes.statusCode;
    const headers     = upstreamRes.headers;
    const contentType = String(headers['content-type'] || '').toLowerCase();

    // ── HLS playlist rewriting ────────────────────────────────────────────────
    if (isHls || contentType.includes('mpegurl') || realAudioUrl.includes('.m3u8')) {
        const rawBody = await upstreamRes.body.text();
        if (rawBody.includes('#EXTM3U')) {
            const baseUrl  = realAudioUrl.substring(0, realAudioUrl.lastIndexOf('/') + 1);
            const hostUrl  = `${req.protocol}://${req.get('host')}`;
            const rewritten = rawBody.split('\n').map(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;
                const absoluteTarget = trimmed.startsWith('http')
                    ? trimmed
                    : new URL(trimmed, baseUrl).toString();
                return `${hostUrl}/api/stream/chunk?url=${encodeURIComponent(absoluteTarget)}`;
            }).join('\n');

            setStreamCorsHeaders(res);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.setHeader('X-Stream-Provider', streamData.provider || 'unknown');
            res.status(200);
            return res.send(rewritten);
        }
    }

    // ── Progressive audio stream (MP4 / MP3 / AAC) ───────────────────────────
    setStreamCorsHeaders(res);
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.setHeader('X-Stream-Provider', streamData.provider || 'unknown');
    forwardUpstreamHeaders(headers, res);
    res.status(statusCode);

    if (req.method === 'HEAD') {
        await upstreamRes.body.dump();
        return res.end();
    }

    try {
        await pipeBody(upstreamRes.body, req, res);
    } catch (pipeErr) {
        if (!res.headersSent) {
            res.status(502).json({ error: 'Stream interrupted', detail: pipeErr.message });
        } else {
            res.end();
        }
    }
}

router.get('/:songId', handleStreamProxy);
router.head('/:songId', handleStreamProxy);

export default router;
