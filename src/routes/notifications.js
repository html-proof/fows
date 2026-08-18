import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.js';
import {
    saveDeviceToken,
    removeDeviceToken,
    notifyArtistNewSong,
    sendTestNotification,
} from '../services/notificationService.js';

const router = Router();

const MAX_TOKEN_LEN = 4096;
const VALID_PLATFORMS = new Set(['android', 'ios', 'web', 'unknown']);

/**
 * POST /api/notifications/register
 * Register the caller's FCM device token so they can receive push
 * notifications for new songs from artists they follow.
 *
 * Body: { token: string, platform?: 'android' | 'ios' | 'web' }
 */
router.post('/register', authenticateUser, async (req, res) => {
    try {
        const { token, platform } = req.body || {};

        if (typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ error: '"token" (FCM registration token) is required' });
        }
        if (token.length > MAX_TOKEN_LEN) {
            return res.status(400).json({ error: '"token" is too long' });
        }

        const safePlatform = VALID_PLATFORMS.has(platform) ? platform : 'unknown';
        const result = await saveDeviceToken(req.user.uid, token.trim(), safePlatform);

        res.json({ success: true, message: 'Device registered for notifications', data: result });
    } catch (error) {
        console.error('Register device token error:', error.message);
        res.status(500).json({ error: 'Failed to register device token' });
    }
});

/**
 * POST /api/notifications/unregister
 * Remove a device token (called on logout or when notifications are disabled).
 *
 * Body: { token: string }
 */
router.post('/unregister', authenticateUser, async (req, res) => {
    try {
        const { token } = req.body || {};
        if (typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ error: '"token" is required' });
        }

        await removeDeviceToken(req.user.uid, token.trim());
        res.json({ success: true, message: 'Device unregistered' });
    } catch (error) {
        console.error('Unregister device token error:', error.message);
        res.status(500).json({ error: 'Failed to unregister device token' });
    }
});

/**
 * POST /api/notifications/test
 * Send a test notification to the caller's own devices.
 */
router.post('/test', authenticateUser, async (req, res) => {
    try {
        const result = await sendTestNotification(req.user.uid);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Test notification error:', error.message);
        res.status(500).json({ error: 'Failed to send test notification' });
    }
});

/**
 * POST /api/notifications/new-song
 * Fan-out trigger: notify all followers of an artist about a new song.
 *
 * This is a privileged endpoint meant to be called by a catalog-ingestion job
 * / cron / webhook, NOT by end users. It is guarded by the ADMIN_NOTIFY_KEY
 * secret supplied via the `x-admin-key` header.
 *
 * Body: {
 *   artist: { id?: string, name?: string },   // at least one required
 *   song:   { id: string, name?: string, image?: string, album?: string }
 * }
 */
router.post('/new-song', async (req, res) => {
    const adminKey = process.env.ADMIN_NOTIFY_KEY;
    if (!adminKey) {
        return res.status(503).json({ error: 'Notification trigger is not configured' });
    }
    if (req.get('x-admin-key') !== adminKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { artist, song } = req.body || {};

        if (!artist || (typeof artist.id !== 'string' && typeof artist.name !== 'string')) {
            return res.status(400).json({ error: '"artist" with an id or name is required' });
        }
        if (!song || typeof song.id !== 'string' || !song.id.trim()) {
            return res.status(400).json({ error: '"song.id" is required' });
        }

        const result = await notifyArtistNewSong({
            artist: {
                id: artist.id ? String(artist.id).slice(0, 100) : undefined,
                name: artist.name ? String(artist.name).slice(0, 100) : undefined,
            },
            song: {
                id: String(song.id).slice(0, 100),
                name: song.name ? String(song.name).slice(0, 200) : undefined,
                image: song.image ? String(song.image).slice(0, 500) : undefined,
                album: song.album ? String(song.album).slice(0, 200) : undefined,
            },
        });

        res.json({ success: true, data: result });
    } catch (error) {
        console.error('New-song notification error:', error.message);
        res.status(500).json({ error: 'Failed to dispatch notifications' });
    }
});

export default router;
