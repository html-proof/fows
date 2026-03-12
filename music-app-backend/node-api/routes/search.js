const express = require('express');
const axios = require('axios');
const { db } = require('../firebase');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();
const CANDIDATE_LIMIT = 30;

router.post('/', authenticateUser, async (req, res) => {
    try {
        const { query, userId } = req.body || {};
        const effectiveUserId = req.user?.uid;
        if (!effectiveUserId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        if (userId && String(userId) !== effectiveUserId) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const normalizedQuery = String(query || '').trim().toLowerCase();
        if (!normalizedQuery) {
            return res.status(400).json({ error: 'query is required' });
        }

        const snapshot = await db.ref('songs').once('value');
        const songsById = snapshot.val() || {};
        const candidates = Object.entries(songsById)
            .map(([id, value]) => ({ id, ...(value || {}) }))
            .filter(song => {
                const title = String(song.title || '').toLowerCase();
                const artist = String(song.artist || '').toLowerCase();
                return title.includes(normalizedQuery) || artist.includes(normalizedQuery);
            })
            .slice(0, CANDIDATE_LIMIT);

        if (candidates.length === 0) {
            return res.json({ results: [] });
        }

        const mlBaseUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000';
        const mlApiKey = process.env.ML_SERVICE_API_KEY;
        const mlResponse = await axios.post(`${mlBaseUrl}/rank`, {
            userId: effectiveUserId,
            query: normalizedQuery,
            songs: candidates,
            topK: 10,
        }, {
            timeout: 5000,
            headers: mlApiKey ? { 'X-API-KEY': mlApiKey } : undefined,
        });

        return res.json(mlResponse.data);
    } catch (error) {
        console.error('search route error:', error.message);
        return res.status(500).json({
            error: 'Failed to process search request',
            details: error.message,
        });
    }
});

module.exports = router;
