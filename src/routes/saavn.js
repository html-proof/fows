import { Router } from 'express';
import {
    searchSongsOnly,
    searchSongsSmart,
    searchArtists,
    getArtistsByLanguage,
    getArtistAlbums,
    getArtistById,
    getArtistSongs,
    getSongById,
    getAlbumById,
    searchAlbums,
    getLyricsBySongId,
} from '../services/saavnApi.js';
import { auth } from '../config/firebase.js';
import {
    analyzeQuery,
    buildSearchVariants,
    rankSongs,
    deduplicateSongs,
    resolveTopResult as engineResolveTopResult,
} from '../services/searchEngine.js';
import { getUserPreferences } from '../services/database.js';
import { rerankSongsForUser } from '../services/personalizationModel.js';
import { searchItunes, enrichSongsWithItunes, buildItunesQueries } from '../services/itunesService.js';
import { attachCanonicalIds } from '../services/identityResolver.js';

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
        const rawQuery = normalizeSearchQuery(req.query.query);
        if (!rawQuery) {
            return res.status(400).json({ error: 'Query parameter "query" is required' });
        }

        const { uid, preferredLanguages } = await resolveUserContext(req);
        const parsedPage = parseInt(req.query.page, 10);
        const page = Number.isNaN(parsedPage) ? 1 : Math.max(parsedPage, 1);
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isNaN(parsedLimit)
            ? DEFAULT_LIMIT
            : Math.max(MIN_LIMIT, Math.min(parsedLimit, MAX_LIMIT));

        // ── Step 1: Understand what the user meant ──────────────────────────
        const analysis = analyzeQuery(rawQuery);

        // Also apply old NLP (mood / similarity keywords) — keep for backward compat
        const nlpIntent = detectSearchIntent(rawQuery);
        const nlpExpandedQuery = nlpIntent ? nlpIntent.expandedQuery : rawQuery;

        // Merge: if language/movie were stripped by analyzeQuery, use cleanTitle for NLP too
        const primaryQuery = analysis.cleanTitle || rawQuery;

        // ── Step 2: Load-more (page > 1) — only songs, re-ranked ────────────
        if (page > 1) {
            const songsData = await searchSongsOnly(nlpExpandedQuery, page);
            const rawSongs = songsData?.data?.results ?? [];
            const scored = rankSongs(deduplicateSongs(rawSongs), analysis);
            const orderedSongs = preferredLanguages.length > 0
                ? prioritizeSongsByLanguage(scored, preferredLanguages)
                : scored;
            const finalSongs = uid
                ? await rerankSongsForUser({ uid, songs: orderedSongs, query: rawQuery, preferredLanguages, mode: 'search' })
                : orderedSongs;
            const songs = finalSongs.slice(0, limit);
            return res.json({
                success: true,
                data: {
                    songs,
                    albums: [],
                    artists: [],
                    topResult: songs.length > 0 ? { type: 'song', data: songs[0] } : null,
                    relatedLanguages: buildRelatedLanguages({ query: rawQuery, preferredLanguages, songs, albums: [] }),
                    albumLanguageSections: [],
                    sections: buildSearchSections({ songs, albums: [], artists: [], topResult: songs.length > 0 ? { type: 'song', data: songs[0] } : null, albumLanguageSections: [] }),
                },
            });
        }

        // ── Step 3: Page 1 — multi-variant parallel search ──────────────────
        // Build query variants from analysis (most-specific → least-specific)
        const searchVariants = buildSearchVariants(analysis);

        // Fire songs from each variant + albums + artists + iTunes in parallel
        const songFetches = searchVariants.map(variant =>
            searchSongsSmart(variant, { preferredLanguages, waitForFresh: true })
                .catch(() => [])
        );

        // Build 1–2 targeted iTunes queries from intent (never raw user input).
        // Cap at 2 to stay well under Apple's ~20 req/min rate limit.
        const itunesQueries = buildItunesQueries(analysis);
        const itunesFetch = Promise.all(
            itunesQueries.map(q => searchItunes(q, { limit: 25, country: 'IN' }).catch(() => []))
        ).then(results => results.flat());

        const [songResults, albumsData, artistsData, itunesResults] = await Promise.allSettled([
            Promise.all(songFetches),
            searchAlbums(primaryQuery),
            searchArtists(primaryQuery),
            itunesFetch,
        ]);

        const itunesTracks = itunesResults.status === 'fulfilled' ? itunesResults.value : [];

        // ── Step 4: Merge + deduplicate + rank songs ─────────────────────────
        const allRawSongs = songResults.status === 'fulfilled'
            ? songResults.value.flat().filter(Boolean)
            : [];

        // Deduplicate first (same song from multiple variants), then rank
        const dedupedSongs = deduplicateSongs(allRawSongs);

        // Enrich with iTunes metadata before scoring (adds itunesBoost to each song)
        const enrichedSongs = enrichSongsWithItunes(dedupedSongs, itunesTracks);

        const rankedByEngine = rankSongs(enrichedSongs, analysis);

        // Apply language preference as a secondary sort layer (doesn't override exact matches)
        const songsWithLangPref = preferredLanguages.length > 0
            ? applyLanguageBoost(rankedByEngine, preferredLanguages, analysis)
            : rankedByEngine;

        const songsBeforePersonalization = songsWithLangPref;
        const rankedSongs = uid
            ? await rerankSongsForUser({
                uid,
                songs: songsBeforePersonalization.slice(0, 40), // personalize top 40 only
                query: rawQuery,
                preferredLanguages,
                mode: 'search',
            })
            : songsBeforePersonalization;

        let finalRanked = rankedSongs;

        // ── Album-song injection ─────────────────────────────────────────────
        // When results are sparse (< 5 songs) and an album matches the query,
        // pull that album's songs in. Handles queries like "perumazhakkalam"
        // where the user typed a movie/album name rather than a song title.
        if (finalRanked.length < 5 && albumsData.status === 'fulfilled') {
            const topAlbum = (albumsData.value?.data?.results ?? [])[0];
            if (topAlbum?.id) {
                try {
                    const albumDetail = await getAlbumById(topAlbum.id);
                    const albumSongs = albumDetail?.data?.songs ?? albumDetail?.data?.list ?? [];
                    if (albumSongs.length > 0) {
                        const enrichedAlbumSongs = enrichSongsWithItunes(albumSongs, itunesTracks);
                        const ranked = rankSongs(deduplicateSongs([...enrichedAlbumSongs, ...finalRanked]), analysis);
                        finalRanked = ranked;
                    }
                } catch (_) { /* album fetch is best-effort */ }
            }
        }

        const songsOut = attachCanonicalIds(finalRanked.slice(0, limit));

        const albumsOut = albumsData.status === 'fulfilled'
            ? (albumsData.value?.data?.results ?? []).slice(0, limit)
            : [];
        const artistsOut = artistsData.status === 'fulfilled'
            ? (artistsData.value?.data?.results ?? []).slice(0, limit)
            : [];

        // ── Step 5: Resolve top result using engine scoring ──────────────────
        const topResult = engineResolveTopResult({
            analysis,
            songs: songsOut,
            albums: albumsOut,
            artists: artistsOut,
        });

        const relatedLanguages = buildRelatedLanguages({
            query: rawQuery,
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

        res.json({
            success: true,
            data: {
                songs: songsOut,
                albums: albumsOut,
                artists: artistsOut,
                topResult,
                relatedLanguages,
                albumLanguageSections,
                queryAnalysis: {
                    cleanTitle: analysis.cleanTitle,
                    language: analysis.language,
                    movie: analysis.movie,
                    isVersionSearch: analysis.isVersionSearch,
                    itunesEnriched: itunesTracks.length > 0,
                },
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

// Trending searches endpoint (used by search home screen)
router.get('/search/trending', async (_req, res) => {
    res.json({
        success: true,
        trending: [
            'Aavesham songs',
            'Sid Sriram',
            'New Malayalam hits',
            'Arijit Singh',
            'Anirudh',
            'KGF 2',
            'Believer',
            'New Tamil releases',
            'AP Dhillon',
            'Pritam',
        ],
    });
});

// ── Common artist-name typo corrections ──────────────────────────────────────
const ARTIST_CORRECTIONS = new Map([
    ['arijit sing', 'arijit singh'],
    ['arijeet singh', 'arijit singh'],
    ['arjit singh', 'arijit singh'],
    ['arjeet', 'arijit singh'],
    ['kishore', 'kishore kumar'],
    ['lata', 'lata mangeshkar'],
    ['asha', 'asha bhosle'],
    ['sonu', 'sonu nigam'],
    ['shreya', 'shreya ghoshal'],
    ['shreya ghoshal', 'shreya ghoshal'],
    ['atif', 'atif aslam'],
    ['atif aslm', 'atif aslam'],
    ['kk', 'k.k.'],
    ['armaan', 'armaan malik'],
    ['arman malik', 'armaan malik'],
    ['jubin', 'jubin nautiyal'],
    ['jubin notiyal', 'jubin nautiyal'],
    ['mohit', 'mohit chauhan'],
    ['vishal', 'vishal-shekhar'],
    ['ar rahman', 'a.r. rahman'],
    ['arrahman', 'a.r. rahman'],
    ['rahman', 'a.r. rahman'],
    ['sp balasubrahmanyam', 's.p. balasubrahmanyam'],
    ['spb', 's.p. balasubrahmanyam'],
    ['ilayaraja', 'ilaiyaraaja'],
    ['illayaraja', 'ilaiyaraaja'],
    ['sid sriram', 'sid sriram'],
    ['anirudh', 'anirudh ravichander'],
    ['thaman', 's. thaman'],
    ['gv prakash', 'g.v. prakash kumar'],
    ['devi sri prasad', 'devi sri prasad'],
    ['dsp', 'devi sri prasad'],
    ['mithoon', 'mithoon'],
    ['amit trivedi', 'amit trivedi'],
    ['shankar ehsaan loy', 'shankar-ehsaan-loy'],
    ['shankar ehsaan', 'shankar-ehsaan-loy'],
    ['benny dayal', 'benny dayal'],
    ['hariharan', 'hariharan'],
    ['udit narayan', 'udit narayan'],
    ['kumar sanu', 'kumar sanu'],
    ['alka yagnik', 'alka yagnik'],
    ['kavita krishnamurthy', 'kavita krishnamurthy'],
    ['sunidhi chauhan', 'sunidhi chauhan'],
    ['neha kakkar', 'neha kakkar'],
    ['badshah', 'badshah'],
    ['yo yo honey singh', 'yo yo honey singh'],
    ['honey singh', 'yo yo honey singh'],
    ['guru randhawa', 'guru randhawa'],
    ['hardy sandhu', 'hardy sandhu'],
    ['diljit', 'diljit dosanjh'],
    ['diljit dosanj', 'diljit dosanjh'],
    ['ap dhillon', 'ap dhillon'],
    ['karan aujla', 'karan aujla'],
    ['imran khan', 'imran khan'],
    ['ali zafar', 'ali zafar'],
    ['rahat fateh ali', 'rahat fateh ali khan'],
    ['nusrat', 'nusrat fateh ali khan'],
    ['coke studio', 'coke studio'],
    ['prateek kuhad', 'prateek kuhad'],
    ['agathe chase', 'agathe chase'],
    ['luke combs', 'luke combs'],
]);

// ── NLP intent keywords ───────────────────────────────────────────────────────
const MOOD_KEYWORDS = new Map([
    ['sad', 'sad songs'],
    ['happy', 'happy songs'],
    ['workout', 'workout songs energetic'],
    ['gym', 'workout songs energetic'],
    ['exercise', 'workout songs energetic'],
    ['driving', 'driving songs upbeat'],
    ['party', 'party songs dance'],
    ['romantic', 'romantic love songs'],
    ['love', 'romantic love songs'],
    ['sleep', 'sleep songs calm ambient'],
    ['study', 'focus study lo-fi'],
    ['focus', 'focus study lo-fi'],
    ['relax', 'relaxing chill songs'],
    ['chill', 'chill relaxing songs'],
    ['devotional', 'devotional bhajan songs'],
    ['meditation', 'meditation calm music'],
    ['morning', 'morning motivational songs'],
    ['night', 'night slow songs'],
]);

const SIMILARITY_PREFIXES = [
    'songs like ',
    'similar to ',
    'songs similar to ',
    'music like ',
    'artists like ',
];

/**
 * Normalise, typo-correct, and expand a raw search query.
 * Returns { query, isNlp, nlpHints } where `query` is the
 * best string to forward to the search provider.
 */
function normalizeSearchQuery(value) {
    const raw = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!raw) return '';

    // Lowercase for matching, keep original case for output
    const lower = raw.toLowerCase();

    // Apply artist-name corrections (whole-string or leading match)
    for (const [typo, correction] of ARTIST_CORRECTIONS) {
        if (lower === typo || lower.startsWith(typo + ' ')) {
            return raw.replace(new RegExp(typo, 'i'), correction);
        }
    }

    return raw;
}

/**
 * Detect NLP intent from a search query.
 * Returns null when no special intent is found.
 * @param {string} query
 * @returns {{ type: string, expandedQuery: string } | null}
 */
export function detectSearchIntent(query) {
    const lower = query.toLowerCase();

    // "songs like X" / "similar to X" → similarity search
    for (const prefix of SIMILARITY_PREFIXES) {
        if (lower.startsWith(prefix)) {
            const seed = query.slice(prefix.length).trim();
            return { type: 'similarity', seed, expandedQuery: seed };
        }
    }

    // Mood keywords
    for (const [keyword, expansion] of MOOD_KEYWORDS) {
        if (lower.includes(keyword)) {
            const withoutMood = query.replace(new RegExp(keyword, 'gi'), '').trim();
            const expandedQuery = withoutMood
                ? `${withoutMood} ${expansion}`
                : expansion;
            return { type: 'mood', mood: keyword, expandedQuery };
        }
    }

    return null;
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

/**
 * Apply a soft language preference boost without overriding exact-match ranking.
 * Songs within 15 score points of the top are eligible for language reordering;
 * songs that clearly outscored others stay in place.
 */
function applyLanguageBoost(rankedSongs, preferredLanguages, analysis) {
    if (!Array.isArray(rankedSongs) || rankedSongs.length === 0) return rankedSongs;
    const preferredSet = new Set(preferredLanguages);

    // If the query already has an explicit language, don't apply preference boost
    if (analysis.language) return rankedSongs;

    return rankedSongs.map(song => ({
        song,
        lang: String(song?.language ?? '').toLowerCase(),
    })).sort((a, b) => {
        const aPreferred = preferredSet.has(a.lang);
        const bPreferred = preferredSet.has(b.lang);
        if (aPreferred === bPreferred) return 0;
        if (aPreferred) return -1;
        return 1;
    }).map(({ song }) => song);
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

function resolveTopResultLegacy({
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

// Song Lyrics API (public)
// Example: /api/songs/:id/lyrics
router.get('/songs/:id/lyrics', async (req, res) => {
    try {
        const data = await getLyricsBySongId(req.params.id);
        res.json(data);
    } catch (error) {
        console.error('Lyrics API error:', error.message);
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

// Artist Details by artist ID (public)
// Example: /api/artists/459320
router.get('/artists/:id', async (req, res) => {
    try {
        const artistId = req.params.id?.trim();
        if (!artistId) {
            return res.status(400).json({ error: 'Artist "id" parameter is required' });
        }
        const data = await getArtistById(artistId);
        return res.json(data);
    } catch (error) {
        console.error('Artist Details API error:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Artist Songs (Top tracks) by artist ID (public)
// Example: /api/artists/459320/songs
router.get('/artists/:id/songs', async (req, res) => {
    try {
        const artistId = req.params.id?.trim();
        if (!artistId) {
            return res.status(400).json({ error: 'Artist "id" parameter is required' });
        }
        const data = await getArtistSongs(artistId);
        return res.json(data);
    } catch (error) {
        console.error('Artist Songs API error:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
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
