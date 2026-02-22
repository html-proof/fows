import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { getUserPreferences } from '../services/database.js';
import { generateRecommendations } from '../services/recommendation.js';

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
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

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

export default router;
