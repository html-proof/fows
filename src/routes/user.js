import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { saveUserPreferences, getUserPreferences } from '../services/database.js';

const router = Router();

const MAX_LANGUAGES = 20;
const MAX_FAVORITE_ARTISTS = 200;
const MAX_LANG_LEN = 50;
const MAX_ARTIST_NAME_LEN = 100;
const MAX_ARTIST_ID_LEN = 100;

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

        if (languages && languages.length > MAX_LANGUAGES) {
            return res.status(400).json({ error: `"languages" may contain at most ${MAX_LANGUAGES} entries` });
        }

        if (languages && languages.some(l => typeof l !== 'string' || l.length > MAX_LANG_LEN)) {
            return res.status(400).json({ error: `Each language must be a string of at most ${MAX_LANG_LEN} characters` });
        }

        if (favoriteArtists && !Array.isArray(favoriteArtists)) {
            return res.status(400).json({ error: '"favoriteArtists" must be an array' });
        }

        if (favoriteArtists && favoriteArtists.length > MAX_FAVORITE_ARTISTS) {
            return res.status(400).json({ error: `"favoriteArtists" may contain at most ${MAX_FAVORITE_ARTISTS} entries` });
        }

        // Sanitize artist entries — only allow known shape
        const sanitizedArtists = favoriteArtists
            ? favoriteArtists.map(a => ({
                id: String(a?.id ?? '').slice(0, MAX_ARTIST_ID_LEN),
                name: String(a?.name ?? '').slice(0, MAX_ARTIST_NAME_LEN),
            }))
            : undefined;

        const result = await saveUserPreferences(req.user.uid, {
            languages,
            favoriteArtists: sanitizedArtists,
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
