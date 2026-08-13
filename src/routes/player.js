import express from 'express';
import {
    resolvePlayableStream,
    PlaybackResolveError,
} from '../services/playbackResolver.js';

const router = express.Router();

// ─── POST & GET /player/resolve (Backward Compatible Player Resolve Endpoint) ─
// Delegates to the unified stream resolution engine.

async function handlePlayerResolve(req, res) {
    const params = {
        id: req.body?.id || req.query?.id || '',
        title: req.body?.title || req.query?.title || req.query?.q || '',
        artist: req.body?.artist || req.query?.artist || '',
        album: req.body?.album || req.query?.album || '',
        language: req.body?.language || req.query?.language || '',
    };

    if (!params.title && !params.id) {
        return res.status(400).json({
            success: false,
            error: 'Title or ID is required for stream resolution',
            code: 'BAD_REQUEST',
        });
    }

    try {
        const resolved = await resolvePlayableStream(params);
        return res.json({
            success: true,
            data: {
                trackId: resolved.id,
                streamUrl: resolved.streamUrl,
                proxyUrl: resolved.proxyUrl,
                isPlayable: true,
                bitrate: resolved.bitrate,
                contentType: resolved.contentType,
                headers: resolved.headers,
                provider: resolved.provider,
                cached: resolved.cached,
            },
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
        console.error('[player/resolve] Error:', err);
        return res.status(500).json({
            success: false,
            error: 'Failed to resolve stream',
            code: 'RESOLVER_ERROR',
        });
    }
}

router.post('/player/resolve', handlePlayerResolve);
router.get('/player/resolve', handlePlayerResolve);

export default router;
