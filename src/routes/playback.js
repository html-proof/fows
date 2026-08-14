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
 * Uses Node 18+ built-in fetch() for CDN requests — handles redirects
 * automatically (redirect: 'follow') with no undici maxRedirections API issues.
 *
 * Flutter never sees raw CDN URLs — CDN token expiry is handled transparently.
 */

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

function forwardResponseHeaders(upstreamHeaders, res) {
    const passThrough = ['content-type', 'content-length', 'content-range', 'last-modified', 'etag'];
    for (const h of passThrough) {
        const val = upstreamHeaders.get ? upstreamHeaders.get(h) : upstreamHeaders[h];
        if (val) res.setHeader(h, val);
    }
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

    // For HLS redirect to the existing /api/stream/:songId which handles .m3u8 rewriting
    if (isHls) {
        const hlsProxyUrl = `/api/stream/${encodeURIComponent(songId)}?title=${encodeURIComponent(songTitle)}&artist=${encodeURIComponent(songArtist)}&album=${encodeURIComponent(songAlbum)}`;
        return res.redirect(307, hlsProxyUrl);
    }

    // ── 2. Fetch from CDN using Node built-in fetch() ─────────────────────────
    // fetch() automatically follows redirects (redirect: 'follow') — no undici
    // maxRedirections API issues, works on all Node 18+ environments.
    let upstreamRes;
    let realAudioUrl = streamData.streamUrl;
    let attempt = 0;

    while (attempt < 2) {
        attempt++;
        try {
            upstreamRes = await fetch(realAudioUrl, {
                method: req.method === 'HEAD' ? 'HEAD' : 'GET',
                headers: buildOutboundHeaders(realAudioUrl, req),
                redirect: 'follow',
                // AbortSignal.timeout is Node 18+ — 120s body timeout so
                // Cloudflare's 90s worker timeout isn't the bottleneck.
                signal: AbortSignal.timeout(120000),
            });

            const { status } = upstreamRes;

            // CDN token expired / revoked / deleted — re-resolve once via fallback search, then retry
            if ((status === 404 || status === 401 || status === 403 || status === 410) && attempt === 1) {
                console.warn(`[playback] CDN returned ${status} for ${songId} — re-resolving URL`);
                invalidateStreamCache(trackKey);
                invalidateStreamCache(songId);
                try {
                    streamData = await resolvePlayableStream({
                        id: '', title: songTitle, artist: songArtist, album: songAlbum, language,
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

            break;  // good status — exit loop
        } catch (fetchErr) {
            if (attempt >= 2) {
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
                return res.status(502).json({ success: false, error: 'Upstream network error', code: 'UPSTREAM_ERROR' });
            }
        }
    }

    // ── 3. Stream response back to Flutter ────────────────────────────────────
    setCorsHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Stream-Provider', streamData.provider || 'unknown');
    forwardResponseHeaders(upstreamRes.headers, res);
    res.status(upstreamRes.status);

    if (req.method === 'HEAD' || !upstreamRes.body) {
        return res.end();
    }

    // Convert Web API ReadableStream → Node.js Readable → pipe to Express response
    try {
        const nodeStream = Readable.fromWeb(upstreamRes.body);
        req.on('close', () => { try { nodeStream.destroy(); } catch (_) {} });
        nodeStream.pipe(res);
        nodeStream.on('error', (err) => {
            if (!res.headersSent) res.status(500).end();
            else res.end();
        });
    } catch (pipeErr) {
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Stream pipe error', detail: pipeErr.message });
        } else {
            res.end();
        }
    }
}

import { getSongDirect } from '../services/jiosaavnDirect.js';
import { searchSongsOnly as searchGaanaSongsOnly } from '../services/gaanaApi.js';
import { probeStreamUrl } from '../services/streamValidator.js';

// ─── GET /api/v1/playback/diagnostics/:songId ──────────────────────────────────
router.get('/diagnostics/:songId', async (req, res) => {
    setCorsHeaders(res);
    const songId = req.params.songId;
    const songTitle = req.query.title || req.query.q || '';
    const songArtist = req.query.artist || '';
    const songAlbum = req.query.album || '';
    const language = req.query.language || '';

    const diag = {
        params: { songId, songTitle, songArtist, songAlbum, language },
        timestamp: new Date().toISOString(),
        steps: {},
    };

    // 1. Direct ID lookups
    try {
        const jioDirect = await getSongDirect(songId).catch(e => ({ error: e.message }));
        diag.steps.jioDirect = {
            found: !!jioDirect?.name,
            name: jioDirect?.name,
            downloadUrlCount: jioDirect?.downloadUrl?.length || 0,
        };
        if (jioDirect?.downloadUrl?.[0]?.url) {
            const probe = await probeStreamUrl(jioDirect.downloadUrl[0].url, { timeoutMs: 2500 });
            diag.steps.jioDirectProbe = probe;
        }
    } catch (e) {
        diag.steps.jioDirect = { error: e.message };
    }

    // 2. Gaana Search
    try {
        const query = [songTitle, songArtist].filter(Boolean).join(' ') || songTitle || songId;
        const gaanaResults = await searchGaanaSongsOnly(query, 3).catch(e => ({ error: e.message }));
        diag.steps.gaanaSearch = {
            query,
            count: Array.isArray(gaanaResults) ? gaanaResults.length : 0,
            results: Array.isArray(gaanaResults) ? gaanaResults.map(g => ({
                title: g.title || g.name,
                artist: g.primaryArtists,
                hasDownloadUrl: !!g.downloadUrl?.[0]?.url,
                url: g.downloadUrl?.[0]?.url ? g.downloadUrl[0].url.substring(0, 80) + '...' : null,
            })) : gaanaResults,
        };
        if (Array.isArray(gaanaResults) && gaanaResults[0]?.downloadUrl?.[0]?.url) {
            const probe = await probeStreamUrl(gaanaResults[0].downloadUrl[0].url, { timeoutMs: 2500 });
            diag.steps.gaanaProbe = probe;
        }
    } catch (e) {
        diag.steps.gaanaSearch = { error: e.message };
    }

    // 3. Full Resolver Call
    try {
        const start = Date.now();
        const resolved = await resolvePlayableStream({
            id: songId,
            title: songTitle,
            artist: songArtist,
            album: songAlbum,
            language,
        });
        diag.steps.fullResolver = {
            timeMs: Date.now() - start,
            provider: resolved.provider,
            bitrate: resolved.bitrate,
            streamUrl: resolved.streamUrl ? resolved.streamUrl.substring(0, 100) + '...' : null,
        };
    } catch (e) {
        diag.steps.fullResolver = { error: e.message, code: e.code };
    }

    return res.json(diag);
});

router.get('/:songId', handlePlayback);
router.head('/:songId', handlePlayback);

export default router;
