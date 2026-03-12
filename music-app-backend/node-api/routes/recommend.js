const express = require('express');
const axios = require('axios');
const { db } = require('../firebase');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

router.get('/:userId', authenticateUser, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }
        if (userId !== req.user?.uid) {
            return res.status(403).json({ error: 'Forbidden' });
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
        const mlApiKey = process.env.ML_SERVICE_API_KEY;
        const mlResponse = await axios.post(`${mlBaseUrl}/recommend`, {
            userId,
            userData,
            songs: songCatalog,
            topK: 20,
        }, {
            timeout: 5000,
            headers: mlApiKey ? { 'X-API-KEY': mlApiKey } : undefined,
        });

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
