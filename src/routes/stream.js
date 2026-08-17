import express from 'express';
import { Readable } from 'node:stream';
import {
    resolvePlayableStream,
    getCachedStream,
    invalidateStreamCache,
    generateTrackKey,
    PlaybackResolveError,
} from '../services/playbackResolver.js';
import { getHeadersForStreamUrl } from '../services/streamValidator.js';

const router = express.Router();

// ─── SSRF guard for chunk proxy ───────────────────────────────────────────────
function isPrivateHost(hostname) {
    if (hostname === 'localhost' || hostname === '0.0.0.0') return true;
    if (/^127\./.test(hostname)) return true;
    if (/^10\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (/^169\.254\./.test(hostname)) return true;
    if (hostname === '::1' || /^fe80:/i.test(hostname) || /^::ffff:/i.test(hostname)) return true;
    if (hostname === '100.100.100.200') return true; // Alibaba Cloud metadata
    return false;
}

function assertSafeChunkUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Invalid protocol');
    if (isPrivateHost(parsed.hostname)) throw new Error('Host not allowed');
}

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
        // Support both fetch Headers object and plain undici headers object
        const val = upstreamHeaders.get ? upstreamHeaders.get(name) : upstreamHeaders[name];
        if (val) res.setHeader(name, val);
    }
}

// ─── Pipe upstream body to client ─────────────────────────────────────────────
async function pipeBody(upstreamBody, req, res) {
    // upstreamBody may be a Web API ReadableStream (from fetch()) — convert first
    const nodeStream = upstreamBody?.getReader
        ? Readable.fromWeb(upstreamBody)
        : Readable.from(upstreamBody);
    req.on('close', () => { try { nodeStream.destroy(); } catch (_) {} });
    nodeStream.pipe(res);
    await new Promise((resolve, reject) => {
        nodeStream.on('end', resolve);
        nodeStream.on('error', reject);
        res.on('close', resolve);
    });
}

// ─── Recursive HLS Playlist Flattener ─────────────────────────────────────────
export async function fetchAndFlattenM3u8(playlistUrl, hostUrl, depth = 0) {
    if (depth > 3) return null;
    try {
        assertSafeChunkUrl(playlistUrl);
    } catch {
        return null;
    }
    try {
        const headers = getHeadersForStreamUrl(playlistUrl);
        const res = await fetch(playlistUrl, {
            headers: { ...headers, 'Accept-Encoding': 'identity' },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return null;
        const text = await res.text();
        if (!text.includes('#EXTM3U')) return null;

        // If master playlist with sub-playlists (#EXT-X-STREAM-INF), recursively resolve child playlist
        if (text.includes('#EXT-X-STREAM-INF')) {
            const lines = text.split('\n').map(l => l.trim());
            const subPath = lines.find(l => l && !l.startsWith('#'));
            if (subPath) {
                const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
                const childUrl = subPath.startsWith('http') ? subPath : new URL(subPath, baseUrl).toString();
                return fetchAndFlattenM3u8(childUrl, hostUrl, depth + 1);
            }
        }

        // Rewrite segment paths (e.g. segment-0.ts) to /api/stream/chunk?url=...
        const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
        return text.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            const absUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).toString();
            return `${hostUrl}/api/stream/chunk?url=${encodeURIComponent(absUrl)}`;
        }).join('\n');
    } catch (_) {
        return null;
    }
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

    try {
        assertSafeChunkUrl(chunkUrl);
    } catch {
        return res.status(403).json({ error: 'URL not allowed' });
    }

    const outboundHeaders = {
        ...getHeadersForStreamUrl(chunkUrl),
        'Accept-Encoding': 'identity',
        ...(req.headers['range'] ? { 'Range': req.headers['range'] } : {}),
        ...(req.headers['if-range'] ? { 'If-Range': req.headers['if-range'] } : {}),
    };

    try {
        // Use Node built-in fetch() — follows redirects automatically
        const upstreamRes = await fetch(chunkUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: outboundHeaders,
            redirect: 'follow',
            signal: AbortSignal.timeout(30000),
        });

        const contentType = String(upstreamRes.headers.get ? upstreamRes.headers.get('content-type') : (upstreamRes.headers['content-type'] || '')).toLowerCase();
        if (contentType.includes('mpegurl') || chunkUrl.includes('.m3u8')) {
            const forwardedHost = req.headers['x-forwarded-host'];
            const hostUrl = forwardedHost
                ? `https://${forwardedHost}`
                : `${req.protocol}://${req.get('host')}`;
            const rewritten = await fetchAndFlattenM3u8(chunkUrl, hostUrl);
            if (rewritten) {
                setStreamCorsHeaders(res);
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Cache-Control', 'public, max-age=300');
                res.status(200);
                return res.send(rewritten);
            }
        }

        setStreamCorsHeaders(res);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        forwardUpstreamHeaders(upstreamRes.headers, res);
        res.status(upstreamRes.status);

        if (req.method === 'HEAD' || !upstreamRes.body) {
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
        try {
            // Use Node built-in fetch() — follows redirects automatically, no undici
            // maxRedirections API issues on any Node 18+ environment.
            upstreamRes = await fetch(realAudioUrl, {
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: buildAudioOutboundHeaders(realAudioUrl, req),
                redirect: 'follow',
                // 120s: gives Render time to stream large progressive files without
                // Cloudflare's 90s Worker timeout becoming the bottleneck.
                signal: AbortSignal.timeout(120000),
            });

            const statusCode = upstreamRes.status;

            // 401 / 403 / 410 = expired or revoked CDN token — re-resolve once
            if ((statusCode === 401 || statusCode === 403 || statusCode === 410) && attempt === 1) {
                console.warn(`[stream] Upstream ${statusCode} for ${songId} (attempt ${attempt}) — invalidating cache and re-resolving CDN URL`);
                // Drain body
                await upstreamRes.arrayBuffer();
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

    const statusCode  = upstreamRes.status;
    const headers     = upstreamRes.headers;
    const contentType = String(headers.get ? headers.get('content-type') : (headers['content-type'] || '')).toLowerCase();

    // ── HLS playlist rewriting (flattens master to segment-level playlist) ──
    if (isHls || contentType.includes('mpegurl') || realAudioUrl.includes('.m3u8')) {
        const forwardedHost = req.headers['x-forwarded-host'];
        const hostUrl = forwardedHost
            ? `https://${forwardedHost}`
            : `${req.protocol}://${req.get('host')}`;
        const rewritten = await fetchAndFlattenM3u8(realAudioUrl, hostUrl);
        if (rewritten) {
            setStreamCorsHeaders(res);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.setHeader('X-Stream-Provider', streamData.provider || 'gaana');
            res.status(200);
            return res.send(rewritten);
        }
    }

    // ── Progressive audio stream (MP4 / MP3 / AAC) ───────────────────────────
    setStreamCorsHeaders(res);
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.setHeader('X-Stream-Provider', streamData.provider || 'unknown');
    forwardUpstreamHeaders(headers, res);
    res.status(upstreamRes.status);

    if (req.method === 'HEAD' || !upstreamRes.body) {
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
