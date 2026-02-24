import { request } from 'undici';

const BASE_URL = 'https://saavn.sumit.co';
const FALLBACK_BASE_URL = 'https://saavnapi-nine.vercel.app';
const MAX_SMART_RESULTS = 40;
const SMART_SEARCH_MIN_RESULTS = 8;
const SEARCH_CACHE_FRESH_TTL_MS = 2 * 60 * 1000;
const SEARCH_CACHE_STALE_TTL_MS = 20 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 300;
const smartSearchCache = new Map();
const smartSearchInFlight = new Map();
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

export async function searchSongs(query, page = 1) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/search?query=${encodeURIComponent(query)}&page=${page}`
    );
    if (statusCode !== 200) throw new Error(`Saavn search failed with status ${statusCode}`);
    return body.json();
}

export async function searchSongsOnly(query, page = 1) {
    const pageNumber = Number.parseInt(page, 10) || 1;

    // Keep paging stable; fallback is used as a recovery path for page > 1.
    if (pageNumber > 1) {
        try {
            return await searchSongsOnlyPrimary(query, pageNumber);
        } catch (_primaryError) {
            const fallbackSongs = await searchSongsOnlyFallback(query);
            return wrapSongsOnlyResponse(fallbackSongs);
        }
    }

    const [primaryResult, fallbackResult] = await Promise.allSettled([
        searchSongsOnlyPrimary(query, pageNumber),
        searchSongsOnlyFallback(query),
    ]);

    if (primaryResult.status === 'fulfilled') {
        const primaryPayload = primaryResult.value;
        const primarySongs = primaryPayload?.data?.results ?? [];
        const fallbackSongs = fallbackResult.status === 'fulfilled'
            ? (fallbackResult.value ?? [])
            : [];

        if (fallbackSongs.length === 0) {
            return primaryPayload;
        }

        const mergedSongs = mergeUniqueSongs(primarySongs, fallbackSongs);
        return mergeSongsIntoPayload(primaryPayload, mergedSongs);
    }

    if (fallbackResult.status === 'fulfilled') {
        return wrapSongsOnlyResponse(fallbackResult.value ?? []);
    }

    const primaryMsg = primaryResult.status === 'rejected'
        ? (primaryResult.reason?.message ?? 'unknown')
        : 'unknown';
    const fallbackMsg = fallbackResult.status === 'rejected'
        ? (fallbackResult.reason?.message ?? 'unknown')
        : 'unknown';
    throw new Error(
        `Multi-source song search failed. primary=${primaryMsg}; fallback=${fallbackMsg}`
    );
}

async function searchSongsOnlyPrimary(query, page = 1) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/search/songs?query=${encodeURIComponent(query)}&page=${page}`
    );
    if (statusCode !== 200) throw new Error(`Saavn song search failed with status ${statusCode}`);
    return body.json();
}

/**
 * Fallback song search using alternate provider.
 * Response is normalized into the same shape expected by current clients.
 *
 * @param {string} query
 * @returns {Promise<object[]>}
 */
export async function searchSongsOnlyFallback(query) {
    const { statusCode, body } = await request(
        `${FALLBACK_BASE_URL}/result/?query=${encodeURIComponent(query)}`
    );
    if (statusCode !== 200) {
        throw new Error(`Fallback song search failed with status ${statusCode}`);
    }

    const payload = await body.json();
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
 * @param {{ waitForFresh?: boolean }} [options]
 * @returns {Promise<object[]>}
 */
export async function searchSongsSmart(query, options = {}) {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) return [];
    const waitForFresh = options?.waitForFresh === true;

    const cached = getCachedSmartSearch(normalizedQuery);
    if (cached) {
        if (cached.state === 'fresh') {
            return cached.data;
        }

        if (!waitForFresh) {
            triggerBackgroundSmartSearchRefresh(normalizedQuery);
            return cached.data;
        }
    }

    return refreshSmartSearch(normalizedQuery);
}

async function refreshSmartSearch(normalizedQuery) {
    const inFlight = smartSearchInFlight.get(normalizedQuery);
    if (inFlight) return inFlight;

    const promise = (async () => {
        const output = await computeSmartSearchResults(normalizedQuery);
        setCachedSmartSearch(normalizedQuery, output);
        return output;
    })();

    smartSearchInFlight.set(normalizedQuery, promise);
    promise.then(
        () => smartSearchInFlight.delete(normalizedQuery),
        () => smartSearchInFlight.delete(normalizedQuery)
    );

    return promise;
}

function triggerBackgroundSmartSearchRefresh(normalizedQuery) {
    if (smartSearchInFlight.has(normalizedQuery)) return;
    refreshSmartSearch(normalizedQuery).catch((error) => {
        console.error('Background smart search refresh failed:', error?.message ?? error);
    });
}

async function computeSmartSearchResults(normalizedQuery) {
    const variants = buildSearchQueryVariants(normalizedQuery);
    const languageHint = extractLanguageHint(normalizedQuery);
    const ranked = new Map(); // id -> { song, score }

    for (let i = 0; i < variants.length; i += 1) {
        const variant = variants[i];
        const [songsOnlyResult, searchResult, fallbackResult] =
            await Promise.allSettled([
                searchSongsOnlyPrimary(variant, 1),
                searchSongs(variant, 1),
                searchSongsOnlyFallback(variant),
            ]);

        const primarySongs = songsOnlyResult.status === 'fulfilled'
            ? (songsOnlyResult.value?.data?.results ?? [])
            : [];
        const broadSongs = searchResult.status === 'fulfilled'
            ? (searchResult.value?.data?.results ?? [])
            : [];
        const fallbackSongs = fallbackResult.status === 'fulfilled'
            ? fallbackResult.value
            : [];

        addRankedSongs({
            ranked,
            songs: primarySongs,
            query: normalizedQuery,
            variantIndex: i,
            sourceWeight: 15,
            languageHint,
        });
        addRankedSongs({
            ranked,
            songs: broadSongs,
            query: normalizedQuery,
            variantIndex: i,
            sourceWeight: 8,
            languageHint,
        });
        addRankedSongs({
            ranked,
            songs: fallbackSongs,
            query: normalizedQuery,
            variantIndex: i,
            sourceWeight: 5,
            languageHint,
        });

        // Stop early once we have enough strong candidates.
        if (ranked.size >= SMART_SEARCH_MIN_RESULTS && i >= 2) {
            break;
        }
    }

    const output = Array.from(ranked.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SMART_RESULTS)
        .map(entry => entry.song);
    return output;
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
    const { statusCode, body } = await request(
        `${BASE_URL}/api/search/albums?query=${encodeURIComponent(query)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn album search failed with status ${statusCode}`);
    return body.json();
}

/**
 * Search for artists.
 * @param {string} query - Artist name or query
 * @returns {Promise<object>} Artist search results
 */
export async function searchArtists(query) {
    const { statusCode, body } = await request(
        `${BASE_URL}/api/search/artists?query=${encodeURIComponent(query)}`
    );
    if (statusCode !== 200) throw new Error(`Saavn artist search failed with status ${statusCode}`);
    return body.json();
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
}) {
    const safeSongs = Array.isArray(songs) ? songs : [];
    for (const rawSong of safeSongs) {
        const song = normalizePrimarySong(rawSong);
        if (!song || !song.id) continue;

        const score = scoreSongMatch({
            song,
            query,
            variantIndex,
            sourceWeight,
            languageHint,
        });
        if (score < 0) continue;

        const existing = ranked.get(song.id);
        if (!existing || score > existing.score) {
            ranked.set(song.id, { song, score });
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

    return variants.slice(0, 6);
}

function tokenize(value) {
    return normalizeQuery(value)
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function extractLanguageHint(query) {
    for (const token of tokenize(query)) {
        if (LANGUAGE_HINTS.has(token)) return token;
    }
    return null;
}

function scoreSongMatch({
    song,
    query,
    variantIndex,
    sourceWeight,
    languageHint,
}) {
    const name = normalizeQuery(song.name ?? '');
    const artists = normalizeQuery(
        song.primaryArtists ??
        song.artists?.primary?.map(a => a?.name ?? '').join(' ') ??
        ''
    );
    const album = normalizeQuery(
        typeof song.album === 'object' ? (song.album?.name ?? '') : (song.album ?? '')
    );
    const haystack = `${name} ${artists} ${album}`.trim();
    const haystackTokens = tokenize(haystack);
    const queryTerms = tokenize(query).filter(token => !QUERY_NOISE_WORDS.has(token));
    const matchedTerms = queryTerms.filter(term => haystack.includes(term));

    let score = 0;

    // Avoid noisy unrelated results for unmatched queries.
    if (queryTerms.length > 0 && matchedTerms.length === 0 && !name.includes(query)) {
        return -1;
    }

    if (name === query) score += 120;
    if (name.includes(query)) score += 70;
    if (haystack.includes(query)) score += 30;

    for (const term of queryTerms) {
        if (name.includes(term)) {
            score += 18;
        } else if (artists.includes(term)) {
            score += 10;
        } else if (album.includes(term)) {
            score += 8;
        } else if (hasFuzzyTokenMatch(term, haystackTokens)) {
            score += 5;
        }
    }

    if (languageHint) {
        const language = normalizeQuery(song.language ?? '');
        if (language === languageHint) {
            score += 18;
        } else {
            score -= 4;
        }
    }

    score += sourceWeight;
    score -= variantIndex * 12;

    return score;
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
