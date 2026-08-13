import express from 'express';
import { request } from 'undici';
import {
    resolvePlayableStream,
    getCachedStream,
    PlaybackResolveError,
} from '../services/playbackResolver.js';
import { getHeadersForStreamUrl } from '../services/streamValidator.js';

const router = express.Router();

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

    const rangeHeader = req.headers['range'];
    const outboundHeaders = {
        ...getHeadersForStreamUrl(chunkUrl),
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
    };

    try {
        const upstreamRes = await request(chunkUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: outboundHeaders,
            headersTimeout: 6000,
            bodyTimeout: 30000,
            maxRedirections: 3,
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Content-Type');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=3600');

        if (upstreamRes.headers['content-type']) {
            res.setHeader('Content-Type', upstreamRes.headers['content-type']);
        }
        if (upstreamRes.headers['content-length']) {
            res.setHeader('Content-Length', upstreamRes.headers['content-length']);
        }
        if (upstreamRes.headers['content-range']) {
            res.setHeader('Content-Range', upstreamRes.headers['content-range']);
        }

        res.status(upstreamRes.statusCode);

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
            res.status(502).json({ error: 'Failed to proxy media chunk', detail: err.message });
        } else {
            res.end();
        }
    }
}

router.get('/chunk', handleChunkProxy);
router.head('/chunk', handleChunkProxy);

// ─── GET & HEAD /:songId (Byte-Range Audio Proxy) ─────────────────────────────
// Supports HTTP Range header (bytes=start-end) and HLS playlist segment rewriting.

async function handleStreamProxy(req, res) {
    const songId = req.params.songId;
    if (!songId || songId === 'resolve' || songId === 'chunk') {
        return res.status(400).json({ error: 'Song ID is required' });
    }

    const queryHint = req.query.title || req.query.q || '';
    const songTitle = req.query.title || '';
    const songArtist = req.query.artist || '';
    const songAlbum = req.query.album || '';

    let streamData = getCachedStream(songId);

    if (!streamData || !streamData.streamUrl) {
        try {
            streamData = await resolvePlayableStream({
                id: songId,
                title: songTitle || queryHint,
                artist: songArtist,
                album: songAlbum,
            });
        } catch (err) {
            return res.status(404).json({
                error: 'Stream expired or not found',
                code: 'STREAM_NOT_FOUND',
                detail: err.message,
            });
        }
    }

    const realAudioUrl = streamData.streamUrl;
    const isHls = streamData.isHls || realAudioUrl.includes('.m3u8');
    const rangeHeader = req.headers['range'];
    const outboundHeaders = {
        ...getHeadersForStreamUrl(realAudioUrl),
        ...(rangeHeader ? { 'Range': rangeHeader } : {}),
    };

    try {
        const upstreamRes = await request(realAudioUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: outboundHeaders,
            headersTimeout: 6000,
            bodyTimeout: 30000,
            maxRedirections: 3,
        });

        const statusCode = upstreamRes.statusCode;
        const headers = upstreamRes.headers;
        const contentType = String(headers['content-type'] || '').toLowerCase();

        // Check if response is an HLS playlist (.m3u8)
        if (isHls || contentType.includes('mpegurl') || realAudioUrl.includes('.m3u8')) {
            const rawBody = await upstreamRes.body.text();

            if (rawBody.includes('#EXTM3U')) {
                // Determine base URL for relative playlist/segment URIs
                const baseUrl = realAudioUrl.substring(0, realAudioUrl.lastIndexOf('/') + 1);
                const hostUrl = `${req.protocol}://${req.get('host')}`;

                const rewrittenLines = rawBody.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) return line;

                    // Resolve absolute URL of child playlist or .ts segment
                    const absoluteTarget = trimmed.startsWith('http')
                        ? trimmed
                        : new URL(trimmed, baseUrl).toString();

                    // If it's a child playlist, proxy it through /api/stream/:songId or /api/stream/chunk
                    return `${hostUrl}/api/stream/chunk?url=${encodeURIComponent(absoluteTarget)}`;
                });

                const rewrittenPlaylist = rewrittenLines.join('\n');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Cache-Control', 'public, max-age=300');
                res.status(200);
                return res.send(rewrittenPlaylist);
            }
        }

        // Standard Progressive Media Stream (MP4, MP3, AAC)
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

router.get('/:songId', handleStreamProxy);
router.head('/:songId', handleStreamProxy);

export default router;
