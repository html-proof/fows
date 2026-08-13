import express from 'express';
import { request } from 'undici';
import { getSongById as getGaanaSongById, searchSongsOnly as searchGaanaSongsOnly } from '../services/gaanaApi.js';
import { getSongById as getSaavnSongById, searchSongsOnly as searchSaavnSongsOnly } from '../services/saavnApi.js';
import { getSongDirect, searchSongsDirect } from '../services/jiosaavnDirect.js';
import { normText, bigramSimilarity } from '../services/searchEngine.js';

const router = express.Router();

// Short TTL cache for resolved upstream stream URLs (keyed by track ID or query hash)
const streamCache = new Map();
const STREAM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCachedStream(trackId) {
    const entry = streamCache.get(trackId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        streamCache.delete(trackId);
        return null;
    }
    return entry;
}

function setCachedStream(trackId, streamData) {
    streamCache.set(trackId, {
        ...streamData,
        expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
    });
}

function generateTrackKey(title, artist, album) {
    const clean = normText(`${title} ${artist} ${album}`);
    let hash = 0;
    for (let i = 0; i < clean.length; i++) {
        hash = (Math.imul(31, hash) + clean.charCodeAt(i)) | 0;
    }
    return `trk_${Math.abs(hash).toString(36)}`;
}

/**
 * Validate that an upstream URL is active, returns HTTP 200/206, and has an audio/stream content-type.
 */
async function validateStreamUrl(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        return { valid: false };
    }
    try {
        const res = await request(url, {
            method: 'GET',
            headers: {
                'Range': 'bytes=0-1023',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
            },
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

        // Drain / consume small probe body
        await res.body.dump();

        if (isValidStatus && isValidContentType) {
            return {
                valid: true,
                contentType: res.headers['content-type'] || 'audio/mp4',
                contentLength: res.headers['content-length'] || null,
            };
        }
        return { valid: false, status, contentType };
    } catch (err) {
        return { valid: false, error: err.message };
    }
}

function _extractStreamUrlFromCandidate(candidate) {
    if (!candidate) return null;
    const urls = Array.isArray(candidate.downloadUrl) ? candidate.downloadUrl : [];
    return urls.find(u => u.quality === '320kbps')?.url
        || urls.find(u => u.quality === '160kbps')?.url
        || urls[urls.length - 1]?.url
        || candidate.streamUrl
        || candidate.stream_url
        || null;
}

/**
 * Resolve the real stream URL from Gaana.
 */
async function resolveFromGaana({ id, title, artist, album }) {
    if (id && !id.startsWith('trk_') && isNaN(Number(id)) === false) {
        try {
            const detail = await getGaanaSongById(id);
            if (detail?.success && Array.isArray(detail.data) && detail.data.length > 0) {
                const song = detail.data[0];
                const streamUrl = _extractStreamUrlFromCandidate(song);
                if (streamUrl) {
                    const validation = await validateStreamUrl(streamUrl);
                    if (validation.valid) {
                        return {
                            url: streamUrl,
                            quality: '320kbps',
                            contentType: validation.contentType,
                            provider: 'gaana',
                            song,
                        };
                    }
                }
            }
        } catch (_) {}
    }

    const searchQueries = [
        [title, artist].filter(Boolean).join(' '),
        [title, album].filter(Boolean).join(' '),
        title,
    ].filter(Boolean);

    for (const q of searchQueries) {
        try {
            const candidates = await searchGaanaSongsOnly(q, 10);
            if (!Array.isArray(candidates) || candidates.length === 0) continue;

            let bestCandidate = null;
            let highestScore = -1;

            for (const cand of candidates) {
                const candTitle = normText(cand.name || cand.title || '');
                const candArtist = normText(cand.primaryArtists || cand.artist || '');
                const titleSim = bigramSimilarity(normText(title || ''), candTitle);
                const artistSim = artist ? bigramSimilarity(normText(artist), candArtist) : 0.5;

                const score = titleSim * 0.7 + artistSim * 0.3;
                if (score > highestScore && score >= 0.45) {
                    highestScore = score;
                    bestCandidate = cand;
                }
            }

            if (!bestCandidate) continue;

            const streamUrl = _extractStreamUrlFromCandidate(bestCandidate);
            if (streamUrl) {
                const validation = await validateStreamUrl(streamUrl);
                if (validation.valid) {
                    return {
                        url: streamUrl,
                        quality: '320kbps',
                        contentType: validation.contentType,
                        provider: 'gaana',
                        song: bestCandidate,
                    };
                }
            }
        } catch (_) {}
    }

    return null;
}

/**
 * Resolve the real stream URL from JioSaavn.
 */
async function resolveFromJioSaavn({ id, title, artist, album }) {
    if (id && !id.startsWith('trk_')) {
        try {
            const song = await getSongDirect(id).catch(() => null)
                || await getSaavnSongById(id).then(r => r?.data?.[0]).catch(() => null);
            if (song) {
                const streamUrl = _extractStreamUrlFromCandidate(song);
                if (streamUrl) {
                    const validation = await validateStreamUrl(streamUrl);
                    if (validation.valid) {
                        return {
                            url: streamUrl,
                            quality: '320kbps',
                            contentType: validation.contentType,
                            provider: 'jiosaavn',
                            song,
                        };
                    }
                }
            }
        } catch (_) {}
    }

    const searchQueries = [
        [title, artist].filter(Boolean).join(' '),
        [title, album].filter(Boolean).join(' '),
        title,
    ].filter(Boolean);

    for (const q of searchQueries) {
        try {
            const candidates = await searchSongsDirect(q, 10).catch(() => [])
                || await searchSaavnSongsOnly(q, 1).then(r => r?.data?.results || []).catch(() => []);
            if (!Array.isArray(candidates) || candidates.length === 0) continue;

            let bestCandidate = null;
            let highestScore = -1;

            for (const cand of candidates) {
                const candTitle = normText(cand.name || cand.title || '');
                const candArtist = normText(cand.primaryArtists || cand.artist || '');
                const titleSim = bigramSimilarity(normText(title || ''), candTitle);
                const artistSim = artist ? bigramSimilarity(normText(artist), candArtist) : 0.5;

                const score = titleSim * 0.7 + artistSim * 0.3;
                if (score > highestScore && score >= 0.45) {
                    highestScore = score;
                    bestCandidate = cand;
                }
            }

            if (!bestCandidate) continue;

            const streamUrl = _extractStreamUrlFromCandidate(bestCandidate);
            if (streamUrl) {
                const validation = await validateStreamUrl(streamUrl);
                if (validation.valid) {
                    return {
                        url: streamUrl,
                        quality: '320kbps',
                        contentType: validation.contentType,
                        provider: 'jiosaavn',
                        song: bestCandidate,
                    };
                }
            }
        } catch (_) {}
    }

    return null;
}

/**
 * Resolve stream concurrently from Gaana + JioSaavn.
 */
async function resolveDualStream(params) {
    // Fire Gaana and JioSaavn resolvers in parallel
    const [gaanaRes, saavnRes] = await Promise.allSettled([
        resolveFromGaana(params),
        resolveFromJioSaavn(params),
    ]);

    const gaana = gaanaRes.status === 'fulfilled' ? gaanaRes.value : null;
    const saavn = saavnRes.status === 'fulfilled' ? saavnRes.value : null;

    // Pick first verified valid stream
    return gaana || saavn || null;
}

// ─── POST /api/player/resolve ────────────────────────────────────────────────
// Request: { id, title, artist, album, language }
// Response: { success: true, data: { trackId, streamUrl, proxyUrl, isPlayable: true, provider } }

async function handlePlayerResolve(req, res) {
    const params = {
        id: req.body?.id || req.query?.id,
        title: req.body?.title || req.query?.title || '',
        artist: req.body?.artist || req.query?.artist || '',
        album: req.body?.album || req.query?.album || '',
        language: req.body?.language || req.query?.language || '',
    };

    if (!params.title && !params.id) {
        return res.status(400).json({
            success: false,
            error: 'Title or ID is required for stream resolution',
        });
    }

    const trackKey = params.id && params.id.startsWith('trk_')
        ? params.id
        : generateTrackKey(params.title, params.artist, params.album);

    // Check fast stream cache
    const cached = getCachedStream(trackKey);
    if (cached) {
        return res.json({
            success: true,
            data: {
                trackId: trackKey,
                streamUrl: `/api/stream/${trackKey}`,
                proxyUrl: `/api/stream/${trackKey}`,
                isPlayable: true,
                bitrate: cached.quality || '320kbps',
                provider: cached.provider || 'gaana',
                cached: true,
            },
        });
    }

    try {
        const resolved = await resolveDualStream(params);
        if (!resolved || !resolved.url) {
            return res.status(404).json({
                success: false,
                error: `No playable Gaana/JioSaavn stream found for "${params.title}"`,
                code: 'NOT_PLAYABLE',
            });
        }

        // Cache the verified upstream stream URL
        setCachedStream(trackKey, {
            upstreamUrl: resolved.url,
            quality: resolved.quality,
            contentType: resolved.contentType,
            provider: resolved.provider,
            title: params.title,
            artist: params.artist,
        });

        return res.json({
            success: true,
            data: {
                trackId: trackKey,
                streamUrl: `/api/stream/${trackKey}`,
                proxyUrl: `/api/stream/${trackKey}`,
                isPlayable: true,
                bitrate: resolved.quality || '320kbps',
                provider: resolved.provider,
                cached: false,
            },
        });
    } catch (err) {
        console.error('[player/resolve]', err);
        return res.status(500).json({
            success: false,
            error: 'Failed to resolve stream from Gaana/JioSaavn',
            code: 'RESOLVER_ERROR',
        });
    }
}

router.post('/player/resolve', handlePlayerResolve);
router.get('/player/resolve', handlePlayerResolve);

// ─── GET & HEAD /api/stream/:trackId (Byte-Range Audio Proxy) ─────────────────
// Supports HTTP Range header (bytes=start-end) for mobile audio buffering & seeking.

async function handleStreamProxy(req, res) {
    const trackId = req.params.trackId;
    const cached = getCachedStream(trackId);

    if (!cached || !cached.upstreamUrl) {
        return res.status(404).json({
            error: 'Stream expired or not found. Please resolve track again.',
            code: 'STREAM_NOT_FOUND',
        });
    }

    const rangeHeader = req.headers['range'];
    const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
    };

    if (rangeHeader) {
        upstreamHeaders['Range'] = rangeHeader;
    }

    try {
        const upstreamRes = await request(cached.upstreamUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers: upstreamHeaders,
            headersTimeout: 10000,
            bodyTimeout: 30000,
        });

        const statusCode = upstreamRes.statusCode;
        const headers = upstreamRes.headers;

        // Set streaming CORS & caching headers
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

        // Pipe upstream audio stream to client response
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
            res.status(502).json({ error: 'Upstream stream error', detail: err.message });
        } else {
            res.end();
        }
    }
}

router.get('/stream/:trackId', handleStreamProxy);
router.head('/stream/:trackId', handleStreamProxy);

export default router;
