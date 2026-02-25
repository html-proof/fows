import { Router } from 'express';
import {
    searchSongsOnly,
    searchSongsSmart,
    searchArtists,
    getArtistsByLanguage,
    getArtistAlbums,
    getSongById,
    getAlbumById,
    searchAlbums,
} from '../services/saavnApi.js';
import { auth } from '../config/firebase.js';
import { getUserPreferences } from '../services/database.js';

const router = Router();
const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 10;
const MAX_LIMIT = 20;
const USER_LANGUAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_LANGUAGE_CACHE_MAX_ENTRIES = 300;
const userLanguageCache = new Map();

// Search API (public)
// Example: /api/search?query=Imagine+Dragons&page=2
router.get('/search', async (req, res) => {
    try {
        const query = normalizeSearchQuery(req.query.query);
        if (!query) {
            return res.status(400).json({ error: 'Query parameter "query" is required' });
        }

        const preferredLanguages = await resolvePreferredLanguages(req);
        const parsedPage = parseInt(req.query.page, 10);
        const page = Number.isNaN(parsedPage) ? 1 : Math.max(parsedPage, 1);
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isNaN(parsedLimit)
            ? DEFAULT_LIMIT
            : Math.max(MIN_LIMIT, Math.min(parsedLimit, MAX_LIMIT));

        // For page > 1, only fetch songs. This powers "load more" efficiently.
        if (page > 1) {
            const songsData = await searchSongsOnly(query, page);
            const songs = prioritizeSongsByLanguage(
                songsData?.data?.results ?? [],
                preferredLanguages
            ).slice(0, limit);
            return res.json({
                success: true,
                data: {
                    songs,
                    albums: [],
                    artists: [],
                },
            });
        }

        // First page returns songs + albums + artists
        const [songsData, albumsData, artistsData] = await Promise.allSettled([
            searchSongsSmart(query, { preferredLanguages }),
            searchAlbums(query),
            searchArtists(query),
        ]);

        const songs = songsData.status === 'fulfilled'
            ? songsData.value ?? []
            : [];
        const orderedSongs = prioritizeSongsByLanguage(songs, preferredLanguages);

        res.json({
            success: true,
            data: {
                songs: orderedSongs.slice(0, limit),
                albums: albumsData.status === 'fulfilled'
                    ? (albumsData.value?.data?.results ?? []).slice(0, limit)
                    : [],
                artists: artistsData.status === 'fulfilled'
                    ? (artistsData.value?.data?.results ?? []).slice(0, limit)
                    : [],
            },
        });
    } catch (error) {
        console.error('Search API error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function normalizeSearchQuery(value) {
    return String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ');
}

function parsePreferredLanguages(value) {
    const values = Array.isArray(value)
        ? value
        : String(value ?? '')
            .split(',');

    return values
        .map(language => language.trim().toLowerCase())
        .filter(Boolean);
}

function parsePreferredLanguagesFromArray(value) {
    const values = Array.isArray(value) ? value : [value];
    return values
        .map(language => String(language ?? '').trim().toLowerCase())
        .filter(Boolean);
}

async function resolvePreferredLanguages(req) {
    const queryLanguages = parsePreferredLanguages(req.query.languages);
    if (queryLanguages.length > 0) return queryLanguages;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return [];

    const idToken = authHeader.slice('Bearer '.length).trim();
    if (!idToken) return [];

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        const uid = decodedToken?.uid;
        if (!uid) return [];

        const cached = getCachedUserLanguages(uid);
        if (cached) return cached;

        const preferences = await getUserPreferences(uid);
        const languages = parsePreferredLanguagesFromArray(preferences?.languages);
        setCachedUserLanguages(uid, languages);
        return languages;
    } catch (_error) {
        return [];
    }
}

function prioritizeSongsByLanguage(songs, preferredLanguages) {
    if (!Array.isArray(songs) || songs.length === 0) return [];
    if (!Array.isArray(preferredLanguages) || preferredLanguages.length === 0) {
        return songs;
    }

    const preferredSet = new Set(preferredLanguages);
    const preferred = [];
    const remaining = [];

    for (const song of songs) {
        const language = String(song?.language ?? '').trim().toLowerCase();
        if (preferredSet.has(language)) {
            preferred.push(song);
        } else {
            remaining.push(song);
        }
    }

    return [...preferred, ...remaining];
}

function getCachedUserLanguages(uid) {
    const item = userLanguageCache.get(uid);
    if (!item) return null;

    const now = Date.now();
    if (item.expiresAt <= now) {
        userLanguageCache.delete(uid);
        return null;
    }

    item.lastAccessAt = now;
    return item.languages;
}

function setCachedUserLanguages(uid, languages) {
    const normalizedLanguages = parsePreferredLanguagesFromArray(languages);
    const now = Date.now();
    userLanguageCache.set(uid, {
        languages: normalizedLanguages,
        expiresAt: now + USER_LANGUAGE_CACHE_TTL_MS,
        lastAccessAt: now,
    });
    trimUserLanguageCache();
}

function trimUserLanguageCache() {
    if (userLanguageCache.size <= USER_LANGUAGE_CACHE_MAX_ENTRIES) return;

    let oldestKey = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, value] of userLanguageCache.entries()) {
        const lastAccessAt = value?.lastAccessAt ?? 0;
        if (lastAccessAt < oldestAccess) {
            oldestAccess = lastAccessAt;
            oldestKey = key;
        }
    }

    if (oldestKey) {
        userLanguageCache.delete(oldestKey);
    }
}

// Stream / Song Details API (public)
// Example: /api/songs/:id
router.get('/songs/:id', async (req, res) => {
    try {
        const data = await getSongById(req.params.id);
        res.json(data);
    } catch (error) {
        console.error('Song API error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Album API (public)
// Example 1: /api/albums?id=xxxxxxx
// Example 2: /api/albums?query=Evolve
router.get('/albums', async (req, res) => {
    try {
        const { id, query } = req.query;

        if (!id && !query) {
            return res.status(400).json({ error: 'Either "id" or "query" parameter is required' });
        }

        let data;
        if (id) {
            data = await getAlbumById(id);
        } else {
            data = await searchAlbums(query);
        }

        res.json(data);
    } catch (error) {
        console.error('Album API error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Artist Search by Language (Public)
// Used during onboarding to show artists after language selection
// Example: /api/artists/by-language?language=hindi
router.get('/artists/by-language', async (req, res) => {
    try {
        const { language } = req.query;
        if (!language) {
            return res.status(400).json({ error: 'Query parameter "language" is required' });
        }
        const data = await getArtistsByLanguage(language);
        res.json({ success: true, count: data.length, data });
    } catch (error) {
        console.error('Artists by language error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Artist albums by artist ID (public)
// Example: /api/artists/459320/albums?limit=20&page=1
router.get('/artists/:id/albums', async (req, res) => {
    try {
        const artistId = req.params.id?.trim();
        if (!artistId) {
            return res.status(400).json({ error: 'Artist "id" parameter is required' });
        }

        const parsedLimit = parseInt(req.query.limit, 10);
        const parsedPage = parseInt(req.query.page, 10);
        const limit = Number.isNaN(parsedLimit) ? 20 : Math.max(1, Math.min(parsedLimit, 50));
        const page = Number.isNaN(parsedPage) ? 1 : Math.max(parsedPage, 1);

        const data = await getArtistAlbums(artistId, { limit, page });
        return res.json(data);
    } catch (error) {
        console.error('Artist albums API error:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
