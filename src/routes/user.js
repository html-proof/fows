import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { saveUserPreferences, getUserPreferences } from '../services/database.js';

const router = Router();

/**
 * POST /api/user/preferences
 * Save or update user preferences (languages, favorite artists).
 *
 * Body: {
 *   languages: string[],           // e.g. ["hindi", "english", "tamil"]
 *   favoriteArtists: { id, name }[] // e.g. [{ id: "123", name: "Arijit Singh" }]
 * }
 */
router.post('/preferences', authenticateUser, async (req, res) => {
    try {
        const { languages, favoriteArtists } = req.body;

        if (!languages && !favoriteArtists) {
            return res.status(400).json({
                error: 'At least one of "languages" or "favoriteArtists" is required',
            });
        }

        if (languages && !Array.isArray(languages)) {
            return res.status(400).json({ error: '"languages" must be an array of strings' });
        }

        if (favoriteArtists && !Array.isArray(favoriteArtists)) {
            return res.status(400).json({ error: '"favoriteArtists" must be an array' });
        }

        const result = await saveUserPreferences(req.user.uid, {
            languages,
            favoriteArtists,
            displayName: req.user.name,
            email: req.user.email,
        });

        res.json({
            success: true,
            message: 'Preferences saved successfully',
            data: result,
        });
    } catch (error) {
        console.error('Save preferences error:', error.message);
        res.status(500).json({ error: 'Failed to save preferences' });
    }
});

/**
 * GET /api/user/preferences
 * Retrieve the authenticated user's preferences.
 */
router.get('/preferences', authenticateUser, async (req, res) => {
    try {
        const prefs = await getUserPreferences(req.user.uid);

        if (!prefs) {
            return res.status(404).json({
                error: 'No preferences found',
                message: 'Please set your preferences first.',
            });
        }

        res.json({ success: true, data: prefs });
    } catch (error) {
        console.error('Get preferences error:', error.message);
        res.status(500).json({ error: 'Failed to retrieve preferences' });
    }
});

export default router;
