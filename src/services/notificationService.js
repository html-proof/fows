import { db, messaging } from '../config/firebase.js';

/**
 * Push-notification service.
 *
 * Two data structures back this feature:
 *
 *   users/{uid}/fcm_tokens/{tokenKey}   → { token, platform, updatedAt }
 *   artist_followers/{artistKey}/{uid}  → true
 *
 * The `artist_followers` index is the reverse of each user's favouriteArtists
 * list. It lets us answer "who follows this artist?" in a single keyed read
 * instead of scanning every user. The index is kept in sync from
 * saveUserPreferences → syncArtistFollowerIndex.
 *
 * A single artist is indexed under MULTIPLE keys so that a new-song trigger can
 * match by JioSaavn id OR by name (whichever the caller has):
 *   id:<artistId>        when the favourite has an id
 *   nm:<normalizedName>  always, when a name is present
 */

const FCM_MULTICAST_CHUNK = 500;        // FCM hard limit per multicast call
const MAX_TOKENS_PER_USER = 15;         // prune oldest beyond this

// ── Key helpers ────────────────────────────────────────────────────────────

function normalizeText(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

/** Make a string safe for use as an RTDB key (no . # $ [ ] /). */
function toSafeKey(value) {
    return encodeURIComponent(String(value ?? ''))
        .replace(/\./g, '%2E')
        .replace(/\*/g, '%2A')
        .slice(0, 512);
}

/**
 * All follower-index keys an artist should be listed under.
 * @param {{ id?: string, name?: string }} artist
 * @returns {string[]}
 */
export function artistKeys(artist) {
    if (!artist) return [];
    const keys = [];
    const id = String(artist.id ?? '').trim();
    const name = normalizeText(artist.name);
    if (id) keys.push(`id:${toSafeKey(id)}`);
    if (name) keys.push(`nm:${toSafeKey(name)}`);
    return dedupe(keys);
}

function dedupe(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

// ── Device-token registration ──────────────────────────────────────────────

/**
 * Register (or refresh) an FCM device token for a user.
 */
export async function saveDeviceToken(uid, token, platform = 'unknown') {
    const cleanToken = String(token ?? '').trim();
    if (!uid || !cleanToken) {
        throw new Error('uid and token are required');
    }

    const tokenKey = toSafeKey(cleanToken);
    const now = Date.now();

    await db.ref(`users/${uid}/fcm_tokens/${tokenKey}`).set({
        token: cleanToken,
        platform: String(platform || 'unknown').slice(0, 32),
        updatedAt: now,
    });

    // Keep the per-user token set bounded — drop the least-recently-updated.
    await pruneUserTokens(uid);

    return { uid, tokenKey, updatedAt: now };
}

/**
 * Remove a device token (called on logout / token invalidation).
 */
export async function removeDeviceToken(uid, token) {
    const cleanToken = String(token ?? '').trim();
    if (!uid || !cleanToken) return;
    await db.ref(`users/${uid}/fcm_tokens/${toSafeKey(cleanToken)}`).remove();
}

/** Return the raw token strings registered for a user. */
export async function getUserTokens(uid) {
    const snap = await db.ref(`users/${uid}/fcm_tokens`).get();
    if (!snap.exists()) return [];
    return Object.values(snap.val() || {})
        .map(entry => (entry && typeof entry === 'object' ? entry.token : null))
        .filter(Boolean);
}

async function pruneUserTokens(uid) {
    const snap = await db.ref(`users/${uid}/fcm_tokens`).get();
    if (!snap.exists()) return;

    const entries = Object.entries(snap.val() || {});
    if (entries.length <= MAX_TOKENS_PER_USER) return;

    entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    const stale = entries.slice(MAX_TOKENS_PER_USER);

    const updates = {};
    for (const [key] of stale) {
        updates[`users/${uid}/fcm_tokens/${key}`] = null;
    }
    await db.ref().update(updates);
}

// ── Artist follower index ──────────────────────────────────────────────────

/**
 * Sync the reverse artist→followers index for a user after their favourite
 * artists change. Diffs the previous key set (persisted at
 * users/{uid}/_follower_keys) against the new one so stale memberships are
 * removed and new ones added in a single multi-path update.
 *
 * @param {string} uid
 * @param {Array<{ id?: string, name?: string }>} favoriteArtists
 */
export async function syncArtistFollowerIndex(uid, favoriteArtists) {
    if (!uid) return;
    const artists = Array.isArray(favoriteArtists) ? favoriteArtists : [];

    const desiredKeys = dedupe(artists.flatMap(a => artistKeys(a)));

    const prevSnap = await db.ref(`users/${uid}/_follower_keys`).get();
    const prevKeys = prevSnap.exists() && Array.isArray(prevSnap.val())
        ? prevSnap.val()
        : [];

    const desiredSet = new Set(desiredKeys);
    const prevSet = new Set(prevKeys);

    const updates = {};
    // Add memberships that are new.
    for (const key of desiredKeys) {
        if (!prevSet.has(key)) updates[`artist_followers/${key}/${uid}`] = true;
    }
    // Remove memberships the user dropped.
    for (const key of prevKeys) {
        if (!desiredSet.has(key)) updates[`artist_followers/${key}/${uid}`] = null;
    }

    updates[`users/${uid}/_follower_keys`] = desiredKeys;

    if (Object.keys(updates).length > 0) {
        await db.ref().update(updates);
    }
}

/**
 * Collect the set of uids that follow an artist, matching by any of the
 * artist's keys (id and/or name).
 */
export async function getArtistFollowers(artist) {
    const keys = artistKeys(artist);
    if (keys.length === 0) return [];

    const snaps = await Promise.all(
        keys.map(key => db.ref(`artist_followers/${key}`).get())
    );

    const followers = new Set();
    for (const snap of snaps) {
        if (!snap.exists()) continue;
        for (const uid of Object.keys(snap.val() || {})) followers.add(uid);
    }
    return Array.from(followers);
}

// ── New-song fan-out ───────────────────────────────────────────────────────

/**
 * Notify every follower of an artist that a new song is available.
 *
 * @param {object} params
 * @param {{ id?: string, name?: string }} params.artist
 * @param {{ id?: string, name?: string, image?: string, album?: string }} params.song
 * @returns {Promise<{ followers: number, tokens: number, sent: number, failed: number, skipped?: boolean }>}
 */
export async function notifyArtistNewSong({ artist, song }) {
    if (!artist || (!artist.id && !artist.name)) {
        throw new Error('artist.id or artist.name is required');
    }
    if (!song || !song.id) {
        throw new Error('song.id is required');
    }

    // De-dup: only ever notify once per (artist,song) pair.
    const dedupKey = `${artistKeys(artist)[0] || 'na'}__${toSafeKey(song.id)}`;
    const claimed = await claimNotification(dedupKey);
    if (!claimed) {
        return { followers: 0, tokens: 0, sent: 0, failed: 0, skipped: true };
    }

    const followers = await getArtistFollowers(artist);
    if (followers.length === 0) {
        return { followers: 0, tokens: 0, sent: 0, failed: 0 };
    }

    // Gather tokens for all followers, remembering which uid owns each token so
    // invalid tokens can be pruned after the send.
    const tokenOwners = new Map(); // token → uid
    const tokenSnaps = await Promise.all(
        followers.map(uid => getUserTokens(uid).then(tokens => ({ uid, tokens })))
    );
    for (const { uid, tokens } of tokenSnaps) {
        for (const token of tokens) {
            if (!tokenOwners.has(token)) tokenOwners.set(token, uid);
        }
    }

    const tokens = Array.from(tokenOwners.keys());
    if (tokens.length === 0) {
        return { followers: followers.length, tokens: 0, sent: 0, failed: 0 };
    }

    const artistName = String(artist.name || 'An artist you follow');
    const songName = String(song.name || 'a new song');

    const payload = {
        notification: {
            title: `New from ${artistName}`,
            body: `${songName} is out now. Tap to listen.`,
        },
        data: {
            type: 'new_song',
            songId: String(song.id),
            songName,
            artistId: String(artist.id || ''),
            artistName,
            album: String(song.album || ''),
            image: String(song.image || ''),
        },
        android: {
            priority: 'high',
            notification: {
                channelId: 'new_music',
                sound: 'default',
            },
        },
        apns: {
            payload: { aps: { sound: 'default' } },
        },
    };

    let sent = 0;
    let failed = 0;
    const invalidTokens = [];

    for (let i = 0; i < tokens.length; i += FCM_MULTICAST_CHUNK) {
        const chunk = tokens.slice(i, i + FCM_MULTICAST_CHUNK);
        let response;
        try {
            response = await messaging.sendEachForMulticast({ ...payload, tokens: chunk });
        } catch (err) {
            console.error('FCM multicast failed:', err?.message ?? err);
            failed += chunk.length;
            continue;
        }

        sent += response.successCount;
        failed += response.failureCount;

        response.responses.forEach((resp, idx) => {
            if (resp.success) return;
            const code = resp.error?.code || '';
            if (
                code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token' ||
                code === 'messaging/invalid-argument'
            ) {
                invalidTokens.push(chunk[idx]);
            }
        });
    }

    await pruneInvalidTokens(invalidTokens, tokenOwners);

    return { followers: followers.length, tokens: tokens.length, sent, failed };
}

/**
 * Atomically claim the right to notify for a given dedup key. Returns true if
 * this caller won the claim (i.e. no notification has been sent yet).
 */
async function claimNotification(dedupKey) {
    const ref = db.ref(`sent_notifications/${dedupKey}`);
    const result = await ref.transaction((current) => {
        if (current && current.notifiedAt) return; // abort — already claimed
        return { notifiedAt: Date.now() };
    });
    return result.committed && result.snapshot.exists();
}

async function pruneInvalidTokens(invalidTokens, tokenOwners) {
    if (invalidTokens.length === 0) return;
    const updates = {};
    for (const token of invalidTokens) {
        const uid = tokenOwners.get(token);
        if (!uid) continue;
        updates[`users/${uid}/fcm_tokens/${toSafeKey(token)}`] = null;
    }
    if (Object.keys(updates).length > 0) {
        try {
            await db.ref().update(updates);
        } catch (err) {
            console.error('Failed to prune invalid FCM tokens:', err?.message ?? err);
        }
    }
}

/**
 * Send a single test notification to one user's devices. Handy for verifying a
 * client's registration end-to-end.
 */
export async function sendTestNotification(uid) {
    const tokens = await getUserTokens(uid);
    if (tokens.length === 0) return { tokens: 0, sent: 0, failed: 0 };

    const response = await messaging.sendEachForMulticast({
        tokens,
        notification: {
            title: 'Notifications are on 🎵',
            body: "You'll now hear about new songs from artists you follow.",
        },
        data: { type: 'test' },
        android: { priority: 'high', notification: { channelId: 'new_music' } },
    });

    return { tokens: tokens.length, sent: response.successCount, failed: response.failureCount };
}

export default {
    saveDeviceToken,
    removeDeviceToken,
    getUserTokens,
    syncArtistFollowerIndex,
    getArtistFollowers,
    notifyArtistNewSong,
    sendTestNotification,
    artistKeys,
};
