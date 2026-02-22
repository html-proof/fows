import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { logActivity, getRecentActivity } from '../services/database.js';

const router = Router();

/**
 * POST /api/activity/search
 * Record a search event.
 *
 * Body: { query: string }
 */
router.post('/search', authenticateUser, async (req, res) => {
    try {
        const { query } = req.body;

        if (!query) {
            return res.status(400).json({ error: '"query" is required' });
        }

        const result = await logActivity(req.user.uid, 'search', { query });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Log search activity error:', error.message);
        res.status(500).json({ error: 'Failed to log search activity' });
    }
});

/**
 * POST /api/activity/play
 * Record a song played event.
 *
 * Body: {
 *   songId: string,
 *   songName: string,
 *   artist: string,
 *   duration?: number     // seconds the user listened
 * }
 */
router.post('/play', authenticateUser, async (req, res) => {
    try {
        const { songId, songName, artist, duration } = req.body;

        if (!songId) {
            return res.status(400).json({ error: '"songId" is required' });
        }

        const payload = { songId };
        if (songName) payload.songName = songName;
        if (artist) payload.artist = artist;
        if (duration != null) payload.duration = Number(duration);

        const result = await logActivity(req.user.uid, 'play', payload);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Log play activity error:', error.message);
        res.status(500).json({ error: 'Failed to log play activity' });
    }
});

/**
 * POST /api/activity/skip
 * Record a song skipped event.
 *
 * Body: {
 *   songId: string,
 *   songName: string,
 *   artist: string,
 *   skipTime?: number     // seconds into the song when skipped
 * }
 */
router.post('/skip', authenticateUser, async (req, res) => {
    try {
        const { songId, songName, artist, skipTime } = req.body;

        if (!songId) {
            return res.status(400).json({ error: '"songId" is required' });
        }

        const payload = { songId };
        if (songName) payload.songName = songName;
        if (artist) payload.artist = artist;
        if (skipTime != null) payload.skipTime = Number(skipTime);

        const result = await logActivity(req.user.uid, 'skip', payload);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Log skip activity error:', error.message);
        res.status(500).json({ error: 'Failed to log skip activity' });
    }
});

/**
 * GET /api/activity/history
 * Get the user's recent activity history.
 *
 * Query params:
 *  - type: "search" | "play" | "skip" (optional)
 *  - limit: number (optional, default 50)
 */
router.get('/history', authenticateUser, async (req, res) => {
    try {
        const { type, limit } = req.query;
        const activities = await getRecentActivity(
            req.user.uid,
            type || null,
            limit ? parseInt(limit, 10) : 50
        );
        res.json({ success: true, data: activities });
    } catch (error) {
        console.error('Get activity history error:', error.message);
        res.status(500).json({ error: 'Failed to retrieve activity history' });
    }
});

export default router;
