/**
 * /api/v1/playback/:songId — Clean server-side playback gateway.
 *
 * Flutter ALWAYS calls this endpoint. The backend:
 *   1. Resolves the current CDN URL server-side (with caching & retry).
 *   2. Injects the correct Referer / Origin / User-Agent for the provider.
 *   3. Forwards Range / If-Range headers for byte-accurate seeking.
 *   4. On upstream 401/403/410 (CDN token expired): re-resolves & retries once.
 *   5. Sets Accept-Encoding: identity so CDN never gzip-encodes audio bytes.
 *
 * Flutter never sees raw CDN URLs — CDN token expiry is handled transparently.
 */

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

// ─── Shared helpers ───────────────────────────────────────────────────────────

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range, Accept, Authorization, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, X-Stream-Provider');
    res.setHeader('Accept-Ranges', 'bytes');
}

function buildOutboundHeaders(streamUrl, req) {
    const headers = {
        ...getHeadersForStreamUrl(streamUrl),
        // Never accept compressed audio — gzip breaks Content-Length and
        // Content-Range which ExoPlayer/AVPlayer need for byte-accurate seeking.
        'Accept-Encoding': 'identity',
    };
    if (req.headers['range'])    headers['Range']    = req.headers['range'];
    if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];
    return headers;
}

function forwardResponseHeaders(upstream, res) {
    const passThrough = ['content-type', 'content-length', 'content-range', 'last-modified', 'etag'];
    for (const h of passThrough) {
        if (upstream[h]) res.setHeader(h, upstream[h]);
    }
}

async function pipeBody(body, req, res) {
    req.on('close', () => { try { body.destroy(); } catch (_) {} });
    for await (const chunk of body) {
        if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
    }
    res.end();
}

// ─── Preflight ────────────────────────────────────────────────────────────────

router.options('/:songId', (_req, res) => {
    setCorsHeaders(res);
    res.status(204).end();
});

// ─── GET / HEAD /api/v1/playback/:songId ──────────────────────────────────────

async function handlePlayback(req, res) {
    const songId     = req.params.songId;
    const songTitle  = req.query.title  || req.query.q || '';
    const songArtist = req.query.artist || '';
    const songAlbum  = req.query.album  || '';
    const language   = req.query.language || '';

    if (!songId) {
        return res.status(400).json({ success: false, error: 'songId is required', code: 'BAD_REQUEST' });
    }

    const trackKey = generateTrackKey(songId, songTitle, songArtist, songAlbum);

    // ── 1. Resolve CDN URL (cache-first) ──────────────────────────────────────
    let streamData = getCachedStream(trackKey) || getCachedStream(songId);
    if (!streamData?.streamUrl) {
        try {
            streamData = await resolvePlayableStream({
                id: songId,
                title: songTitle,
                artist: songArtist,
                album: songAlbum,
                language,
            });
        } catch (err) {
            if (err instanceof PlaybackResolveError) {
                return res.status(404).json({ success: false, error: err.message, code: err.code });
            }
            console.error(`[playback] Resolution error for ${songId}:`, err.message);
            return res.status(502).json({ success: false, error: 'Could not resolve audio stream', code: 'RESOLVER_ERROR' });
        }
    }

    const isHls = streamData.isHls || (streamData.streamUrl || '').includes('.m3u8');

    // For HLS, redirect Flutter to the existing /api/stream/:songId proxy which
    // handles .m3u8 playlist rewriting and chunk proxying correctly.
    if (isHls) {
        const hlsProxyUrl = `/api/stream/${encodeURIComponent(songId)}?title=${encodeURIComponent(songTitle)}&artist=${encodeURIComponent(songArtist)}&album=${encodeURIComponent(songAlbum)}`;
        return res.redirect(307, hlsProxyUrl);
    }

    // ── 2. Fetch from CDN with retry on expired token ─────────────────────────
    let upstreamRes;
    let realAudioUrl = streamData.streamUrl;
    let attempt = 0;

    while (attempt < 2) {
        attempt++;
        try {
            upstreamRes = await request(realAudioUrl, {
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: buildOutboundHeaders(realAudioUrl, req),
                headersTimeout: 8000,
                // 120s body timeout: streams a 5 MB 320kbps song at even slow
                // CDN speeds without Cloudflare's 90s Worker hard-cutting us.
                bodyTimeout: 120000,
                maxRedirections: 5,
            });

            const { statusCode } = upstreamRes;

            // CDN token expired / revoked — re-resolve once, then retry
            if ((statusCode === 401 || statusCode === 403 || statusCode === 410) && attempt === 1) {
                console.warn(`[playback] CDN returned ${statusCode} for ${songId} — re-resolving URL`);
                await upstreamRes.body.dump();  // drain to free connection
                invalidateStreamCache(trackKey);
                invalidateStreamCache(songId);
                try {
                    streamData = await resolvePlayableStream({
                        id: songId, title: songTitle, artist: songArtist, album: songAlbum, language,
                    });
                    realAudioUrl = streamData.streamUrl;
                } catch (resolveErr) {
                    console.error(`[playback] Re-resolve failed for ${songId}:`, resolveErr.message);
                    return res.status(502).json({
                        success: false,
                        error: 'Audio stream expired and could not be refreshed',
                        code: 'STREAM_EXPIRED',
                    });
                }
                continue;  // retry with fresh URL
            }

            break;  // good status or non-retryable — exit loop
        } catch (fetchErr) {
            if (attempt >= 2 || !res.headersSent === false) {
                console.error(`[playback] Upstream fetch failed for ${songId}:`, fetchErr.message);
                return res.status(502).json({
                    success: false,
                    error: 'Failed to fetch audio from upstream provider',
                    code: 'UPSTREAM_ERROR',
                    detail: fetchErr.message,
                });
            }
            // Network error on attempt 1 — try a fresh URL
            invalidateStreamCache(trackKey);
            invalidateStreamCache(songId);
            try {
                streamData = await resolvePlayableStream({ id: songId, title: songTitle, artist: songArtist, album: songAlbum, language });
                realAudioUrl = streamData.streamUrl;
            } catch (_) {
                console.error(`[playback] Re-resolve after network error failed for ${songId}`);
                return res.status(502).json({ success: false, error: 'Upstream network error', code: 'UPSTREAM_ERROR' });
            }
        }
    }

    // ── 3. Stream response back to Flutter ────────────────────────────────────
    setCorsHeaders(res);
    // No client caching for audio proxied responses — only the backend caches CDN URLs.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Stream-Provider', streamData.provider || 'unknown');
    forwardResponseHeaders(upstreamRes.headers, res);
    res.status(upstreamRes.statusCode);

    if (req.method === 'HEAD') {
        await upstreamRes.body.dump();
        return res.end();
    }

    try {
        await pipeBody(upstreamRes.body, req, res);
    } catch (pipeErr) {
        // Client disconnected mid-stream — normal on track skip/pause
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Stream pipe error', detail: pipeErr.message });
        } else {
            res.end();
        }
    }
}

router.get('/:songId', handlePlayback);
router.head('/:songId', handlePlayback);

export default router;
