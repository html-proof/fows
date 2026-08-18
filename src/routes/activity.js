import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import { logActivity, getRecentActivity } from '../services/database.js';

const router = Router();

const MAX_QUERY_LEN = 200;
const MAX_FIELD_LEN = 100;
const MAX_HISTORY_LIMIT = 300;
const ALLOWED_ACTIVITY_TYPES = new Set(['search', 'play', 'skip', 'search_click']);

// Firebase RTDB key characters that create path traversal or key errors
const FIREBASE_UNSAFE_RE = /[\/\.#$\[\]]/;

function isValidSongId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= MAX_FIELD_LEN && !FIREBASE_UNSAFE_RE.test(id);
}

function truncate(value, maxLen) {
    if (typeof value !== 'string') return value;
    return value.slice(0, maxLen);
}

/**
 * POST /api/activity/search
 * Record a search event.
 */
router.post('/search', authenticateUser, async (req, res) => {
    try {
        const { query } = req.body;
        if (!query || typeof query !== 'string') {
            return res.status(400).json({ error: '"query" is required' });
        }
        if (query.length > MAX_QUERY_LEN) {
            return res.status(400).json({ error: `"query" must be ${MAX_QUERY_LEN} characters or fewer` });
        }
        const result = await logActivity(req.user.uid, 'search', { query: truncate(query, MAX_QUERY_LEN) });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Log search activity error:', error.message);
        res.status(500).json({ error: 'Failed to log search activity' });
    }
});

/**
 * POST /api/activity/play
 * Record a song played event.
 */
router.post('/play', authenticateUser, async (req, res) => {
    try {
        const { songId, songName, artist, language, genre, duration, totalDuration, imageUrl, canonicalId } = req.body;
        if (!isValidSongId(songId)) {
            return res.status(400).json({ error: '"songId" is required and must not contain path characters' });
        }

        const payload = { songId: truncate(songId, MAX_FIELD_LEN) };
        if (songName) payload.songName = truncate(String(songName), MAX_FIELD_LEN);
        if (artist) payload.artist = truncate(String(artist), MAX_FIELD_LEN);
        if (language) payload.language = truncate(String(language), MAX_FIELD_LEN);
        if (genre) payload.genre = truncate(String(genre), MAX_FIELD_LEN);
        if (imageUrl) payload.imageUrl = truncate(String(imageUrl), MAX_FIELD_LEN);
        if (canonicalId) payload.canonicalId = truncate(String(canonicalId), MAX_FIELD_LEN);
        const parsedDuration = Number(duration);
        if (duration != null && Number.isFinite(parsedDuration)) payload.duration = parsedDuration;
        const parsedTotalDuration = Number(totalDuration);
        if (totalDuration != null && Number.isFinite(parsedTotalDuration)) payload.totalDuration = parsedTotalDuration;

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
 */
router.post('/skip', authenticateUser, async (req, res) => {
    try {
        const { songId, songName, artist, language, genre, skipTime, totalDuration } = req.body;
        if (!isValidSongId(songId)) {
            return res.status(400).json({ error: '"songId" is required and must not contain path characters' });
        }

        const payload = { songId: truncate(songId, MAX_FIELD_LEN) };
        if (songName) payload.songName = truncate(String(songName), MAX_FIELD_LEN);
        if (artist) payload.artist = truncate(String(artist), MAX_FIELD_LEN);
        if (language) payload.language = truncate(String(language), MAX_FIELD_LEN);
        if (genre) payload.genre = truncate(String(genre), MAX_FIELD_LEN);
        const parsedSkipTime = Number(skipTime);
        if (skipTime != null && Number.isFinite(parsedSkipTime)) payload.skipTime = parsedSkipTime;
        const parsedSkipTotal = Number(totalDuration);
        if (totalDuration != null && Number.isFinite(parsedSkipTotal)) payload.totalDuration = parsedSkipTotal;

        const result = await logActivity(req.user.uid, 'skip', payload);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Log skip activity error:', error.message);
        res.status(500).json({ error: 'Failed to log skip activity' });
    }
});

/**
 * POST /api/activity/search-click
 * Record which search result the user clicked.
 */
router.post('/search-click', authenticateUser, async (req, res) => {
    try {
        const { songId, songName, artist, language, genre, query, position } = req.body;
        if (!isValidSongId(songId)) {
            return res.status(400).json({ error: '"songId" is required and must not contain path characters' });
        }

        const payload = { songId: truncate(songId, MAX_FIELD_LEN) };
        if (songName) payload.songName = truncate(String(songName), MAX_FIELD_LEN);
        if (artist) payload.artist = truncate(String(artist), MAX_FIELD_LEN);
        if (language) payload.language = truncate(String(language), MAX_FIELD_LEN);
        if (genre) payload.genre = truncate(String(genre), MAX_FIELD_LEN);
        if (query) payload.query = truncate(String(query), MAX_QUERY_LEN);
        const parsedPosition = Number(position);
        if (position != null && Number.isFinite(parsedPosition)) payload.position = parsedPosition;

        const result = await logActivity(req.user.uid, 'search_click', payload);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Log search click activity error:', error.message);
        res.status(500).json({ error: 'Failed to log search click activity' });
    }
});

/**
 * GET /api/activity/history
 */
router.get('/history', authenticateUser, async (req, res) => {
    try {
        const { type, limit } = req.query;

        // Validate type against known values to prevent unexpected filter strings
        if (type && !ALLOWED_ACTIVITY_TYPES.has(type)) {
            return res.status(400).json({ error: 'Invalid activity type' });
        }

        const parsedLimit = limit ? parseInt(limit, 10) : 50;
        if (isNaN(parsedLimit) || parsedLimit < 1) {
            return res.status(400).json({ error: '"limit" must be a positive integer' });
        }

        const activities = await getRecentActivity(
            req.user.uid,
            type || null,
            Math.min(parsedLimit, MAX_HISTORY_LIMIT)
        );
        res.json({ success: true, data: activities });
    } catch (error) {
        console.error('Get activity history error:', error.message);
        res.status(500).json({ error: 'Failed to retrieve activity history' });
    }
});

export default router;
