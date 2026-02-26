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
import { rerankSongsForUser } from '../services/personalizationModel.js';

const router = Router();
const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 10;
const MAX_LIMIT = 20;
const MAX_RELATED_LANGUAGES = 5;
const MAX_ALBUM_LANGUAGE_BUCKETS = 4;
const USER_LANGUAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_LANGUAGE_CACHE_MAX_ENTRIES = 300;
const userLanguageCache = new Map();
const LANGUAGE_HINTS = new Set([
    'hindi',
    'malayalam',
    'tamil',
    'telugu',
    'kannada',
    'english',
    'punjabi',
    'marathi',
    'bengali',
    'gujarati',
    'odia',
    'assamese',
    'urdu',
]);

// Search API (public)
// Example: /api/search?query=Imagine+Dragons&page=2
router.get('/search', async (req, res) => {
    try {
        const query = normalizeSearchQuery(req.query.query);
        if (!query) {
            return res.status(400).json({ error: 'Query parameter "query" is required' });
        }

        const { uid, preferredLanguages } = await resolveUserContext(req);
        const parsedPage = parseInt(req.query.page, 10);
        const page = Number.isNaN(parsedPage) ? 1 : Math.max(parsedPage, 1);
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isNaN(parsedLimit)
            ? DEFAULT_LIMIT
            : Math.max(MIN_LIMIT, Math.min(parsedLimit, MAX_LIMIT));

        // For page > 1, only fetch songs. This powers "load more" efficiently.
        if (page > 1) {
            const songsData = await searchSongsOnly(query, page);
            const baseSongs = prioritizeSongsByLanguage(
                songsData?.data?.results ?? [],
                preferredLanguages
            );
            const rankedSongs = uid
                ? await rerankSongsForUser({
                    uid,
                    songs: baseSongs,
                    query,
                    preferredLanguages,
                    mode: 'search',
                })
                : baseSongs;
            const songs = rankedSongs.slice(0, limit);
            const relatedLanguages = buildRelatedLanguages({
                query,
                preferredLanguages,
                songs,
                albums: [],
            });
            return res.json({
                success: true,
                data: {
                    songs,
                    albums: [],
                    artists: [],
                    topResult: songs.length > 0
                        ? { type: 'song', data: songs[0] }
                        : null,
                    relatedLanguages,
                    albumLanguageSections: [],
                    sections: buildSearchSections({
                        songs,
                        albums: [],
                        artists: [],
                        topResult: songs.length > 0
                            ? { type: 'song', data: songs[0] }
                            : null,
                        albumLanguageSections: [],
                    }),
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
        const rankedSongs = uid
            ? await rerankSongsForUser({
                uid,
                songs: orderedSongs,
                query,
                preferredLanguages,
                mode: 'search',
            })
            : orderedSongs;

        const songsOut = rankedSongs.slice(0, limit);
        const albumsOut = albumsData.status === 'fulfilled'
            ? (albumsData.value?.data?.results ?? []).slice(0, limit)
            : [];
        const artistsOut = artistsData.status === 'fulfilled'
            ? (artistsData.value?.data?.results ?? []).slice(0, limit)
            : [];

        const relatedLanguages = buildRelatedLanguages({
            query,
            preferredLanguages,
            songs: songsOut,
            albums: albumsOut,
        });
        const albumLanguageSections = buildAlbumLanguageSections({
            albums: albumsOut,
            songs: songsOut,
            relatedLanguages,
            maxBuckets: MAX_ALBUM_LANGUAGE_BUCKETS,
        });
        const topResult = resolveTopResult({
            query,
            songs: songsOut,
            albums: albumsOut,
            artists: artistsOut,
        });

        res.json({
            success: true,
            data: {
                songs: songsOut,
                albums: albumsOut,
                artists: artistsOut,
                topResult,
                relatedLanguages,
                albumLanguageSections,
                sections: buildSearchSections({
                    songs: songsOut,
                    albums: albumsOut,
                    artists: artistsOut,
                    topResult,
                    albumLanguageSections,
                }),
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

async function resolveUserContext(req) {
    const queryLanguages = parsePreferredLanguages(req.query.languages);
    const idToken = extractBearerToken(req);
    if (!idToken) {
        return {
            uid: null,
            preferredLanguages: queryLanguages,
        };
    }

    try {
        const decodedToken = await auth.verifyIdToken(idToken);
        const uid = decodedToken?.uid || null;
        if (!uid) {
            return {
                uid: null,
                preferredLanguages: queryLanguages,
            };
        }

        if (queryLanguages.length > 0) {
            return {
                uid,
                preferredLanguages: queryLanguages,
            };
        }

        const cached = getCachedUserLanguages(uid);
        if (cached) {
            return {
                uid,
                preferredLanguages: cached,
            };
        }

        const preferences = await getUserPreferences(uid);
        const languages = parsePreferredLanguagesFromArray(preferences?.languages ?? preferences?.preferred_language);
        setCachedUserLanguages(uid, languages);
        return {
            uid,
            preferredLanguages: languages,
        };
    } catch (_error) {
        return {
            uid: null,
            preferredLanguages: queryLanguages,
        };
    }
}

function extractBearerToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return '';
    return authHeader.slice('Bearer '.length).trim();
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

function buildRelatedLanguages({
    query,
    preferredLanguages,
    songs,
    albums,
}) {
    const scoreByLanguage = new Map();
    const add = (language, score) => {
        const normalized = normalizeLanguage(language);
        if (!normalized) return;
        scoreByLanguage.set(normalized, (scoreByLanguage.get(normalized) ?? 0) + score);
    };

    for (const language of preferredLanguages ?? []) {
        add(language, 4);
    }

    for (const hint of detectLanguageHints(query)) {
        add(hint, 6);
    }

    for (const song of songs ?? []) {
        add(song?.language, 2);
    }

    for (const album of albums ?? []) {
        add(album?.language, 1.2);
    }

    return Array.from(scoreByLanguage.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([language]) => language)
        .slice(0, MAX_RELATED_LANGUAGES);
}

function detectLanguageHints(query) {
    const hints = [];
    const tokens = String(query ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);

    for (const token of tokens) {
        if (LANGUAGE_HINTS.has(token)) {
            hints.push(token);
        }
    }

    return hints;
}

function buildAlbumLanguageSections({
    albums,
    songs,
    relatedLanguages,
    maxBuckets,
}) {
    const songAlbumLanguageMap = buildSongAlbumLanguageMap(songs ?? []);
    const grouped = new Map();
    const fallbackLanguage = Array.isArray(relatedLanguages) && relatedLanguages.length > 0
        ? relatedLanguages[0]
        : null;

    for (const album of albums ?? []) {
        const language = resolveAlbumLanguage(album, songAlbumLanguageMap, fallbackLanguage);
        if (!language) continue;

        if (!grouped.has(language)) {
            grouped.set(language, []);
        }

        grouped.get(language).push({
            ...album,
            _resolvedLanguage: language,
        });
    }

    const prioritizedOrder = [
        ...(relatedLanguages ?? []).map(normalizeLanguage).filter(Boolean),
        ...Array.from(grouped.keys()),
    ];

    const uniqueOrder = [];
    const seen = new Set();
    for (const language of prioritizedOrder) {
        if (!language || seen.has(language)) continue;
        seen.add(language);
        uniqueOrder.push(language);
    }

    return uniqueOrder
        .slice(0, Math.max(1, maxBuckets))
        .map(language => ({
            language,
            count: grouped.get(language)?.length ?? 0,
            albums: grouped.get(language) ?? [],
        }))
        .filter(section => section.count > 0);
}

function buildSongAlbumLanguageMap(songs) {
    const map = new Map();

    for (const song of songs ?? []) {
        const albumId = String(song?.album?.id ?? '').trim();
        const language = normalizeLanguage(song?.language);
        if (!albumId || !language) continue;

        if (!map.has(albumId)) {
            map.set(albumId, new Map());
        }

        const counts = map.get(albumId);
        counts.set(language, (counts.get(language) ?? 0) + 1);
    }

    return map;
}

function resolveAlbumLanguage(album, songAlbumLanguageMap, fallbackLanguage) {
    const explicit = normalizeLanguage(album?.language);
    if (explicit) return explicit;

    const albumId = String(album?.id ?? '').trim();
    if (albumId && songAlbumLanguageMap.has(albumId)) {
        const counts = Array.from(songAlbumLanguageMap.get(albumId).entries())
            .sort((a, b) => b[1] - a[1]);
        if (counts.length > 0) {
            return counts[0][0];
        }
    }

    const hinted = detectLanguageHints(album?.name ?? '')[0];
    if (hinted) return hinted;

    return normalizeLanguage(fallbackLanguage);
}

function resolveTopResult({
    query,
    songs,
    albums,
    artists,
}) {
    const candidates = [];

    const addCandidate = (type, item) => {
        if (!item) return;
        const name = type === 'song'
            ? (item?.name ?? item?.title)
            : item?.name;
        const score = scoreTopResultCandidate(name, query);
        candidates.push({
            type,
            data: item,
            score,
        });
    };

    addCandidate('song', songs?.[0]);
    addCandidate('artist', artists?.[0]);
    addCandidate('album', albums?.[0]);

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);
    return {
        type: candidates[0].type,
        data: candidates[0].data,
    };
}

function scoreTopResultCandidate(name, query) {
    const normalizedName = String(name ?? '')
        .toLowerCase()
        .trim();
    const normalizedQuery = String(query ?? '')
        .toLowerCase()
        .trim();

    if (!normalizedName || !normalizedQuery) return 0;
    if (normalizedName === normalizedQuery) return 1;
    if (normalizedName.startsWith(normalizedQuery)) return 0.95;
    if (normalizedName.includes(normalizedQuery)) return 0.85;

    const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryTerms.length === 0) return 0.5;

    let hits = 0;
    for (const term of queryTerms) {
        if (normalizedName.includes(term)) {
            hits += 1;
        }
    }

    return hits / queryTerms.length;
}

function buildSearchSections({
    songs,
    albums,
    artists,
    topResult,
    albumLanguageSections,
}) {
    const sections = [];

    if (topResult) {
        sections.push({
            id: 'top-result',
            type: 'topResult',
            title: 'Top result',
            data: [topResult],
        });
    }

    sections.push({
        id: 'songs',
        type: 'songs',
        title: 'Songs',
        data: songs ?? [],
    });

    sections.push({
        id: 'artists',
        type: 'artists',
        title: 'Artists',
        data: artists ?? [],
    });

    sections.push({
        id: 'albums',
        type: 'albums',
        title: 'Albums',
        data: albums ?? [],
    });

    if (Array.isArray(albumLanguageSections) && albumLanguageSections.length > 0) {
        sections.push({
            id: 'albums-by-language',
            type: 'albumsByLanguage',
            title: 'Albums by related language',
            data: albumLanguageSections,
        });
    }

    return sections;
}

function normalizeLanguage(value) {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase();
    return normalized || '';
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
