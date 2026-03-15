import { db } from '../config/firebase.js';

const DEFAULT_ACTIVITY_LIMIT = 50;
const PROFILE_ACTIVITY_SAMPLE_SIZE = 300;
const PROFILE_SEARCH_LIMIT = 40;
const PROFILE_MAX_SONG_INTERACTIONS = 500;

// ── Trending & Collaborative Filtering constants ──
const TRENDING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const CO_LISTEN_SESSION_GAP_MS = 30 * 60 * 1000; // 30 min gap = new session
const TRENDING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache
let _trendingCache = { data: null, expiresAt: 0 };

/**
 * Save user preferences (languages, favorite artists) in RTDB.
 */
export async function saveUserPreferences(uid, { languages, favoriteArtists, displayName, email }) {
    const userRef = db.ref(`users/${uid}`);
    const updates = {
        updatedAt: Date.now(),
    };

    if (Array.isArray(languages)) {
        updates.languages = languages;
        // Duplicate to the ML-friendly key style.
        updates.preferred_language = languages;
    }
    if (Array.isArray(favoriteArtists)) {
        updates.favoriteArtists = favoriteArtists;
        // Duplicate to the ML-friendly key style.
        updates.preferred_artists = favoriteArtists;
    }
    if (displayName) updates.displayName = displayName;
    if (email) updates.email = email;

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

/**
 * Log a user activity event in RTDB and update aggregated ML features.
 */
export async function logActivity(uid, type, payload) {
    const activityRef = db.ref(`users/${uid}/activity`).push();
    const timestamp = Date.now();
    const data = {
        type,
        ...payload,
        timestamp,
    };

    await activityRef.set(data);
    await updateDerivedRealtimeNodes(uid, type, payload, timestamp);
    return { id: activityRef.key, ...data };
}

/**
 * Get recent activity from RTDB.
 */
export async function getRecentActivity(uid, type = null, limit = DEFAULT_ACTIVITY_LIMIT) {
    const safeLimit = Number.isFinite(limit)
        ? Math.max(1, Math.min(Math.floor(limit), PROFILE_ACTIVITY_SAMPLE_SIZE))
        : DEFAULT_ACTIVITY_LIMIT;
    const query = db.ref(`users/${uid}/activity`).orderByChild('timestamp');
    const snapshot = await query.limitToLast(safeLimit).get();
    if (!snapshot.exists()) return [];

    let activities = [];
    snapshot.forEach((child) => {
        activities.push({ id: child.key, ...child.val() });
    });

    activities.reverse();

    if (type) {
        activities = activities.filter(activity => activity.type === type);
    }

    return activities;
}

/**
 * Get play counts grouped by artist for a user.
 */
export async function getArtistPlayCounts(uid, limit = 20) {
    const plays = await getRecentActivity(uid, 'play', 250);
    const artistCounts = {};

    for (const play of plays) {
        if (!play.artist) continue;
        const key = normalizeText(play.artist);
        if (!key) continue;
        if (!artistCounts[key]) {
            artistCounts[key] = { artist: play.artist, count: 0 };
        }
        artistCounts[key].count += 1;
    }

    return Object.values(artistCounts)
        .sort((a, b) => b.count - a.count)
        .slice(0, Math.max(1, limit));
}

/**
 * Get recently skipped song IDs for a user.
 */
export async function getSkippedSongIds(uid, limit = 100) {
    const skips = await getRecentActivity(uid, 'skip', limit);
    return new Set(skips.map(event => event.songId).filter(Boolean));
}

/**
 * Returns normalized user-song interactions from RTDB:
 * user_activity/{uid}/{songId}
 */
export async function getUserSongInteractions(uid) {
    const snapshot = await db.ref(`user_activity/${uid}`).get();
    if (!snapshot.exists()) return {};

    const interactions = {};
    for (const [songId, value] of Object.entries(snapshot.val() || {})) {
        if (!songId || !value || typeof value !== 'object') continue;

        const playCount = Number.parseInt(value.play_count, 10) || 0;
        const skipCount = Number.parseInt(value.skip_count, 10) || 0;
        const searchClicked = Number.parseInt(value.search_clicked, 10) || 0;
        interactions[songId] = {
            songId,
            playCount,
            skipCount,
            searchClicked,
            lastPlayed: Number.parseInt(value.last_played, 10) || 0,
            affinity: playCount * 2 + searchClicked * 0.75 - skipCount * 2.5,
            artist: value.artist || '',
            language: value.language || '',
            genre: value.genre || '',
            songName: value.title || value.songName || '',
        };
    }

    return interactions;
}

/**
 * Build realtime profile features for personalized ranking.
 */
export async function getUserRealtimeProfile(uid) {
    const [prefs, recentActivity, interactions, searchHistory] = await Promise.all([
        getUserPreferences(uid),
        getRecentActivity(uid, null, PROFILE_ACTIVITY_SAMPLE_SIZE),
        getUserSongInteractions(uid),
        getUserSearchHistory(uid, PROFILE_SEARCH_LIMIT),
    ]);

    const languages = new Set();
    const languageAffinity = {};
    const artistAffinity = {};
    const searchTerms = [];
    const favoriteArtists = extractFavoriteArtists(prefs?.favoriteArtists ?? prefs?.preferred_artists);

    for (const language of normalizeStringArray(prefs?.languages ?? prefs?.preferred_language)) {
        addWeighted(languageAffinity, language, 3);
        languages.add(language);
    }

    for (const artist of favoriteArtists) {
        addWeighted(artistAffinity, artist, 5);
    }

    for (const item of searchHistory) {
        if (item.query) {
            searchTerms.push(item.query);
        }
    }

    for (const event of recentActivity) {
        if (event.type === 'search') {
            const query = normalizeText(event.query);
            if (query) {
                searchTerms.push(query);
            }
            continue;
        }

        let reward = 0;
        if (event.type === 'play') {
            reward = 1.2;
        } else if (event.type === 'skip') {
            reward = -1.5;
        } else if (event.type === 'search_click') {
            reward = 0.7;
        } else {
            continue;
        }

        const artist = normalizeText(event.artist);
        const language = normalizeText(event.language);

        if (artist) addWeighted(artistAffinity, artist, reward);
        if (language) {
            addWeighted(languageAffinity, language, reward);
            languages.add(language);
        }
    }

    // Keep profile compact.
    const compactInteractions = Object.fromEntries(
        Object.entries(interactions)
            .sort((a, b) => (b[1]?.lastPlayed ?? 0) - (a[1]?.lastPlayed ?? 0))
            .slice(0, PROFILE_MAX_SONG_INTERACTIONS)
    );

    return {
        uid,
        languages: Array.from(languages),
        languageAffinity,
        favoriteArtists,
        artistAffinity,
        searchTerms: dedupeOrdered(searchTerms).slice(0, PROFILE_SEARCH_LIMIT),
        songInteractions: compactInteractions,
        lastUpdatedAt: Date.now(),
    };
}

/**
 * Pull user search history from RTDB aggregate path.
 */
export async function getUserSearchHistory(uid, limit = PROFILE_SEARCH_LIMIT) {
    const snapshot = await db
        .ref(`users/${uid}/search_history`)
        .orderByChild('lastSearched')
        .limitToLast(Math.max(1, limit))
        .get();

    if (!snapshot.exists()) return [];

    const history = [];
    snapshot.forEach((child) => {
        const value = child.val() || {};
        const query = normalizeText(value.query);
        if (!query) return;
        history.push({
            key: child.key,
            query,
            count: Number.parseInt(value.count, 10) || 0,
            lastSearched: Number.parseInt(value.lastSearched, 10) || 0,
        });
    });

    history.sort((a, b) => b.lastSearched - a.lastSearched);
    return history.slice(0, limit);
}

async function updateDerivedRealtimeNodes(uid, type, payload, timestamp) {
    const tasks = [];

    if (type === 'search' && payload?.query) {
        tasks.push(upsertSearchHistory(uid, payload.query, timestamp));
    }

    if ((type === 'play' || type === 'skip' || type === 'search_click') && payload?.songId) {
        tasks.push(updateSongInteractionAggregate(uid, type, payload, timestamp));
        tasks.push(updateListeningHistory(uid, type, payload, timestamp));
    }

    // ── NEW: Global trending + co-listen tracking ──
    if (type === 'play' && payload?.songId) {
        tasks.push(updateGlobalTrending(payload, timestamp));
        tasks.push(updateCoListenPairs(uid, payload, timestamp));
    }

    if (tasks.length === 0) return;

    const outcomes = await Promise.allSettled(tasks);
    for (const result of outcomes) {
        if (result.status === 'rejected') {
            console.error('Realtime aggregate update failed:', result.reason?.message ?? result.reason);
        }
    }
}

async function upsertSearchHistory(uid, query, timestamp) {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return;

    const key = toRealtimeSafeKey(normalizedQuery);
    const ref = db.ref(`users/${uid}/search_history/${key}`);

    await ref.transaction((current) => {
        const value = current && typeof current === 'object' ? current : {};
        const count = (Number.parseInt(value.count, 10) || 0) + 1;
        return {
            query: normalizedQuery,
            count,
            lastSearched: timestamp,
        };
    });
}

async function updateSongInteractionAggregate(uid, type, payload, timestamp) {
    const songId = String(payload.songId || '').trim();
    if (!songId) return;

    const songRef = db.ref(`user_activity/${uid}/${songId}`);
    await songRef.transaction((current) => {
        const value = current && typeof current === 'object' ? current : {};

        const next = {
            ...value,
            songId,
            title: payload.songName || value.title || '',
            artist: payload.artist || value.artist || '',
            language: payload.language || value.language || '',
            genre: payload.genre || value.genre || '',
            updatedAt: timestamp,
        };

        if (type === 'play') {
            next.play_count = (Number.parseInt(value.play_count, 10) || 0) + 1;
            next.last_played = timestamp;
        } else if (type === 'skip') {
            next.skip_count = (Number.parseInt(value.skip_count, 10) || 0) + 1;
        } else if (type === 'search_click') {
            next.search_clicked = (Number.parseInt(value.search_clicked, 10) || 0) + 1;
        }

        return next;
    });
}

async function updateListeningHistory(uid, type, payload, timestamp) {
    const songId = String(payload.songId || '').trim();
    if (!songId) return;

    const historyRef = db.ref(`users/${uid}/listening_history/${songId}`);
    await historyRef.transaction((current) => {
        const value = current && typeof current === 'object' ? current : {};
        const next = {
            ...value,
            songId,
            songName: payload.songName || value.songName || '',
            artist: payload.artist || value.artist || '',
            language: payload.language || value.language || '',
            genre: payload.genre || value.genre || '',
            updatedAt: timestamp,
        };

        if (type === 'play') {
            next.playCount = (Number.parseInt(value.playCount, 10) || 0) + 1;
            next.lastPlayed = timestamp;
        } else if (type === 'skip') {
            next.skipCount = (Number.parseInt(value.skipCount, 10) || 0) + 1;
            next.lastSkipped = timestamp;
        }

        return next;
    });

    if (type === 'play') {
        await db.ref(`users/${uid}/liked_songs/${songId}`).set({
            songId,
            songName: payload.songName || '',
            artist: payload.artist || '',
            updatedAt: timestamp,
        });
    } else if (type === 'skip') {
        await db.ref(`users/${uid}/skipped_songs/${songId}`).set({
            songId,
            songName: payload.songName || '',
            artist: payload.artist || '',
            updatedAt: timestamp,
        });
    }
}

function extractFavoriteArtists(value) {
    const input = Array.isArray(value) ? value : [value];
    const output = [];
    for (const item of input) {
        if (!item) continue;
        if (typeof item === 'string') {
            const normalized = normalizeText(item);
            if (normalized) output.push(normalized);
            continue;
        }
        const normalized = normalizeText(item.name || item.artist || item.id);
        if (normalized) output.push(normalized);
    }
    return dedupeOrdered(output);
}

function normalizeStringArray(value) {
    const input = Array.isArray(value) ? value : [value];
    return dedupeOrdered(
        input
            .map(item => normalizeText(item))
            .filter(Boolean)
    );
}

function normalizeText(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function toRealtimeSafeKey(value) {
    return encodeURIComponent(value)
        .replace(/\./g, '%2E');
}

function addWeighted(store, key, delta) {
    if (!key) return;
    store[key] = (store[key] || 0) + delta;
}

function dedupeOrdered(values) {
    const output = [];
    const seen = new Set();
    for (const value of values) {
        if (!value || seen.has(value)) continue;
        seen.add(value);
        output.push(value);
    }
    return output;
}

// ── NEW: Global Trending Tracker ──
// Tracks play counts per song across ALL users in a rolling 24h window.
async function updateGlobalTrending(payload, timestamp) {
    const songId = String(payload.songId || '').trim();
    if (!songId) return;

    const ref = db.ref(`global_trending/${songId}`);
    await ref.transaction((current) => {
        const value = current && typeof current === 'object' ? current : {};
        return {
            ...value,
            songId,
            songName: payload.songName || value.songName || '',
            artist: payload.artist || value.artist || '',
            language: payload.language || value.language || '',
            genre: payload.genre || value.genre || '',
            playCount: (Number.parseInt(value.playCount, 10) || 0) + 1,
            lastPlayed: timestamp,
        };
    });
}

/**
 * Get globally trending songs (across all users) from the last 24 hours.
 * Results are cached for 5 minutes to reduce DB reads.
 */
export async function getGlobalTrending(limit = 50) {
    const now = Date.now();
    if (_trendingCache.data && _trendingCache.expiresAt > now) {
        return _trendingCache.data.slice(0, limit);
    }

    const snapshot = await db.ref('global_trending')
        .orderByChild('lastPlayed')
        .limitToLast(200)
        .get();

    if (!snapshot.exists()) return [];

    const cutoff = now - TRENDING_WINDOW_MS;
    const songs = [];
    snapshot.forEach((child) => {
        const value = child.val();
        if (!value || (value.lastPlayed || 0) < cutoff) return;
        songs.push(value);
    });

    songs.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
    const result = songs.slice(0, 100);
    _trendingCache = { data: result, expiresAt: now + TRENDING_CACHE_TTL_MS };
    return result.slice(0, limit);
}

// ── NEW: Co-Listen Pairs (Collaborative Filtering) ──
// Records pairs of songs played in the same session by ANY user.
async function updateCoListenPairs(uid, payload, timestamp) {
    const songId = String(payload.songId || '').trim();
    if (!songId) return;

    // Get user's last played song to form a "pair"
    const lastPlaySnap = await db.ref(`users/${uid}/last_played_song`).get();
    const lastPlayed = lastPlaySnap.exists() ? lastPlaySnap.val() : null;

    // Update last played song for next co-listen pair
    await db.ref(`users/${uid}/last_played_song`).set({
        songId,
        timestamp,
    });

    if (!lastPlayed || !lastPlayed.songId) return;
    if (lastPlayed.songId === songId) return;

    // Only link songs played within the same session (30 min window)
    if (timestamp - (lastPlayed.timestamp || 0) > CO_LISTEN_SESSION_GAP_MS) return;

    // Create a canonical pair key (alphabetically sorted to avoid duplicates)
    const pairKey = [lastPlayed.songId, songId].sort().join('__');
    const pairRef = db.ref(`co_listen_pairs/${pairKey}`);
    await pairRef.transaction((current) => {
        const value = current && typeof current === 'object' ? current : {};
        return {
            songA: [lastPlayed.songId, songId].sort()[0],
            songB: [lastPlayed.songId, songId].sort()[1],
            count: (Number.parseInt(value.count, 10) || 0) + 1,
            lastSeen: timestamp,
        };
    });
}

/**
 * Get co-listened songs for a given song ID.
 * Returns songs that are frequently played in the same session as the target song.
 */
export async function getCoListenedSongs(songId, limit = 20) {
    if (!songId) return [];

    // Search both songA and songB positions
    const [snapA, snapB] = await Promise.all([
        db.ref('co_listen_pairs')
            .orderByChild('songA')
            .equalTo(songId)
            .limitToLast(50)
            .get(),
        db.ref('co_listen_pairs')
            .orderByChild('songB')
            .equalTo(songId)
            .limitToLast(50)
            .get(),
    ]);

    const pairs = [];
    const addPairs = (snapshot) => {
        if (!snapshot.exists()) return;
        snapshot.forEach((child) => {
            const value = child.val();
            if (!value) return;
            const partnerId = value.songA === songId ? value.songB : value.songA;
            if (partnerId) {
                pairs.push({ songId: partnerId, coListenCount: value.count || 0 });
            }
        });
    };

    addPairs(snapA);
    addPairs(snapB);

    // Deduplicate and sort by co-listen count
    const deduped = new Map();
    for (const pair of pairs) {
        const existing = deduped.get(pair.songId);
        if (!existing || existing.coListenCount < pair.coListenCount) {
            deduped.set(pair.songId, pair);
        }
    }

    return Array.from(deduped.values())
        .sort((a, b) => b.coListenCount - a.coListenCount)
        .slice(0, limit);
}

/**
 * Calculate engagement depth score from duration and skip time.
 * Returns 0.0 (skipped instantly) to 1.0 (listened to completion).
 */
export function calculateEngagementDepth(payload) {
    const duration = Number(payload?.duration || 0);
    const skipTime = Number(payload?.skipTime || 0);
    const totalDuration = Number(payload?.totalDuration || 0);

    if (totalDuration > 0 && duration > 0) {
        return Math.min(1, duration / totalDuration);
    }
    if (duration > 0) {
        return Math.min(1, duration / 240);
    }
    if (skipTime > 0) {
        return Math.min(0.5, skipTime / 240);
    }

    return 0.5;
}

/**
 * Get the user's recent session plays (within the last 30 min).
 * Used for mood/session context detection.
 */
export async function getSessionPlays(uid, sessionGapMs = CO_LISTEN_SESSION_GAP_MS) {
    const now = Date.now();
    const cutoff = now - sessionGapMs;

    const snapshot = await db.ref(`users/${uid}/activity`)
        .orderByChild('timestamp')
        .startAt(cutoff)
        .limitToLast(30)
        .get();

    if (!snapshot.exists()) return [];

    const plays = [];
    snapshot.forEach((child) => {
        const value = child.val();
        if (value && value.type === 'play') {
            plays.push(value);
        }
    });

    return plays;
}

export default {
    saveUserPreferences,
    getUserPreferences,
    logActivity,
    getRecentActivity,
    getArtistPlayCounts,
    getSkippedSongIds,
    getUserSongInteractions,
    getUserSearchHistory,
    getUserRealtimeProfile,
    getGlobalTrending,
    getCoListenedSongs,
    calculateEngagementDepth,
    getSessionPlays,
};
