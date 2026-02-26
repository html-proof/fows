import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { getUserPreferences } from '../services/database.js';
import { generateRecommendations, generateNextSongRecommendations } from '../services/recommendation.js';

const router = Router();

/**
 * GET /api/recommendations
 * Get personalized song recommendations for the authenticated user.
 *
 * The recommendation engine uses:
 *  - User's language preferences (filters results)
 *  - Favorite artists (boosts their songs)
 *  - Play history (boosts frequently played artists)
 *  - Skip history (penalizes skipped songs)
 *  - Recent searches (uses as seed queries)
 *
 * Query params:
 *  - limit: number (optional, max songs to return, default 20)
 */
router.get('/', authenticateUser, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

        // Get user preferences
        const prefs = await getUserPreferences(req.user.uid);

        if (!prefs) {
            return res.status(404).json({
                error: 'No preferences found',
                message: 'Please set your preferences first via POST /api/user/preferences',
            });
        }

        // Generate recommendations
        const recommendations = await generateRecommendations(prefs, req.user.uid);

        res.json({
            success: true,
            count: Math.min(recommendations.length, limit),
            data: recommendations.slice(0, limit),
        });
    } catch (error) {
        console.error('Recommendation error:', error.message);
        res.status(500).json({ error: 'Failed to generate recommendations' });
    }
});

/**
 * POST /api/recommendations/next
 * Get "play next" recommendations based on current song.
 *
 * Body:
 * {
 *   currentSong: {
 *     songId?: string,
 *     id?: string,
 *     language?: string,
 *     genre?: string,
 *     artist?: string,
 *     album?: { id?: string, name?: string }
 *   },
 *   limit?: number
 * }
 */
router.post('/next', authenticateUser, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.body?.limit, 10) || 10, 20);
        const currentSong = req.body?.currentSong ?? req.body ?? {};
        const hasSongIdentity = currentSong?.songId || currentSong?.id;
        if (!hasSongIdentity && !currentSong?.language) {
            return res.status(400).json({
                error: 'currentSong.songId (or id) or currentSong.language is required',
            });
        }

        const recommendations = await generateNextSongRecommendations({
            uid: req.user.uid,
            currentSong,
            limit,
        });

        return res.json({
            success: true,
            count: recommendations.length,
            data: recommendations,
        });
    } catch (error) {
        console.error('Next recommendation error:', error.message);
        return res.status(500).json({ error: 'Failed to generate next-song recommendations' });
    }
});

export default router;
