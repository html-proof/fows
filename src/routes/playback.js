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
    markStreamUrlOutcome,
    PlaybackResolveError,
} from '../services/playbackResolver.js';
import { getHeadersForStreamUrl, probeStreamUrl } from '../services/streamValidator.js';
import { getSongDirect } from '../services/jiosaavnDirect.js';
import { searchSongsOnly as searchGaanaSongsOnly } from '../services/gaanaApi.js';
import { fetchAndFlattenM3u8 } from './stream.js';
import { authenticateUser } from '../middleware/auth.js';

const router = express.Router();

// How many upstream URLs one playback request may burn through before giving
// up. Each failed attempt re-resolves with the dead URL excluded, so this is
// literally how many different sources — bitrates, then providers — the
// gateway is allowed to try on the client's behalf.
const MAX_UPSTREAM_ATTEMPTS = 3;

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

// ─── GET /api/v1/playback/prefetch/:songId ────────────────────────────────────
// Returns 202 immediately and resolves the stream in the background.
// Flutter calls this for the next-in-queue song so the CDN URL is cached
// before the user taps play — eliminating the cold-cache resolution delay.
router.get('/prefetch/:songId', (req, res) => {
    setCorsHeaders(res);
    const songId     = req.params.songId;
    const songTitle  = req.query.title  || req.query.q || '';
    const songArtist = req.query.artist || '';
    const songAlbum  = req.query.album  || '';
    const language   = req.query.language || '';
    const quality    = req.query.quality || '';

    if (!songId) {
        return res.status(400).json({ success: false, error: 'songId is required' });
    }

    // Check if already cached — if so, nothing to do.
    const trackKey = generateTrackKey(songId, songTitle, songArtist, songAlbum, language);
    const alreadyCached = getCachedStream(trackKey, quality) || getCachedStream(songId, quality);
    res.status(alreadyCached ? 200 : 202).json({ success: true, cached: !!alreadyCached });

    if (!alreadyCached) {
        // Fire-and-forget background resolution — client has already received 202.
        resolvePlayableStream({ id: songId, title: songTitle, artist: songArtist, album: songAlbum, language, quality })
            .catch(() => {});
    }
});

// ─── GET / HEAD /api/v1/playback/:songId ──────────────────────────────────────

async function handlePlayback(req, res) {
    const songId     = req.params.songId;
    const songTitle  = req.query.title  || req.query.q || '';
    const songArtist = req.query.artist || '';
    const songAlbum  = req.query.album  || '';
    const language   = req.query.language || '';
    const quality    = req.query.quality || '';

    if (!songId) {
        return res.status(400).json({ success: false, error: 'songId is required', code: 'BAD_REQUEST' });
    }

    // ── Client-driven failover ────────────────────────────────────────────────
    // The gateway URL is deterministic (built from the song id), so a client
    // that hits a dead stream cannot ask for "a different URL" simply by
    // re-resolving — it would rebuild the identical address. `retry=1` is how
    // it says "the last thing you gave me does not play, find another":
    //
    //   * the cache is bypassed, so the dead URL is not served straight back;
    //   * any URL named in `exclude` is banned from the result;
    //   * the 302 fast path is skipped, so bytes flow through here and the
    //     gateway can observe an upstream failure and fail over internally
    //     instead of redirecting the player at a URL it cannot supervise.
    const isRetry = req.query.retry === '1' || req.query.retry === 'true';
    const excludeUrls = []
        .concat(req.query.exclude || [])
        .map(u => String(u || '').trim())
        .filter(Boolean);

    const trackKey = generateTrackKey(songId, songTitle, songArtist, songAlbum, language);

    // ── 1. Resolve CDN URL (cache-first) ──────────────────────────────────────
    let streamData = isRetry
        ? null
        : (getCachedStream(trackKey, quality) || getCachedStream(songId, quality));
    if (isRetry) {
        invalidateStreamCache(trackKey, quality);
        invalidateStreamCache(songId, quality);
    }
    if (!streamData?.streamUrl) {
        try {
            streamData = await resolvePlayableStream({
                id: songId,
                title: songTitle,
                artist: songArtist,
                album: songAlbum,
                language,
                quality,
                excludeUrls,
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

    // ── Fast path: 302-redirect to public JioSaavn CDN (no byte-proxy) ─────────
    // saavncdn.com progressive MP4/AAC/MP3 files are public — they require no
    // Referer/Origin and no token. Proxying every byte through the free-tier
    // container just adds TTFB + throttles bandwidth. A redirect lets ExoPlayer/
    // AVPlayer stream and seek straight from the CDN edge = near-instant start.
    // Gaana/Akamai (need Referer) and HLS still use the transparent proxy below.
    // On a retry the redirect is deliberately skipped — see the note above.
    if (!isHls && req.method === 'GET' && !isRetry) {
        const u = (streamData.streamUrl || '').toLowerCase();
        const isPublicSaavnCdn = u.includes('saavncdn.com')
            && (u.includes('.mp4') || u.includes('.m4a') || u.includes('.aac') || u.includes('.mp3'));
        if (isPublicSaavnCdn) {
            setCorsHeaders(res);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Stream-Provider', streamData.provider || 'jiosaavn');
            return res.redirect(302, streamData.streamUrl);
        }
    }

    // ── HLS playlist direct delivery (flatten master playlist to segment-level) ──
    if (isHls) {
        // Use X-Forwarded-Host so chunk URLs point through the Cloudflare Worker
        // (music-hub.imeseban.workers.dev), not directly to the Render backend.
        // Chunks going directly to fows.onrender.com bypass CDN caching, hit
        // the free-tier container on every segment, and cause slow HLS playback.
        const forwardedHost = req.headers['x-forwarded-host'];
        const hostUrl = forwardedHost
            ? `https://${forwardedHost}`
            : `${req.protocol}://${req.get('host')}`;
        // Hand the flattener the tier the client asked for so it picks a
        // rendition that matches, instead of the first (heaviest) one listed.
        const rewritten = await fetchAndFlattenM3u8(streamData.streamUrl, hostUrl, { quality });
        if (rewritten) {
            setCorsHeaders(res);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.setHeader('X-Stream-Provider', streamData.provider || 'gaana');
            res.status(200);
            return res.send(rewritten);
        }
    }

    // ── 2. Fetch from CDN using Node built-in fetch() ─────────────────────────
    // fetch() automatically follows redirects (redirect: 'follow') — no undici
    // maxRedirections API issues, works on all Node 18+ environments.
    let upstreamRes;
    let realAudioUrl = streamData.streamUrl;
    let attempt = 0;

    while (attempt < MAX_UPSTREAM_ATTEMPTS) {
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

            // CDN token expired / revoked / deleted — re-resolve via fallback
            // search and retry. Every attempt but the last may fail over: one
            // retry only ever reached a second URL, and when a track's whole
            // JioSaavn ladder is dead the working source is the OTHER provider,
            // one hop further down.
            if ((status === 404 || status === 401 || status === 403 || status === 410)
                && attempt < MAX_UPSTREAM_ATTEMPTS) {
                console.warn(`[playback] CDN returned ${status} for ${songId} — re-resolving URL`);
                // Real upstream verdict — remember it so no later request wastes
                // a probe on this URL.
                markStreamUrlOutcome(realAudioUrl, false);
                invalidateStreamCache(trackKey, quality);
                invalidateStreamCache(songId, quality);
                try {
                    // Ban the URL that just failed. Re-resolving without this
                    // repeatedly returned the same dead address, so the single
                    // retry was spent re-confirming the failure instead of
                    // reaching a different bitrate or provider.
                    excludeUrls.push(realAudioUrl);
                    streamData = await resolvePlayableStream({
                        id: songId, title: songTitle, artist: songArtist, album: songAlbum, language, quality,
                        excludeUrls,
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

            // Upstream served it: the strongest possible evidence this URL is
            // playable. Recorded so the next resolve returns it without probing.
            if (status >= 200 && status < 300) markStreamUrlOutcome(realAudioUrl, true);
            break;  // good status — exit loop
        } catch (fetchErr) {
            if (attempt >= MAX_UPSTREAM_ATTEMPTS) {
                console.error(`[playback] Upstream fetch failed for ${songId}:`, fetchErr.message);
                return res.status(502).json({
                    success: false,
                    error: 'Failed to fetch audio from upstream provider',
                    code: 'UPSTREAM_ERROR',
                    detail: fetchErr.message,
                });
            }
            // Network error — try a fresh URL
            markStreamUrlOutcome(realAudioUrl, false);
            invalidateStreamCache(trackKey, quality);
            invalidateStreamCache(songId, quality);
            try {
                excludeUrls.push(realAudioUrl);
                streamData = await resolvePlayableStream({ id: songId, title: songTitle, artist: songArtist, album: songAlbum, language, quality, excludeUrls });
                realAudioUrl = streamData.streamUrl;
            } catch (_) {
                return res.status(502).json({ success: false, error: 'Upstream network error', code: 'UPSTREAM_ERROR' });
            }
        }
    }

    // Every failover has been spent and upstream is still refusing. Piping the
    // CDN's error body through as audio gave the player a "stream" that stalls
    // forever instead of failing; a clean JSON error lets it move on to the
    // next source immediately.
    if (upstreamRes.status >= 400) {
        markStreamUrlOutcome(realAudioUrl, false);
        invalidateStreamCache(trackKey, quality);
        invalidateStreamCache(songId, quality);
        console.error(`[playback] Upstream still ${upstreamRes.status} for ${songId} after ${attempt} attempts`);
        setCorsHeaders(res);
        return res.status(502).json({
            success: false,
            error: 'No playable source responded for this track',
            code: 'STREAM_UNAVAILABLE',
            upstreamStatus: upstreamRes.status,
        });
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

// ─── GET /api/v1/playback/diagnostics/:songId ──────────────────────────────────
router.get('/diagnostics/:songId', authenticateUser, async (req, res) => {
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
