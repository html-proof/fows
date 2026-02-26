const express = require('express');
const axios = require('axios');
const db = require('../firebase');

const router = express.Router();

router.get('/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        const [userSnap, songsSnap] = await Promise.all([
            db.ref(`users/${userId}`).once('value'),
            db.ref('songs').once('value'),
        ]);

        const userData = userSnap.val() || {};
        const songsById = songsSnap.val() || {};
        const songCatalog = Object.entries(songsById).map(([id, value]) => ({
            id,
            ...(value || {}),
        }));

        const mlBaseUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000';
        const mlResponse = await axios.post(`${mlBaseUrl}/recommend`, {
            userId,
            userData,
            songs: songCatalog,
            topK: 20,
        }, { timeout: 5000 });

        return res.json(mlResponse.data);
    } catch (error) {
        console.error('recommend route error:', error.message);
        return res.status(500).json({
            error: 'Failed to process recommendation request',
            details: error.message,
        });
    }
});

module.exports = router;
