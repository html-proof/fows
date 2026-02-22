import { db } from '../config/firebase.js';

// ─── User Preferences ──────────────────────────────────────

/**
 * Save user preferences (languages, favorite artists) in RTDB.
 */
export async function saveUserPreferences(uid, { languages, favoriteArtists, displayName, email }) {
    const userRef = db.ref(`users/${uid}`);
    const updates = {
        updatedAt: Date.now(),
    };

    if (languages) updates.languages = languages;
    if (favoriteArtists) updates.favoriteArtists = favoriteArtists;
    if (displayName) updates.displayName = displayName;
    if (email) updates.email = email;

    // Check if user exists to set createdAt
    const snapshot = await userRef.get();
    if (!snapshot.exists()) {
        updates.createdAt = Date.now();
    }

    await userRef.update(updates);
    return { uid, ...updates };
}

/**
 * Get user preferences from RTDB.
 */
export async function getUserPreferences(uid) {
    const snapshot = await db.ref(`users/${uid}`).get();
    if (!snapshot.exists()) return null;
    return { uid, ...snapshot.val() };
}

// ─── Activity Tracking ─────────────────────────────────────

/**
 * Log a user activity event in RTDB.
 */
export async function logActivity(uid, type, payload) {
    const activityRef = db.ref(`users/${uid}/activity`).push();
    const data = {
        type,
        ...payload,
        timestamp: Date.now(),
    };

    await activityRef.set(data);
    return { id: activityRef.key, ...data };
}

/**
 * Get recent activity from RTDB.
 */
export async function getRecentActivity(uid, type = null, limit = 50) {
    let query = db.ref(`users/${uid}/activity`).orderByChild('timestamp');

    // RTDB doesn't support complex filtering well, so we might need to filter manually if type is specified
    const snapshot = await query.limitToLast(limit).get();
    if (!snapshot.exists()) return [];

    let activities = [];
    snapshot.forEach((child) => {
        activities.push({ id: child.key, ...child.val() });
    });

    // reverse for most recent first
    activities.reverse();

    if (type) {
        activities = activities.filter(a => a.type === type);
    }

    return activities;
}

/**
 * Get play counts grouped by artist for a user (RTDB version).
 */
export async function getArtistPlayCounts(uid, limit = 20) {
    const plays = await getRecentActivity(uid, 'play', 200);
    const artistCounts = {};

    for (const play of plays) {
        if (play.artist) {
            const key = play.artist.toLowerCase();
            if (!artistCounts[key]) {
                artistCounts[key] = { artist: play.artist, count: 0 };
            }
            artistCounts[key].count++;
        }
    }

    return Object.values(artistCounts)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

/**
 * Get recently skipped song IDs for a user (RTDB version).
 */
export async function getSkippedSongIds(uid, limit = 100) {
    const skips = await getRecentActivity(uid, 'skip', limit);
    return new Set(skips.map(s => s.songId).filter(Boolean));
}

export default {
    saveUserPreferences,
    getUserPreferences,
    logActivity,
    getRecentActivity,
    getArtistPlayCounts,
    getSkippedSongIds,
};


