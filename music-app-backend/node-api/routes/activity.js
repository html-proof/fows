const express = require('express');
const { db } = require('../firebase');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

router.post('/', authenticateUser, async (req, res) => {
    try {
        const { userId, songId, action } = req.body || {};
        const effectiveUserId = req.user?.uid;
        if (!effectiveUserId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        if (userId && String(userId) !== effectiveUserId) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (!songId || !action) {
            return res.status(400).json({
                error: 'songId and action are required',
            });
        }

        const normalizedAction = String(action).trim().toLowerCase();
        if (!['play', 'skip', 'like'].includes(normalizedAction)) {
            return res.status(400).json({
                error: 'action must be one of: play, skip, like',
            });
        }

        const ref = db.ref(`user_activity/${effectiveUserId}/${songId}`);
        const snapshot = await ref.once('value');
        const current = snapshot.val() || {
            play_count: 0,
            skip_count: 0,
            like_count: 0,
        };

        if (normalizedAction === 'play') current.play_count += 1;
        if (normalizedAction === 'skip') current.skip_count += 1;
        if (normalizedAction === 'like') current.like_count += 1;
        current.last_played = Date.now();

        await ref.set(current);
        return res.json({
            success: true,
            userId: effectiveUserId,
            songId,
            action: normalizedAction,
            data: current,
        });
    } catch (error) {
        console.error('activity route error:', error.message);
        return res.status(500).json({
            error: 'Failed to log activity',
            details: error.message,
        });
    }
});

module.exports = router;
