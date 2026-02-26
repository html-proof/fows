const express = require('express');
const axios = require('axios');
const db = require('../firebase');

const router = express.Router();
const CANDIDATE_LIMIT = 30;

router.post('/', async (req, res) => {
    try {
        const { query, userId } = req.body || {};
        const normalizedQuery = String(query || '').trim().toLowerCase();
        if (!normalizedQuery) {
            return res.status(400).json({ error: 'query is required' });
        }
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
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
        const mlResponse = await axios.post(`${mlBaseUrl}/rank`, {
            userId,
            query: normalizedQuery,
            songs: candidates,
            topK: 10,
        }, { timeout: 5000 });

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
