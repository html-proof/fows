import { request } from 'undici';

const BASE_URL = 'https://saavn.sumit.co';
const FALLBACK_BASE_URL = 'https://saavnapi-nine.vercel.app';
const MAX_SMART_RESULTS = 40;
const SMART_SEARCH_MIN_RESULTS = 8;
const SEARCH_CACHE_FRESH_TTL_MS = 2 * 60 * 1000;
const SEARCH_CACHE_STALE_TTL_MS = 20 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 300;
const SMART_SEARCH_MAX_VARIANTS = 4;
const SMART_SEARCH_MAX_LATENCY_MS = 3200;
const PRIMARY_SEARCH_TIMEOUT_MS = 2200;
const FALLBACK_SEARCH_TIMEOUT_MS = 1800;
const CATALOG_SEARCH_TIMEOUT_MS = 1500;
const LOCAL_INDEX_MAX_ENTRIES = 6000;
const LOCAL_INDEX_MAX_CANDIDATES = 120;
const smartSearchCache = new Map();
const smartSearchInFlight = new Map();
const localSongIndex = new Map();
const MATCH_TIERS = Object.freeze({
    EXACT: 0,
    STARTS_WITH: 1,
    CONTAINS: 2,
    FUZZY: 3,
});
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
const QUERY_NOISE_WORDS = new Set([
    ...LANGUAGE_HINTS,
    'song',
    'songs',
    'movie',
    'film',
    'album',
    'lyrics',
    'video',
    'official',
    'audio',
    'music',
    'theme',
    'bgm',
    'ost',
]);

async function requestJsonWithTimeout(url, { timeoutMs, label }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const { statusCode, body } = await request(url, {
            signal: controller.signal,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
        });

        if (statusCode !== 200) {
            throw new Error(`${label} failed with status ${statusCode}`);
        }

        return body.json();
    } catch (error) {
        if (error?.name === 'AbortError' || error?.code === 'UND_ERR_ABORTED') {
            throw new Error(`${label} timed out after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

export async function searchSongs(query, page = 1) {
    return requestJsonWithTimeout(
        `${BASE_URL}/api/search?query=${encodeURIComponent(query)}&page=${page}`,
        {
            timeoutMs: PRIMARY_SEARCH_TIMEOUT_MS,
            label: 'Saavn search',
        }
    );
}

export async function searchSongsOnly(query, page = 1) {
    const pageNumber = Number.parseInt(page, 10) || 1;

    let primaryPayload = null;
    try {
        primaryPayload = await searchSongsOnlyPrimary(query, pageNumber);
    } catch (_primaryError) {
        if (pageNumber > 1) {
            const fallbackSongs = await searchSongsOnlyFallback(query);
            return wrapSongsOnlyResponse(fallbackSongs);
        }
    }

    if (!primaryPayload) {
        const fallbackSongs = await searchSongsOnlyFallback(query);
        return wrapSongsOnlyResponse(fallbackSongs);
    }

    const primarySongs = primaryPayload?.data?.results ?? [];
    if (primarySongs.length >= SMART_SEARCH_MIN_RESULTS || pageNumber > 1) {
        return primaryPayload;
    }

    const fallbackSongs = await searchSongsOnlyFallback(query).catch(() => []);
    if (fallbackSongs.length === 0) {
        return primaryPayload;
    }

    const mergedSongs = mergeUniqueSongs(primarySongs, fallbackSongs);
    return mergeSongsIntoPayload(primaryPayload, mergedSongs);
}

async function searchSongsOnlyPrimary(query, page = 1) {
    return requestJsonWithTimeout(
        `${BASE_URL}/api/search/songs?query=${encodeURIComponent(query)}&page=${page}`,
        {
            timeoutMs: PRIMARY_SEARCH_TIMEOUT_MS,
            label: 'Saavn song search',
        }
    );
}

/**
 * Fallback song search using alternate provider.
 * Response is normalized into the same shape expected by current clients.
 *
 * @param {string} query
 * @returns {Promise<object[]>}
 */
export async function searchSongsOnlyFallback(query) {
    const payload = await requestJsonWithTimeout(
        `${FALLBACK_BASE_URL}/result/?query=${encodeURIComponent(query)}`,
        {
            timeoutMs: FALLBACK_SEARCH_TIMEOUT_MS,
            label: 'Fallback song search',
        }
    );
    if (!Array.isArray(payload)) return [];

    return payload
        .map(normalizeFallbackSong)
        .filter(song => song && song.id && song.name);
}

/**
 * Smart song search for scale:
 * - returns fresh cache instantly
 * - returns stale cache instantly while refreshing in background
 * - deduplicates in-flight requests per query
 * - queries primary and fallback providers
 * - retries with normalized variants (language/noise stripped)
 * - ranks and deduplicates results
 *
 * @param {string} query
 * @param {{ waitForFresh?: boolean, preferredLanguages?: string[] }} [options]
 * @returns {Promise<object[]>}
 */
export async function searchSongsSmart(query, options = {}) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) return [];
    const waitForFresh = options?.waitForFresh === true;
    const preferredLanguages = normalizeLanguageList(options?.preferredLanguages);
    const cacheKey = buildSmartSearchCacheKey(normalizedQuery, preferredLanguages);
    const context = {
        cacheKey,
        normalizedQuery,
        preferredLanguages,
    };

    const cached = getCachedSmartSearch(cacheKey);
    if (cached) {
        if (cached.state === 'fresh') {
            return cached.data;
        }

        if (!waitForFresh) {
            triggerBackgroundSmartSearchRefresh(context);
            return cached.data;
        }
    }

    return refreshSmartSearch(context);
}

async function refreshSmartSearch(context) {
    const { cacheKey, normalizedQuery, preferredLanguages } = context;
    const inFlight = smartSearchInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = (async () => {
        const output = await computeSmartSearchResults({
            normalizedQuery,
            preferredLanguages,
        });
        setCachedSmartSearch(cacheKey, output);
        return output;
    })();

    smartSearchInFlight.set(cacheKey, promise);
    promise.then(
        () => smartSearchInFlight.delete(cacheKey),
        () => smartSearchInFlight.delete(cacheKey)
    );

    return promise;
}

function triggerBackgroundSmartSearchRefresh(context) {
    if (smartSearchInFlight.has(context.cacheKey)) return;
    refreshSmartSearch(context).catch((error) => {
        console.error('Background smart search refresh failed:', error?.message ?? error);
    });
}

async function computeSmartSearchResults({
    normalizedQuery,
    preferredLanguages,
}) {
    const startedAt = Date.now();
    const variants = buildSearchQueryVariants(normalizedQuery);
    const languageHint = extractLanguageHint(normalizedQuery);
    const preferredLanguageSet = new Set(preferredLanguages);
    const ranked = new Map(); // id -> { song, score, matchTier }

    const indexedSongs = searchLocalSongIndex(normalizedQuery);
    if (indexedSongs.length > 0) {
        addRankedSongs({
            ranked,
            songs: indexedSongs,
            query: normalizedQuery,
            variantIndex: 0,
            sourceWeight: 20,
            languageHint,
            preferredLanguageSet,
        });
    }
    if (hasStrongRankedCoverage(ranked)) {
        return buildRankedOutput(ranked);
    }

    for (let i = 0; i < variants.length; i += 1) {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= SMART_SEARCH_MAX_LATENCY_MS && ranked.size > 0) {
            break;
        }

        const variant = variants[i];
        const shouldFetchBroad = i < 2 || ranked.size < SMART_SEARCH_MIN_RESULTS;
        const shouldFetchFallback = i === 0 || ranked.size < Math.ceil(SMART_SEARCH_MIN_RESULTS / 2);
        const jobs = [
            { key: 'primary', promise: searchSongsOnlyPrimary(variant, 1) },
        ];

        if (shouldFetchBroad) {
            jobs.push({ key: 'broad', promise: searchSongs(variant, 1) });
        }
        if (shouldFetchFallback) {
            jobs.push({ key: 'fallback', promise: searchSongsOnlyFallback(variant) });
        }

        const settled = await Promise.allSettled(jobs.map(job => job.promise));
        const resultsByKey = {};
        for (let j = 0; j < settled.length; j += 1) {
            resultsByKey[jobs[j].key] = settled[j];
        }

        const primarySongs = resultsByKey.primary?.status === 'fulfilled'
            ? (resultsByKey.primary.value?.data?.results ?? [])
            : [];
        const broadSongs = resultsByKey.broad?.status === 'fulfilled'
            ? (resultsByKey.broad.value?.data?.results ?? [])
            : [];
        const fallbackSongs = resultsByKey.fallback?.status === 'fulfilled'
            ? resultsByKey.fallback.value
            : [];

        addRankedSongs({
            ranked,
            songs: primarySongs,
            query: normalizedQuery,
            variantIndex: i,
            sourceWeight: 15,
            languageHint,
            preferredLanguageSet,
        });
        addRankedSongs({
            ranked,
            songs: broadSongs,
            query: normalizedQuery,
            variantIndex: i,
            sourceWeight: 8,
            languageHint,
            preferredLanguageSet,
        });
        addRankedSongs({
            ranked,
            songs: fallbackSongs,
            query: normalizedQuery,
            variantIndex: i,
            sourceWeight: 5,
            languageHint,
            preferredLanguageSet,
        });

        // Stop once we have enough candidates or we hit our time budget.
        if (ranked.size >= SMART_SEARCH_MIN_RESULTS) {
            break;
        }
        if (Date.now() - startedAt >= SMART_SEARCH_MAX_LATENCY_MS) {
            break;
        }
    }

    if (!hasExactRankedMatch(ranked)) {
        const globalSettled = await Promise.allSettled([
            searchSongs(normalizedQuery, 1),
            searchSongsOnlyFallback(normalizedQuery),
        ]);

        const globalSongs = globalSettled[0]?.status === 'fulfilled'
            ? (globalSettled[0].value?.data?.results ?? [])
            : [];
        const fallbackSongs = globalSettled[1]?.status === 'fulfilled'
            ? globalSettled[1].value
            : [];

        addRankedSongs({
            ranked,
            songs: globalSongs,
            query: normalizedQuery,
            variantIndex: SMART_SEARCH_MAX_VARIANTS + 1,
            sourceWeight: 6,
            languageHint,
            preferredLanguageSet,
        });
        addRankedSongs({
            ranked,
            songs: fallbackSongs,
            query: normalizedQuery,
            variantIndex: SMART_SEARCH_MAX_VARIANTS + 1,
            sourceWeight: 4,
            languageHint,
            preferredLanguageSet,
        });
    }

    return buildRankedOutput(ranked);
}

/**
 * Get song details by ID.
 * @param {string} id - Song ID
 * @returns {Promise<object>} Song details
 */
export async function getSongById(id) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/songs/${encodeURIComponent(id)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn song fetch failed with status ${statusCode}`);
    return body.json();
}

/**
 * Get album details by ID.
 * @param {string} id - Album ID
 * @returns {Promise<object>} Album details
 */
export async function getAlbumById(id) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/albums?id=${encodeURIComponent(id)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn album fetch failed with status ${statusCode}`);
    return body.json();
}

/**
 * Search for albums.
 * @param {string} query - Search query
 * @returns {Promise<object>} Album search results
 */
export async function searchAlbums(query) {
    return requestJsonWithTimeout(
        `${BASE_URL}/api/search/albums?query=${encodeURIComponent(query)}`,
        {
            timeoutMs: CATALOG_SEARCH_TIMEOUT_MS,
            label: 'Saavn album search',
        }
    );
}

/**
 * Search for artists.
 * @param {string} query - Artist name or query
 * @returns {Promise<object>} Artist search results
 */
export async function searchArtists(query) {
    return requestJsonWithTimeout(
        `${BASE_URL}/api/search/artists?query=${encodeURIComponent(query)}`,
        {
            timeoutMs: CATALOG_SEARCH_TIMEOUT_MS,
            label: 'Saavn artist search',
        }
    );
}

/**
 * Get an artist's songs by artist ID.
 * @param {string} artistId - Artist ID
 * @returns {Promise<object>} Artist's songs
 */
export async function getArtistSongs(artistId) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/artists/${encodeURIComponent(artistId)}/songs`
    );
    if (statusCode !== 200) throw new Error(`Saavn artist songs failed with status ${statusCode}`);
    return body.json();
}

/**
 * Get an artist's albums by artist ID with pagination.
 * @param {string} artistId - Artist ID
 * @param {{ limit?: number, page?: number }} [options]
 * @returns {Promise<object>} Artist albums payload
 */
export async function getArtistAlbums(artistId, options = {}) {
    const parsedLimit = Number.parseInt(options.limit, 10);
    const parsedPage = Number.parseInt(options.page, 10);
    const limit = Number.isNaN(parsedLimit) ? 20 : Math.max(1, Math.min(parsedLimit, 50));
    const page = Number.isNaN(parsedPage) ? 1 : Math.max(parsedPage, 1);

    return requestJsonWithTimeout(
        `${BASE_URL}/api/artists/${encodeURIComponent(artistId)}/albums?limit=${limit}&page=${page}`,
        {
            timeoutMs: CATALOG_SEARCH_TIMEOUT_MS,
            label: 'Saavn artist albums',
        }
    );
}

/**
 * Get artist details by ID.
 * @param {string} artistId - Artist ID
 * @returns {Promise<object>} Artist details
 */
export async function getArtistById(artistId) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/artists/${encodeURIComponent(artistId)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn artist fetch failed with status ${statusCode}`);
    return body.json();
}

/**
 * Get popular artists for a specific language.
 * This is used during onboarding to show a list of artists for selection.
 * @param {string} language - Language name (e.g. "hindi", "malayalam")
 * @returns {Promise<object[]>} List of artists
 */
export async function getArtistsByLanguage(language) {
    // Saavn API doesn't have a direct 'popular artists by language' endpoint.
    // We'll search for 'Top <language> Artists' and 'Popular <language> Artists'
    // to gather a good candidate list.
    const queries = [`Top ${language} Artists`, `Popular ${language} Artists`];

    const results = await Promise.allSettled(
        queries.map(q => searchArtists(q))
    );

    const artistMap = new Map();
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value?.data?.results) {
            for (const artist of result.value.data.results) {
                if (artist.id) artistMap.set(artist.id, artist);
            }
        }
    }

    return Array.from(artistMap.values());
}

export default {
    searchSongs,
    searchSongsOnly,
    searchSongsOnlyFallback,
    searchSongsSmart,
    getSongById,
    getAlbumById,
    searchAlbums,
    searchArtists,
    getArtistSongs,
    getArtistAlbums,
    getArtistById,
    getArtistsByLanguage,
};

function normalizeFallbackSong(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const id = (raw.id ?? raw.songid ?? '').toString().trim();
    const name = (raw.song ?? raw.title ?? '').toString().trim();
    const artistText = (raw.primary_artists ?? raw.singers ?? '').toString();
    const artistNames = artistText
        .split(',')
        .map(name => name.trim())
        .filter(Boolean);

    const artistsPrimary = artistNames.map((artistName, index) => ({
        id: `${id}_a${index}`,
        name: artistName,
        role: 'primary_artists',
        image: '',
        type: 'artist',
        url: '',
    }));

    const mediaUrl = (raw.media_url ?? raw.url ?? '').toString().trim();
    const downloadUrl = [];
    if (mediaUrl) {
        downloadUrl.push({ quality: '320kbps', url: mediaUrl });
    }

    const imageUrl = (raw.image ?? raw.image_url ?? '').toString().trim();
    const image = imageUrl
        ? [
            { quality: '50x50', url: imageUrl },
            { quality: '150x150', url: imageUrl },
            { quality: '500x500', url: imageUrl },
        ]
        : [];

    const albumId = (raw.albumid ?? '').toString().trim();
    const albumName = (raw.album ?? '').toString().trim();
    const albumUrl = (raw.album_url ?? '').toString().trim();

    return {
        id,
        name,
        type: 'song',
        year: (raw.year ?? '').toString(),
        releaseDate: raw.release_date ?? null,
        duration: Number.parseInt(raw.duration, 10) || null,
        language: (raw.language ?? '').toString().toLowerCase(),
        url: (raw.perma_url ?? '').toString(),
        album: {
            id: albumId,
            name: albumName,
            url: albumUrl,
        },
        primaryArtists: artistText,
        artists: {
            primary: artistsPrimary,
            featured: [],
            all: artistsPrimary,
        },
        image,
        downloadUrl,
    };
}

function addRankedSongs({
    ranked,
    songs,
    query,
    variantIndex,
    sourceWeight,
    languageHint,
    preferredLanguageSet,
}) {
    const safeSongs = Array.isArray(songs) ? songs : [];
    for (const rawSong of safeSongs) {
        const song = normalizePrimarySong(rawSong);
        if (!song || !song.id) continue;
        upsertLocalSongIndex(song);

        const match = scoreSongMatch({
            song,
            query,
            variantIndex,
            sourceWeight,
            languageHint,
            preferredLanguageSet,
        });
        if (!match) continue;

        const candidate = {
            song,
            score: match.score,
            matchTier: match.matchTier,
        };

        const existing = ranked.get(song.id);
        if (!existing || compareRankedEntries(candidate, existing) < 0) {
            ranked.set(song.id, candidate);
        }
    }
}

function normalizePrimarySong(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = (raw.id ?? '').toString().trim();
    const name = (raw.name ?? raw.title ?? '').toString().trim();
    if (!id || !name) return null;
    return raw;
}

function normalizeQuery(query) {
    return String(query ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeCompact(value) {
    return normalizeQuery(value)
        .replace(/[^\p{L}\p{N}]/gu, '');
}

function buildSearchQueryVariants(query) {
    const variants = [];
    const push = (value) => {
        const normalized = normalizeQuery(value);
        if (!normalized) return;
        if (variants.includes(normalized)) return;
        variants.push(normalized);
    };

    push(query);

    // Remove language/noise words (e.g., "malayalam", "song", "lyrics").
    const filteredTokens = tokenize(query).filter(token => !QUERY_NOISE_WORDS.has(token));
    if (filteredTokens.length > 0) {
        push(filteredTokens.join(' '));
    }

    // Drop trailing token (often a typo/noise fragment).
    const tokens = tokenize(query);
    if (tokens.length > 2) {
        push(tokens.slice(0, -1).join(' '));
    }

    // Keep first two terms for broad match.
    if (tokens.length > 2) {
        push(tokens.slice(0, 2).join(' '));
    }

    // Keep first token as broad fallback.
    if (tokens.length > 0) {
        push(tokens[0]);
    }

    // Try removing one token at a time for long queries.
    if (tokens.length >= 3) {
        for (let i = 0; i < tokens.length; i += 1) {
            const trimmed = tokens.filter((_, idx) => idx !== i).join(' ');
            push(trimmed);
        }
    }

    // Typo-tolerant variant: shorten long words by one char.
    const shortenable = tokens.some(token => token.length >= 6);
    if (shortenable) {
        const softened = tokens
            .map(token => (token.length >= 6 ? token.slice(0, -1) : token))
            .join(' ');
        push(softened);
    }

    return variants.slice(0, SMART_SEARCH_MAX_VARIANTS);
}

function tokenize(value) {
    return normalizeQuery(value)
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function normalizeLanguageList(values) {
    if (!Array.isArray(values) || values.length === 0) return [];
    const normalized = values
        .map(language => normalizeQuery(language))
        .filter(Boolean);
    return Array.from(new Set(normalized)).sort();
}

function buildSmartSearchCacheKey(query, preferredLanguages) {
    const languages = Array.isArray(preferredLanguages) && preferredLanguages.length > 0
        ? preferredLanguages.join(',')
        : '_';
    return `${query}::${languages}`;
}

function extractLanguageHint(query) {
    for (const token of tokenize(query)) {
        if (LANGUAGE_HINTS.has(token)) return token;
    }
    return null;
}

function extractSongSearchFields(song) {
    const name = normalizeQuery(song?.name ?? song?.title ?? '');
    const artists = normalizeQuery(
        song?.primaryArtists ??
        song?.artists?.primary?.map(artist => artist?.name ?? '').join(' ') ??
        ''
    );
    const album = normalizeQuery(
        typeof song?.album === 'object' ? (song?.album?.name ?? '') : (song?.album ?? '')
    );
    const haystack = `${name} ${artists} ${album}`.trim();

    return {
        name,
        artists,
        album,
        haystack,
        compactName: normalizeCompact(name),
        compactHaystack: normalizeCompact(haystack),
        haystackTokens: tokenize(haystack),
    };
}

function compareRankedEntries(a, b) {
    if (a.matchTier !== b.matchTier) return a.matchTier - b.matchTier;
    return b.score - a.score;
}

function buildRankedOutput(ranked) {
    return Array.from(ranked.values())
        .sort(compareRankedEntries)
        .slice(0, MAX_SMART_RESULTS)
        .map(entry => entry.song);
}

function hasExactRankedMatch(ranked) {
    for (const entry of ranked.values()) {
        if (entry.matchTier === MATCH_TIERS.EXACT) return true;
    }
    return false;
}

function hasStrongRankedCoverage(ranked) {
    let strongMatches = 0;
    for (const entry of ranked.values()) {
        if (entry.matchTier <= MATCH_TIERS.CONTAINS) {
            strongMatches += 1;
            if (strongMatches >= SMART_SEARCH_MIN_RESULTS) return true;
        }
    }
    return false;
}

function scoreSongMatch({
    song,
    query,
    variantIndex,
    sourceWeight,
    languageHint,
    preferredLanguageSet,
}) {
    const {
        name,
        artists,
        album,
        haystack,
        compactName,
        compactHaystack,
        haystackTokens,
    } = extractSongSearchFields(song);
    const compactQuery = normalizeCompact(query);
    const queryTerms = tokenize(query).filter(token => !QUERY_NOISE_WORDS.has(token));
    const effectiveTerms = queryTerms.length > 0 ? queryTerms : tokenize(query);
    const maxMissingTerms = effectiveTerms.length > 1 ? 1 : 0;
    const minimumTermMatches = effectiveTerms.length === 0
        ? 0
        : Math.max(1, effectiveTerms.length - maxMissingTerms);

    let score = 0;
    let directMatches = 0;
    let fuzzyMatches = 0;

    for (const term of effectiveTerms) {
        if (name.includes(term)) {
            directMatches += 1;
            score += 20;
        } else if (artists.includes(term)) {
            directMatches += 1;
            score += 13;
        } else if (album.includes(term)) {
            directMatches += 1;
            score += 10;
        } else if (hasFuzzyTokenMatch(term, haystackTokens)) {
            fuzzyMatches += 1;
            score += 6;
        }
    }

    const totalMatches = directMatches + fuzzyMatches;
    const hasTermCoverage = effectiveTerms.length === 0 || totalMatches >= minimumTermMatches;

    let matchTier = null;
    if (name === query || (compactQuery && compactName === compactQuery)) {
        matchTier = MATCH_TIERS.EXACT;
        score += 260;
    } else if (
        name.startsWith(query) ||
        (compactQuery && compactName.startsWith(compactQuery))
    ) {
        matchTier = MATCH_TIERS.STARTS_WITH;
        score += 200;
    } else if (
        name.includes(query) ||
        haystack.includes(query) ||
        (compactQuery && (
            compactName.includes(compactQuery) ||
            compactHaystack.includes(compactQuery)
        ))
    ) {
        matchTier = MATCH_TIERS.CONTAINS;
        score += 140;
    } else {
        const maxCompactDistance = resolveMaxEditDistance(compactQuery.length);
        const hasCompactFuzzy = Boolean(compactQuery && compactName)
            && Math.abs(compactQuery.length - compactName.length) <= maxCompactDistance
            && levenshteinDistance(compactQuery, compactName) <= maxCompactDistance;
        if (hasTermCoverage || hasCompactFuzzy || fuzzyMatches > 0) {
            matchTier = MATCH_TIERS.FUZZY;
            score += 80;
        }
    }

    if (matchTier == null) return null;
    if (matchTier === MATCH_TIERS.FUZZY && effectiveTerms.length >= 2 && !hasTermCoverage) {
        return null;
    }

    // Avoid noisy unrelated results for unmatched long queries.
    if (effectiveTerms.length >= 2 && totalMatches === 0 && matchTier > MATCH_TIERS.CONTAINS) {
        return null;
    }

    if (languageHint) {
        const language = normalizeQuery(song.language ?? '');
        if (language === languageHint) {
            score += 18;
        } else {
            score -= 4;
        }
    }

    if (preferredLanguageSet?.size > 0) {
        const language = normalizeQuery(song.language ?? '');
        if (preferredLanguageSet.has(language)) {
            score += 28;
        } else {
            score -= 2;
        }
    }

    score += sourceWeight;
    score -= variantIndex * 10;
    if (matchTier === MATCH_TIERS.FUZZY) {
        score -= 10;
    }

    return {
        score,
        matchTier,
    };
}

function resolveMaxEditDistance(length) {
    if (length >= 10) return 3;
    if (length >= 6) return 2;
    return 1;
}

function hasFuzzyTokenMatch(queryTerm, targetTokens) {
    for (const token of targetTokens) {
        if (!token || token.length < 2) continue;
        const maxDistance = queryTerm.length >= 7 ? 2 : 1;
        if (Math.abs(queryTerm.length - token.length) > maxDistance) continue;
        if (queryTerm[0] !== token[0]) continue;
        if (levenshteinDistance(queryTerm, token) <= maxDistance) return true;
    }
    return false;
}

function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let i = 0; i < rows; i += 1) dp[i][0] = i;
    for (let j = 0; j < cols; j += 1) dp[0][j] = j;

    for (let i = 1; i < rows; i += 1) {
        for (let j = 1; j < cols; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[rows - 1][cols - 1];
}

function searchLocalSongIndex(query) {
    if (localSongIndex.size === 0) return [];

    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) return [];
    const compactQuery = normalizeCompact(normalizedQuery);
    const queryTerms = tokenize(normalizedQuery).filter(token => !QUERY_NOISE_WORDS.has(token));
    const effectiveTerms = queryTerms.length > 0 ? queryTerms : tokenize(normalizedQuery);
    const maxMissingTerms = effectiveTerms.length > 1 ? 1 : 0;
    const minimumMatches = effectiveTerms.length === 0
        ? 0
        : Math.max(1, effectiveTerms.length - maxMissingTerms);
    const now = Date.now();

    const candidates = [];
    for (const entry of localSongIndex.values()) {
        const {
            song,
            name,
            haystack,
            compactName,
            compactHaystack,
            haystackTokens,
        } = entry;
        let score = 0;
        let matches = 0;

        if (name === normalizedQuery || (compactQuery && compactName === compactQuery)) {
            score += 180;
        } else if (
            name.startsWith(normalizedQuery) ||
            (compactQuery && compactName.startsWith(compactQuery))
        ) {
            score += 120;
        } else if (
            name.includes(normalizedQuery) ||
            haystack.includes(normalizedQuery) ||
            (compactQuery && compactHaystack.includes(compactQuery))
        ) {
            score += 80;
        }

        for (const term of effectiveTerms) {
            if (name.includes(term) || haystack.includes(term)) {
                matches += 1;
                score += 10;
            } else if (hasFuzzyTokenMatch(term, haystackTokens)) {
                matches += 1;
                score += 5;
            }
        }

        if (minimumMatches > 0 && matches < minimumMatches && score < 70) {
            continue;
        }
        if (score <= 0) continue;

        entry.lastAccessAt = now;
        candidates.push({ song, score });
    }

    return candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, LOCAL_INDEX_MAX_CANDIDATES)
        .map(entry => entry.song);
}

function upsertLocalSongIndex(song) {
    if (!song || typeof song !== 'object') return;
    const normalizedSong = normalizePrimarySong(song);
    if (!normalizedSong || !normalizedSong.id) return;

    const now = Date.now();
    const fields = extractSongSearchFields(normalizedSong);
    if (!fields.name) return;

    localSongIndex.set(normalizedSong.id, {
        song: normalizedSong,
        ...fields,
        updatedAt: now,
        lastAccessAt: now,
    });
    trimLocalSongIndex();
}

function trimLocalSongIndex() {
    while (localSongIndex.size > LOCAL_INDEX_MAX_ENTRIES) {
        let oldestKey = null;
        let oldestAccess = Number.POSITIVE_INFINITY;

        for (const [key, value] of localSongIndex.entries()) {
            const access = value?.lastAccessAt ?? value?.updatedAt ?? 0;
            if (access < oldestAccess) {
                oldestAccess = access;
                oldestKey = key;
            }
        }

        if (!oldestKey) break;
        localSongIndex.delete(oldestKey);
    }
}

function mergeUniqueSongs(...songLists) {
    const merged = [];
    const seen = new Set();

    for (const list of songLists) {
        const safeList = Array.isArray(list) ? list : [];
        for (const song of safeList) {
            if (!song || typeof song !== 'object') continue;

            const idKey = String(song.id ?? '').trim();
            const nameKey = normalizeQuery(song.name ?? song.title ?? '');
            const dedupeKey = idKey || nameKey;
            if (!dedupeKey) continue;
            if (seen.has(dedupeKey)) continue;

            seen.add(dedupeKey);
            merged.push(song);
        }
    }

    return merged;
}

function mergeSongsIntoPayload(primaryPayload, songs) {
    const safePayload = primaryPayload && typeof primaryPayload === 'object'
        ? primaryPayload
        : {};
    const safeData = safePayload.data && typeof safePayload.data === 'object'
        ? safePayload.data
        : {};

    return {
        ...safePayload,
        success: safePayload.success ?? true,
        data: {
            ...safeData,
            start: safeData.start ?? 0,
            total: songs.length,
            results: songs,
        },
    };
}

function wrapSongsOnlyResponse(songs) {
    const safeSongs = Array.isArray(songs) ? songs : [];
    return {
        success: true,
        data: {
            start: 0,
            total: safeSongs.length,
            results: safeSongs,
        },
    };
}

function getCachedSmartSearch(query) {
    const item = smartSearchCache.get(query);
    if (!item) return null;
    const now = Date.now();
    const ageMs = now - item.updatedAt;
    if (ageMs > SEARCH_CACHE_STALE_TTL_MS) {
        smartSearchCache.delete(query);
        return null;
    }

    item.lastAccessAt = now;
    return {
        data: item.data,
        state: ageMs <= SEARCH_CACHE_FRESH_TTL_MS ? 'fresh' : 'stale',
    };
}

function setCachedSmartSearch(query, data) {
    const now = Date.now();
    smartSearchCache.set(query, {
        updatedAt: now,
        lastAccessAt: now,
        data,
    });
    trimSmartSearchCache();
}

function trimSmartSearchCache() {
    if (smartSearchCache.size <= SEARCH_CACHE_MAX_ENTRIES) return;

    let oldestKey = null;
    let oldestAccess = Number.POSITIVE_INFINITY;

    for (const [key, value] of smartSearchCache.entries()) {
        const access = value?.lastAccessAt ?? value?.updatedAt ?? 0;
        if (access < oldestAccess) {
            oldestAccess = access;
            oldestKey = key;
        }
    }

    if (oldestKey) {
        smartSearchCache.delete(oldestKey);
    }
}
