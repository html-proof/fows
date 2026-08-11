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
import { searchAlbumsDirect, autocompleteAlbumSearch } from '../services/jiosaavnDirect.js';
import { auth } from '../config/firebase.js';
import { getGlobalTrending } from '../services/database.js';
import {
    analyzeQuery,
    buildSearchVariants,
    fuseSongCandidates,
    filterRelevantSongs,
    rankSongs,
    deduplicateSongs,
    resolveTopResult as engineResolveTopResult,
    scoreSong,
    normText,
} from '../services/searchEngine.js';
import { getUserPreferences } from '../services/database.js';
import { rerankSongsForUser } from '../services/personalizationModel.js';
import { attachCanonicalIds } from '../services/identityResolver.js';

const router = Router();
const DEFAULT_LIMIT = 40;
const MIN_LIMIT = 20;
const MAX_LIMIT = 60;
const ALBUM_LIMIT = 20;
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
        // When a movie was identified, use it for album lookup. Searching the
        // album endpoint with the song title misses the OST that contains the
        // requested track.
        const albumSearchQuery = analysis.movie || primaryQuery;

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

        // Fire songs from each variant + albums + artists in parallel
        const songFetches = searchVariants.map(variant =>
            searchSongsSmart(variant, { preferredLanguages, waitForFresh: true })
                .catch(() => [])
        );

        const [songResults, albumsData, artistsData] = await Promise.allSettled([
            Promise.all(songFetches),
            searchAlbums(albumSearchQuery),
            searchArtists(primaryQuery),
        ]);

        // ── Step 4: Merge + deduplicate + rank songs ─────────────────────────
        const candidateGroups = songResults.status === 'fulfilled'
            ? songResults.value.map((songs, index) => ({
                source: index === 0 ? 'exact' : `variant:${index}`,
                weight: Math.max(0.45, 1 - index * 0.15),
                songs,
            }))
            : [];

        const rankedByEngine = filterRelevantSongs(
            fuseSongCandidates(candidateGroups, analysis),
            analysis,
            { minKeep: Math.min(20, limit) },
        );

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
        // Only inject when the query looks like an album/movie name (not a song
        // title search). Guard: the top album name must closely match the query,
        // AND the top ranked song must NOT already be an exact title match.
        // This prevents flooding results with OST tracks when the user typed a
        // song name that coincidentally matches an album.
        // A short clip (< 90s) is NOT a reliable exact match — it's likely a score
        // cue that happens to share the title. Treat it as missing for album injection.
        const topSong = finalRanked[0];
        const topSongDur = parseInt(topSong?.duration ?? 0, 10);
        const topSongIsExactMatch = finalRanked.length > 0
            && normText(topSong?.name ?? '') === normText(analysis.cleanTitle)
            && topSongDur >= 90;
        const explicitMovieSearch = Boolean(analysis.movie);
        const albumSearchResults = albumsData.status === 'fulfilled'
            ? (albumsData.value?.data?.results ?? [])
            : [];
        const albumSearchTarget = normText(analysis.movie || analysis.cleanTitle);
        const hasMatchingAlbum = albumSearchResults.some(album =>
            areSearchTermsSimilar(normText(album?.name ?? ''), albumSearchTarget)
        );
        const queryLooksLikeAlbum = explicitMovieSearch || hasMatchingAlbum ||
            (!topSongIsExactMatch && finalRanked.length < 8);

        if (queryLooksLikeAlbum) {
            const titleNorm = normText(analysis.movie || analysis.cleanTitle);

            // Helper: pick the best-matching album from a results list
            const pickMatchingAlbum = (results) => {
                for (const alb of (results ?? [])) {
                    if (areSearchTermsSimilar(normText(alb?.name ?? ''), titleNorm)) {
                        return alb;
                    }
                }
                return null;
            };

            // Try the proxy result first
            const proxyAlbums = albumSearchResults;
            let matchedAlbum = pickMatchingAlbum(proxyAlbums);

            // Proxy didn't return a matching album — run direct API and autocomplete
            // in parallel to find a match without adding sequential round-trips.
            if (!matchedAlbum) {
                const [directRes, acRes] = await Promise.allSettled([
                    searchAlbumsDirect(albumSearchQuery, 5),
                    autocompleteAlbumSearch(albumSearchQuery),
                ]);
                if (directRes.status === 'fulfilled') {
                    matchedAlbum = pickMatchingAlbum(directRes.value?.data?.results ?? []);
                }
                if (!matchedAlbum && acRes.status === 'fulfilled' && acRes.value) {
                    const acAlbum = acRes.value;
                    if (areSearchTermsSimilar(normText(acAlbum.name), titleNorm)) {
                        matchedAlbum = acAlbum;
                    }
                }
            }

            if (matchedAlbum && (matchedAlbum.id || matchedAlbum.url)) {
                try {
                    const albumDetail = await getAlbumById(matchedAlbum.id, matchedAlbum.url);
                    const albumSongs = albumDetail?.data?.songs ?? albumDetail?.data?.list ?? [];
                    if (albumSongs.length > 0) {
                        const ranked = filterRelevantSongs(
                            fuseSongCandidates([
                                { source: 'album', weight: 0.85, songs: rankSongs(deduplicateSongs(albumSongs), analysis) },
                                { source: 'search', weight: 1.1, songs: finalRanked },
                            ], analysis),
                            analysis,
                            { minKeep: Math.min(20, limit) },
                        );
                        finalRanked = ranked;
                    }
                } catch (_) { /* album fetch is best-effort */ }
            }
        }

        const songsOut = attachCanonicalIds(finalRanked.slice(0, limit));

        const albumsOut = albumsData.status === 'fulfilled'
            ? (albumsData.value?.data?.results ?? []).slice(0, ALBUM_LIMIT)
            : [];
        const artistsOut = artistsData.status === 'fulfilled'
            ? (artistsData.value?.data?.results ?? []).slice(0, ALBUM_LIMIT)
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
                    itunesEnriched: false,
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
// Returns actual trending artists/queries from activity data, with hardcoded fallback.
const _TRENDING_FALLBACK = [
    'Arijit Singh', 'Sid Sriram', 'Anirudh', 'AP Dhillon',
    'Pritam', 'A.R. Rahman', 'Shreya Ghoshal', 'Diljit Dosanjh',
    'New Malayalam hits', 'New Tamil releases',
];

router.get('/search/trending', async (_req, res) => {
    try {
        const trending = await Promise.race([
            getGlobalTrending(10),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
        const queries = trending.length >= 3
            ? [...new Set(trending.map(t => t.artist || t.songName).filter(Boolean))].slice(0, 10)
            : _TRENDING_FALLBACK;

        res.json({ success: true, trending: queries.length ? queries : _TRENDING_FALLBACK });
    } catch {
        res.json({ success: true, trending: _TRENDING_FALLBACK });
    }
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

/// Returns true for exact, partial, and tightly bounded typo matches between
/// a query and a provider-supplied album title. The caller already requires
/// this to be the provider's top album, so a small edit-distance allowance is
/// useful without broadening unrelated album matches.
function areSearchTermsSimilar(left, right) {
    if (!left || !right) return false;
    if (left === right || left.includes(right) || right.includes(left)) return true;

    const longestLength = Math.max(left.length, right.length);
    const shortestLength = Math.min(left.length, right.length);
    if (shortestLength < 5) return false;

    const maximumDistance = longestLength >= 12 ? 2 : 1;
    if (Math.abs(left.length - right.length) > maximumDistance) return false;
    return levenshteinDistance(left, right) <= maximumDistance;
}

function levenshteinDistance(left, right) {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let row = 1; row <= left.length; row += 1) {
        const current = [row];
        for (let column = 1; column <= right.length; column += 1) {
            const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
            current[column] = Math.min(
                previous[column] + 1,
                current[column - 1] + 1,
                substitution,
            );
        }
        previous = current;
    }
    return previous[right.length];
}

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
        score: song?._searchFeatures?.relevanceScore ?? scoreSong(song, analysis),
    })).sort((a, b) => {
        const scoreGap = Math.abs(a.score - b.score);
        if (scoreGap > 15) return b.score - a.score;

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
const _lyricsCache = new Map(); // songId → { data, expiresAt }
const _LYRICS_TTL_MS = 30 * 60 * 1000; // 30 min

router.get('/songs/:id/lyrics', async (req, res) => {
    try {
        const songId = req.params.id;
        const now = Date.now();
        const cached = _lyricsCache.get(songId);
        if (cached && cached.expiresAt > now) {
            return res.json(cached.data);
        }

        const data = await getLyricsBySongId(songId);
        _lyricsCache.set(songId, { data, expiresAt: now + _LYRICS_TTL_MS });
        // Evict oldest entry when cache exceeds 500 songs
        if (_lyricsCache.size > 500) {
            _lyricsCache.delete(_lyricsCache.keys().next().value);
        }
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
        const { id, query, link } = req.query;

        if (!id && !query && !link) {
            return res.status(400).json({ error: 'Either "id", "query", or "link" parameter is required' });
        }

        let data;
        if (id) {
            data = await getAlbumById(id);
        } else if (link) {
            data = await getAlbumById(null, link);
        } else {
            data = await searchAlbums(query);
        }

        // Normalise: JioSaavn proxy puts tracks under `list` for many album
        // detail responses; unify to `songs` before sending to the client.
        if (data?.data && Array.isArray(data.data.list) && !Array.isArray(data.data.songs)) {
            data = { ...data, data: { ...data.data, songs: data.data.list } };
        }

        // Album detail payloads contain raw provider tracks. Assign canonical
        // IDs here so the mobile player resolves each tapped album track via
        // the verified playback resolver instead of guessing from metadata.
        if (data?.data?.songs && Array.isArray(data.data.songs)) {
            data = {
                ...data,
                data: {
                    ...data.data,
                    songs: attachCanonicalIds(data.data.songs),
                },
            };
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

// ── Album by link (perma_url) ────────────────────────────────────────────────
// Example: /api/albums?link=https://www.jiosaavn.com/album/chotta-mumbai/x2r2JfQW98M_
// Also supports: /api/albums?id=55455073  (existing)
// Updated to try ?link= first when provided
router.get('/albums/by-link', async (req, res) => {
    try {
        const { link } = req.query;
        if (!link) return res.status(400).json({ error: '"link" parameter is required' });
        const data = await getAlbumById(null, link);
        if (!data?.data?.name) return res.status(404).json({ error: 'Album not found' });
        res.json(data);
    } catch (error) {
        console.error('Album by-link error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Stream URL ───────────────────────────────────────────────────────────────
// GET /api/songs/:id/stream
// Returns the best available stream URL for a JioSaavn song ID.
// The client uses this URL directly with an audio player — no proxy needed.
// Quality preference: 320kbps → 160kbps → 96kbps (falls back down the chain).
const _streamCache = new Map(); // songId → { urls, expiresAt }
const _STREAM_TTL_MS = 25 * 60 * 1000; // 25 min (JioSaavn CDN URLs expire ~30 min)

router.get('/songs/:id/stream', async (req, res) => {
    const songId = req.params.id?.trim();
    if (!songId) return res.status(400).json({ error: 'Song id is required' });

    const quality = req.query.quality ?? '320kbps';
    const QUALITY_ORDER = ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps'];

    try {
        const now = Date.now();
        let urls;

        const cached = _streamCache.get(songId);
        if (cached && cached.expiresAt > now) {
            urls = cached.urls;
        } else {
            const data = await getSongById(songId);
            const song = data?.data?.[0] ?? data?.data ?? null;
            if (!song) return res.status(404).json({ error: 'Song not found' });

            urls = song.downloadUrl ?? song.streamUrl ?? [];
            if (urls.length) {
                _streamCache.set(songId, { urls, expiresAt: now + _STREAM_TTL_MS });
                if (_streamCache.size > 1000) _streamCache.delete(_streamCache.keys().next().value);
            }
        }

        if (!urls.length) return res.status(404).json({ error: 'No stream URL available' });

        // Pick requested quality, fall back down the chain
        const urlMap = Object.fromEntries(urls.map(u => [u.quality, u.url]));
        const startIdx = Math.max(0, QUALITY_ORDER.indexOf(quality));
        let chosenUrl = null;
        let chosenQuality = null;
        for (const q of QUALITY_ORDER.slice(startIdx)) {
            if (urlMap[q]) { chosenUrl = urlMap[q]; chosenQuality = q; break; }
        }
        if (!chosenUrl) { chosenUrl = urls[0].url; chosenQuality = urls[0].quality; }

        res.json({
            success: true,
            data: {
                songId,
                streamUrl: chosenUrl,
                quality: chosenQuality,
                allQualities: urls.map(u => ({ quality: u.quality, url: u.url })),
            },
        });
    } catch (error) {
        console.error('Stream API error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Recommendations (similar songs) ─────────────────────────────────────────
// GET /api/songs/:id/recommendations?limit=10
// Uses JioSaavn's album-reco engine: finds the song's album then returns
// similar albums + their top tracks, deduped and ranked.
const JIOSAAVN_DIRECT = 'https://www.jiosaavn.com/api.php';
const DIRECT_QS = 'api_version=4&_format=json&_marker=0&ctx=wap6dot0';

async function jiosaavnCall(params) {
    const qs = new URLSearchParams({ ...params, api_version: '4', _format: 'json', _marker: '0', ctx: 'wap6dot0' });
    const res = await fetch(`${JIOSAAVN_DIRECT}?${qs}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`JioSaavn API error: ${res.status}`);
    return res.json();
}

router.get('/songs/:id/recommendations', async (req, res) => {
    const songId = req.params.id?.trim();
    if (!songId) return res.status(400).json({ error: 'Song id is required' });

    const limit = Math.min(parseInt(req.query.limit ?? '10', 10) || 10, 20);

    try {
        // Step 1: get song's album ID
        const songData = await getSongById(songId);
        const song = songData?.data?.[0] ?? songData?.data ?? null;
        if (!song) return res.status(404).json({ error: 'Song not found' });

        const albumId = song.album?.id ?? song.albumId;
        if (!albumId) return res.status(404).json({ error: 'Album not found for song' });

        // Step 2: get similar albums from JioSaavn reco engine
        const recoData = await jiosaavnCall({ __call: 'reco.getAlbumReco', albumid: albumId });
        const recoAlbums = Array.isArray(recoData) ? recoData : [];

        if (!recoAlbums.length) {
            return res.json({ success: true, data: [] });
        }

        // Step 3: from recommended albums, surface 1-2 top songs each
        const recommendations = [];
        for (const album of recoAlbums.slice(0, 8)) {
            if (recommendations.length >= limit) break;
            try {
                const albumDetail = await getAlbumById(album.id ?? album.albumid);
                const songs = albumDetail?.data?.songs ?? albumDetail?.data?.list ?? [];
                // Pick the first real song (duration >= 60s)
                const topSong = songs.find(s => parseInt(s.duration ?? 0, 10) >= 60);
                if (topSong) {
                    recommendations.push({
                        id: topSong.id,
                        name: topSong.name,
                        artists: topSong.artists,
                        album: { id: topSong.album?.id, name: topSong.album?.name ?? album.title },
                        image: topSong.image,
                        duration: topSong.duration,
                        language: topSong.language,
                        year: topSong.year,
                    });
                }
            } catch (_) { /* skip failed album */ }
        }

        res.json({ success: true, data: recommendations.slice(0, limit) });
    } catch (error) {
        console.error('Recommendations error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Trending ─────────────────────────────────────────────────────────────────
// GET /api/trending?language=malayalam&type=song|album
// Returns JioSaavn's live trending songs or albums for a language.
const _trendingCache = new Map(); // key → { data, expiresAt }
const _TRENDING_TTL_MS = 10 * 60 * 1000; // 10 min

router.get('/trending', async (req, res) => {
    const language = (req.query.language ?? 'hindi').toLowerCase().trim();
    const type = req.query.type === 'album' ? 'album' : 'song';
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10) || 20, 50);
    const cacheKey = `${language}:${type}`;

    try {
        const now = Date.now();
        const cached = _trendingCache.get(cacheKey);
        if (cached && cached.expiresAt > now) {
            return res.json({ success: true, data: cached.data.slice(0, limit) });
        }

        const raw = await jiosaavnCall({
            __call: 'content.getTrending',
            entity_type: type,
            entity_language: language,
        });

        // JioSaavn returns either an array or an object with numeric keys
        const list = Array.isArray(raw)
            ? raw
            : Object.values(raw ?? {}).filter(v => v && typeof v === 'object' && !Array.isArray(v));

        const data = list.map(item => ({
            id:       item.id ?? null,
            name:     item.title ?? item.name ?? '',
            type:     item.type ?? type,
            image:    item.image ?? null,
            url:      item.perma_url ?? item.url ?? null,
            language: item.language ?? language,
            year:     item.year ?? null,
            artists:  item.subtitle ?? item.more_info?.music ?? null,
        })).filter(item => item.name);

        _trendingCache.set(cacheKey, { data, expiresAt: now + _TRENDING_TTL_MS });
        res.json({ success: true, data: data.slice(0, limit) });
    } catch (error) {
        console.error('Trending error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
