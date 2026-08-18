import { request } from 'undici';
import {
    searchSongsDirect,
    searchSongsOnlyDirect,
    getSongDirect,
    searchAlbumsDirect,
    getAlbumByIdDirect,
    searchArtistsDirect,
    getArtistByIdDirect,
    getArtistSongsDirect,
    getArtistAlbumsDirect,
} from './jiosaavnDirect.js';
import { getSongById as getGaanaSongById, searchSongsOnly as searchGaanaSongsOnly } from './gaanaApi.js';
import { getProviderAlbumId } from './identityResolver.js';

function describeProviderError(error) {
    const message = String(error?.message ?? '').trim();
    if (message) return message;
    const causeMessage = String(error?.cause?.message ?? '').trim();
    if (causeMessage) return causeMessage;
    return [error?.name, error?.code].filter(Boolean).join(' ') || 'unknown provider error';
}

const BASE_URL = 'https://saavn.sumit.co';
const FALLBACK_BASE_URL = 'https://jiosaavn-api-murex.vercel.app';
const MAX_SMART_RESULTS = 40;
const BIGRAM_MIN_OVERLAP = 0.35;
// Ten provider results are not enough after duplicate removal and client-side
// quality filtering. Keep collecting until there is a useful browseable set.
const SMART_SEARCH_MIN_RESULTS = 12;
const SEARCH_CACHE_FRESH_TTL_MS = 2 * 60 * 1000;
const SEARCH_CACHE_STALE_TTL_MS = 20 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 300;
const SMART_SEARCH_MAX_VARIANTS = 4;
const SMART_SEARCH_MAX_LATENCY_MS = 2000;
const PRIMARY_SEARCH_TIMEOUT_MS = 2200;
const FALLBACK_SEARCH_TIMEOUT_MS = 1800;
const CATALOG_SEARCH_TIMEOUT_MS = 1500;
const ALBUM_FETCH_TIMEOUT_MS = 4000; // album detail can be large; proxy may be slow
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
const DERIVATIVE_KEYWORDS = [
    'cover',
    'remix',
    'remixed',
    'karaoke',
    'instrumental',
    'reprise',
    'unplugged',
    'acoustic',
    'acoustic version',
    'live',
    'live version',
    'live performance',
    'lofi',
    'lo-fi',
    'lo fi',
    'slowed',
    'reverb',
    'slowed reverb',
    'slowed and reverb',
    'mashup',
    'mash-up',
    'mash up',
    'female version',
    'male version',
    'duet version',
    'stripped',
    'dj version',
    'edit version',
];

export async function requestJsonWithTimeoutExported(url, { timeoutMs, label }) {
    return requestJsonWithTimeout(url, { timeoutMs, label });
}

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
    try {
        const directPayload = await searchSongsOnlyDirect(query, 20);
        if (directPayload?.data?.results?.length > 0) {
            return directPayload;
        }
    } catch (_) {}

    return requestJsonWithTimeout(
        `${BASE_URL}/api/search?query=${encodeURIComponent(query)}&page=${page}`,
        {
            timeoutMs: 1500,
            label: 'Saavn search',
        }
    ).catch(() => ({ data: { results: [] } }));
}

export async function searchSongsOnly(query, page = 1) {
    const pageNumber = Number.parseInt(page, 10) || 1;

    // 1. Direct JioSaavn API is primary (fastest, direct DES decryption, no proxy downtime)
    try {
        const directPayload = await searchSongsOnlyDirect(query, 40);
        if (directPayload?.data?.results?.length > 0) {
            return directPayload;
        }
    } catch (_) {}

    // 2. Gaana fallback
    try {
        const gaanaSongs = await searchGaanaSongsOnly(query, 30);
        if (Array.isArray(gaanaSongs) && gaanaSongs.length > 0) {
            return wrapSongsOnlyResponse(gaanaSongs);
        }
    } catch (_) {}

    // 3. Third-party proxy fallback (best effort with short timeout)
    try {
        const primaryPayload = await searchSongsOnlyPrimary(query, pageNumber);
        if (primaryPayload?.data?.results?.length > 0) {
            return primaryPayload;
        }
    } catch (_) {}

    return wrapSongsOnlyResponse([]);
}

async function searchSongsOnlyPrimary(query, page = 1) {
    return requestJsonWithTimeout(
        `${BASE_URL}/api/search/songs?query=${encodeURIComponent(query)}&page=${page}`,
        {
            timeoutMs: 5000,
            label: 'Saavn song search',
        }
    );
}

export async function searchSongsOnlyFallback(query) {
    try {
        const gaanaSongs = await searchGaanaSongsOnly(query, 20);
        if (Array.isArray(gaanaSongs) && gaanaSongs.length > 0) {
            return gaanaSongs;
        }
    } catch (_) {}
    return [];
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
            { key: 'direct', promise: searchSongsOnlyDirect(variant, 25) },
            { key: 'gaana', promise: searchGaanaSongsOnly(variant, 20) },
        ];

        if (shouldFetchBroad && ranked.size < Math.ceil(SMART_SEARCH_MIN_RESULTS / 2)) {
            jobs.push({ key: 'primary', promise: searchSongsOnlyPrimary(variant, 1).catch(() => null) });
        }

        const settled = await Promise.allSettled(jobs.map(job => job.promise));
        const resultsByKey = {};
        for (let j = 0; j < settled.length; j += 1) {
            resultsByKey[jobs[j].key] = settled[j];
        }

        const directSongs = resultsByKey.direct?.status === 'fulfilled'
            ? (resultsByKey.direct.value?.data?.results ?? [])
            : [];
        const gaanaSongs = resultsByKey.gaana?.status === 'fulfilled'
            ? (Array.isArray(resultsByKey.gaana.value) ? resultsByKey.gaana.value : [])
            : [];
        const primarySongs = resultsByKey.primary?.status === 'fulfilled'
            ? (resultsByKey.primary.value?.data?.results ?? [])
            : [];

        addRankedSongs({
            ranked,
            songs: directSongs,
            query: normalizedQuery,
            variantIndex: i,
            sourceWeight: 20,
            languageHint,
            preferredLanguageSet,
        });
        addRankedSongs({
            ranked,
            songs: gaanaSongs,
            query: normalizedQuery,
            variantIndex: i,
            sourceWeight: 15,
            languageHint,
            preferredLanguageSet,
        });
        if (primarySongs.length > 0) {
            addRankedSongs({
                ranked,
                songs: primarySongs,
                query: normalizedQuery,
                variantIndex: i,
                sourceWeight: 10,
                languageHint,
                preferredLanguageSet,
            });
        }

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
            searchSongsOnlyDirect(normalizedQuery, 40),
            searchGaanaSongsOnly(normalizedQuery, 20),
        ]);

        const directSongs = globalSettled[0]?.status === 'fulfilled'
            ? (globalSettled[0].value?.data?.results ?? [])
            : [];
        const gaanaSongs = globalSettled[1]?.status === 'fulfilled'
            ? (Array.isArray(globalSettled[1].value) ? globalSettled[1].value : [])
            : [];

        addRankedSongs({
            ranked,
            songs: directSongs,
            query: normalizedQuery,
            variantIndex: SMART_SEARCH_MAX_VARIANTS + 1,
            sourceWeight: 10,
            languageHint,
            preferredLanguageSet,
        });
        addRankedSongs({
            ranked,
            songs: gaanaSongs,
            query: normalizedQuery,
            variantIndex: SMART_SEARCH_MAX_VARIANTS + 1,
            sourceWeight: 8,
            languageHint,
            preferredLanguageSet,
        });
    }

    // If both proxy APIs returned nothing (common when server runs outside India),
    // fall back to the official JioSaavn API with built-in URL decryption.
    if (ranked.size < SMART_SEARCH_MIN_RESULTS) {
        try {
            const directResults = await searchSongsOnlyDirect(normalizedQuery, 40);
            const directSongs = directResults?.data?.results ?? [];
            if (directSongs.length > 0) {
                addRankedSongs({
                    ranked,
                    songs: directSongs,
                    query: normalizedQuery,
                    variantIndex: SMART_SEARCH_MAX_VARIANTS + 2,
                    sourceWeight: 10,
                    languageHint,
                    preferredLanguageSet,
                });
            }
        } catch (_) {}
    }

    return buildRankedOutput(ranked);
}

/**
 * Get song details by ID.
 * @param {string} id - Song ID
 * @returns {Promise<object>} Song details
 */
export async function getSongById(id) {
    // Run direct JioSaavn API and the saavn.sumit.co proxy simultaneously.
    // The proxy returns pre-decrypted CDN URLs and is geo-transparent, making
    // it reliable from non-Indian servers where the direct API may omit stream URLs.
    const [directResult, proxyResult] = await Promise.allSettled([
        getSongDirect(id).then(song => song ? { success: true, data: [song] } : null).catch(() => null),
        requestJsonWithTimeout(
            `${BASE_URL}/api/songs/${encodeURIComponent(id)}`,
            { timeoutMs: 5000, label: 'Saavn song proxy fetch' },
        ).then(res => {
            const song = Array.isArray(res?.data) ? res.data[0] : res?.data;
            return song ? { success: true, data: [song] } : null;
        }).catch(() => null),
    ]);

    const directVal = directResult.status === 'fulfilled' ? directResult.value : null;
    const proxyVal  = proxyResult.status  === 'fulfilled' ? proxyResult.value  : null;

    // Prefer direct result if it has a stream URL; otherwise fall back to proxy
    if (directVal?.data?.[0] && _hasDownloadUrl(directVal.data[0])) return directVal;
    if (proxyVal?.data?.[0])  return proxyVal;
    if (directVal?.data?.[0]) return directVal;  // metadata-only fallback

    // Last resort: Gaana API
    try {
        const gaanaRes = await getGaanaSongById(id);
        if (gaanaRes?.success && gaanaRes.data?.length > 0) return gaanaRes;
    } catch (_) {}

    return { success: false, error: 'Service temporarily unavailable', data: [] };
}

function _hasDownloadUrl(song) {
    if (!song) return false;
    const urls = Array.isArray(song.downloadUrl) ? song.downloadUrl : [];
    return urls.some(u => u?.url?.startsWith('http'));
}

/**
 * Get album details by ID.
 * @param {string} id - Album ID
 * @returns {Promise<object>} Album details
 */
export async function getAlbumById(id, url) {
    let resolvedId = id;
    if (id && String(id).startsWith('alb_')) {
        try {
            const mapped = getProviderAlbumId(String(id), 'jiosaavn');
            if (mapped) resolvedId = mapped;
        } catch (_) {}
    }

    // Primary: direct JioSaavn API by album ID
    if (resolvedId) {
        try {
            const res = await getAlbumByIdDirect(resolvedId);
            if (_albumHasSongs(res)) return res;
        } catch (_) {}
    }

    // Secondary: fetching by perma_url (?link=)
    if (url) {
        try {
            const res = await requestJsonWithTimeout(
                `${BASE_URL}/api/albums?link=${encodeURIComponent(url)}`,
                { timeoutMs: 2000, label: 'Saavn album fetch (link)' }
            );
            if (_albumHasSongs(res)) return res;
        } catch (_) { /* fall through */ }
    }

    // Tertiary: proxy path-style fallback
    if (id) {
        try {
            const res = await requestJsonWithTimeout(
                `${BASE_URL}/api/albums/${encodeURIComponent(id)}`,
                { timeoutMs: 1500, label: 'Saavn album fetch (path)' }
            );
            if (_albumHasSongs(res)) return res;
        } catch (_) { /* fall through */ }
    }

    return { success: false, error: 'Service temporarily unavailable', data: null };
}

function _albumHasSongs(res) {
    if (!res || !res.data) return false;
    const d = res.data;
    const songs = d.songs ?? d.list ?? d.tracks;
    return Array.isArray(songs) && songs.length > 0;
}

/**
 * Search for albums.
 * @param {string} query - Search query
 * @returns {Promise<object>} Album search results
 */
export async function searchAlbums(query) {
    try {
        return await searchAlbumsDirect(query, 20);
    } catch (_) { /* fall through to proxy */ }

    try {
        return await requestJsonWithTimeout(
            `${BASE_URL}/api/search/albums?query=${encodeURIComponent(query)}`,
            {
                timeoutMs: 1500,
                label: 'Saavn album search',
            }
        );
    } catch (error) {
        return {
            success: false,
            error: error.message,
            data: { results: [] },
        };
    }
}

/**
 * Search for artists.
 * @param {string} query - Artist name or query
 * @returns {Promise<object>} Artist search results
 */
export async function searchArtists(query) {
    try {
        const directResults = await searchArtistsDirect(query, 20);
        if (directResults.length > 0) {
            return {
                success: true,
                data: { results: directResults },
            };
        }
    } catch (_) {}

    try {
        return await requestJsonWithTimeout(
            `${BASE_URL}/api/search/artists?query=${encodeURIComponent(query)}`,
            {
                timeoutMs: 1500,
                label: 'Saavn artist search',
            }
        );
    } catch (error) {
        return {
            success: false,
            error: error.message,
            data: { results: [] },
        };
    }
}

/**
 * Get an artist's songs by artist ID.
 * @param {string} artistId - Artist ID
 * @returns {Promise<object>} Artist's songs
 */
export async function getArtistSongs(artistId) {
    try {
        const directRes = await getArtistSongsDirect(artistId, 1, 30);
        if (directRes?.data?.songs?.length > 0) {
            return directRes;
        }
    } catch (_) {}

    try {
        return await requestJsonWithTimeout(
            `${BASE_URL}/api/artists/${encodeURIComponent(artistId)}/songs`,
            {
                timeoutMs: 1500,
                label: 'Saavn artist songs',
            }
        );
    } catch (error) {
        return { success: true, data: { songs: [] } };
    }
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

    try {
        const directRes = await getArtistAlbumsDirect(artistId, page, limit);
        if (directRes?.data?.albums?.length > 0) {
            return directRes;
        }
    } catch (_) {}

    try {
        return await requestJsonWithTimeout(
            `${BASE_URL}/api/artists/${encodeURIComponent(artistId)}/albums?limit=${limit}&page=${page}`,
            {
                timeoutMs: 1500,
                label: 'Saavn artist albums',
            }
        );
    } catch (error) {
        return { success: true, data: { albums: [] } };
    }
}

/**
 * Get artist details by ID.
 * @param {string} artistId - Artist ID
 * @returns {Promise<object>} Artist details
 */
export async function getArtistById(artistId) {
    try {
        const directRes = await getArtistByIdDirect(artistId);
        if (directRes?.data) {
            return directRes;
        }
    } catch (_) {}

    try {
        return await requestJsonWithTimeout(
            `${BASE_URL}/api/artists/${encodeURIComponent(artistId)}`,
            {
                timeoutMs: 1500,
                label: 'Saavn artist fetch',
            }
        );
    } catch (error) {
        return {
            success: false,
            error: error.message,
            data: null,
        };
    }
}

// Curated per-language artist seeds used when proxy providers are unavailable.
// Each name is searched individually on the JioSaavn direct API — we take the
// top result per query, which is reliably the correct artist profile.
const LANGUAGE_ARTIST_SEEDS = {
    hindi:     ['Arijit Singh', 'Shreya Ghoshal', 'Sonu Nigam', 'Neha Kakkar',
                'Jubin Nautiyal', 'Armaan Malik', 'Atif Aslam', 'Sunidhi Chauhan',
                'Kumar Sanu', 'Lata Mangeshkar', 'Kishore Kumar', 'Mohammed Rafi',
                'Udit Narayan', 'Alka Yagnik', 'KK'],
    tamil:     ['AR Rahman', 'SP Balasubrahmanyam', 'Sid Sriram', 'Anirudh Ravichander',
                'Vijay Antony', 'Hariharan', 'Karthik', 'Chinmayi', 'Ilaiyaraaja',
                'Benny Dayal', 'Haricharan', 'Andrea Jeremiah'],
    telugu:    ['SP Balasubrahmanyam', 'Sid Sriram', 'Anirudh Ravichander',
                'Shreya Ghoshal', 'Chinmayi', 'Rahul Sipligunj', 'Harika Narayan',
                'Sunitha', 'Karthik', 'Geetha Madhuri', 'Armaan Malik'],
    kannada:   ['Rajkumar', 'Shreya Ghoshal', 'Vijay Prakash', 'Sithara Krishnakumar',
                'Chandan Shetty', 'Hamsalekha', 'Udit Narayan', 'Sonu Nigam'],
    malayalam: ['KJ Yesudas', 'MG Sreekumar', 'Shreya Ghoshal', 'Sithara Krishnakumar',
                'Vijay Yesudas', 'KS Chithra', 'P Jayachandran', 'Shaan Rahman',
                'Harisankar', 'Jassie Gift'],
    punjabi:   ['Diljit Dosanjh', 'Gurnam Bhullar', 'Babbu Maan', 'Hardy Sandhu',
                'Prabh Gill', 'Amrit Maan', 'Jordan Sandhu', 'Surjit Bindrakhia',
                'Gippy Grewal', 'Mankirt Aulakh'],
    bengali:   ['Arijit Singh', 'Nachiketa Chakraborty', 'Rupankar Bagchi',
                'Shaan', 'Lagnajita Chakraborty', 'Anupam Roy', 'Usha Uthup',
                'Shreya Ghoshal', 'Sidhu'],
    english:   ['Ed Sheeran', 'Taylor Swift', 'The Weeknd', 'Coldplay',
                'Eminem', 'Justin Bieber', 'Billie Eilish', 'Ariana Grande',
                'Bruno Mars', 'Adele', 'Dua Lipa'],
    marathi:   ['Ajay Atul', 'Shreya Ghoshal', 'Vaishali Samant', 'Swapnil Bandodkar',
                'Avdhoot Gupte', 'Hrishikesh Ranade', 'Bela Shende'],
    gujarati:  ['Kirtidan Gadhvi', 'Aishwarya Majmudar', 'Premal Desai',
                'Osman Mir', 'Arijit Singh', 'Falguni Pathak'],
    bhojpuri:  ['Pawan Singh', 'Khesari Lal Yadav', 'Dinesh Lal Yadav',
                'Manoj Tiwari', 'Kalpana'],
    odia:      ['Humane Sagar', 'Ira Mohanty', 'Md Aziz', 'Tapu Mishra'],
    assamese:  ['Zubeen Garg', 'Papon', 'Nilim Kumar'],
    urdu:      ['Atif Aslam', 'Rahat Fateh Ali Khan', 'Nusrat Fateh Ali Khan',
                'Ghulam Ali', 'Mehdi Hassan', 'Arijit Singh'],
};

/**
 * Get popular artists for a specific language.
 * This is used during onboarding to show a list of artists for selection.
 * @param {string} language - Language name (e.g. "hindi", "malayalam")
 * @returns {Promise<object[]>} List of artists
 */
export async function getArtistsByLanguage(language) {
    const artistMap = new Map();
    const lang = (language || 'hindi').toLowerCase();
    const seeds = LANGUAGE_ARTIST_SEEDS[lang] ?? LANGUAGE_ARTIST_SEEDS.hindi;

    // Use JioSaavn direct API with curated per-language artist names as seed queries.
    // Searching by exact artist name reliably returns the correct profile as
    // the first result instantly without depending on dead proxies.
    const directResults = await Promise.allSettled(
        seeds.map(name => searchArtistsDirect(name, 2))
    );
    for (const result of directResults) {
        if (result.status !== 'fulfilled' || !Array.isArray(result.value)) continue;
        const top = result.value[0];
        if (top?.id) artistMap.set(String(top.id), top);
    }

    if (artistMap.size >= 5) return Array.from(artistMap.values());

    // Optional proxy fallback if direct returns < 5
    try {
        const proxyQueries = [`Top ${language} Artists`, `Popular ${language} singers`];
        const proxyResults = await Promise.allSettled(
            proxyQueries.map(q => searchArtists(q))
        );
        for (const result of proxyResults) {
            if (result.status === 'fulfilled' && result.value?.data?.results) {
                for (const artist of result.value.data.results) {
                    if (artist.id) artistMap.set(String(artist.id), artist);
                }
            }
        }
    } catch (_) {}

    return Array.from(artistMap.values());
}

/**
 * Get song lyrics by song ID.
 * @param {string} id - Song ID
 * @returns {Promise<object>} Lyrics data
 */
export async function getLyricsBySongId(id) {
    const encoded = encodeURIComponent(id);
    const candidates = [
        requestJsonWithTimeout(`${BASE_URL}/api/songs/${encoded}/lyrics`, {
            timeoutMs: 1500,
            label: 'Saavn lyrics fetch (path)',
        }),
        requestJsonWithTimeout(`${BASE_URL}/api/lyrics?id=${encoded}`, {
            timeoutMs: 1500,
            label: 'Saavn lyrics fetch (query)',
        }),
    ];

    try {
        const winner = await Promise.any(candidates);
        if (winner && (winner.data || winner.lyrics)) return winner;
    } catch (_) {}

    return { success: false, data: null };
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
    getLyricsBySongId,
};


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

    // Remove language/noise words but only if something meaningful remains.
    const tokens = tokenize(query);
    const filteredTokens = tokens.filter(token => !QUERY_NOISE_WORDS.has(token));
    if (filteredTokens.length > 0 && filteredTokens.length < tokens.length) {
        push(filteredTokens.join(' '));
    }

    // Transliteration cleanup: many Malayalam/Hindi song titles are typed with
    // one extra trailing vowel or doubled consonant. Try a slightly relaxed
    // spelling before falling back to broader truncation.
    const relaxedQuery = buildRelaxedTransliterationQuery(tokens);
    if (relaxedQuery && relaxedQuery !== normalizeQuery(query)) {
        push(relaxedQuery);
    }

    // Drop trailing token for long queries (often a typo/noise fragment).
    if (tokens.length > 3) {
        push(tokens.slice(0, -1).join(' '));
    }

    // Keep first two terms only for queries with 4+ terms.
    if (tokens.length > 3) {
        push(tokens.slice(0, 2).join(' '));
    }

    return variants.slice(0, SMART_SEARCH_MAX_VARIANTS);
}

function buildRelaxedTransliterationQuery(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return '';

    const relaxedTokens = tokens.map((token) => {
        let relaxed = normalizeQuery(token);
        if (!relaxed) return relaxed;

        // Collapse doubled letters first, then smooth common transliteration
        // endings such as "au" -> "u" or "ai" -> "i".
        relaxed = relaxed.replace(/([a-z])\1+/g, '$1');
        relaxed = relaxed
            .replace(/aa$/g, 'a')
            .replace(/ee$/g, 'e')
            .replace(/ii$/g, 'i')
            .replace(/oo$/g, 'o')
            .replace(/au$/g, 'u')
            .replace(/ai$/g, 'i');
        return relaxed;
    });

    return relaxedTokens.join(' ').trim();
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
    const primaryArtist = normalizeQuery(
        song?.artists?.primary?.[0]?.name ??
        song?.artist ??
        artists.split(',')[0] ??
        ''
    );
    const album = normalizeQuery(
        typeof song?.album === 'object' ? (song?.album?.name ?? '') : (song?.album ?? '')
    );
    const haystack = `${name} ${artists} ${album}`.trim();

    return {
        name,
        artists,
        primaryArtist,
        album,
        haystack,
        compactName: normalizeCompact(name),
        compactArtists: normalizeCompact(artists),
        compactPrimaryArtist: normalizeCompact(primaryArtist),
        compactHaystack: normalizeCompact(haystack),
        nameTokens: tokenize(name),
        artistTokens: tokenize(artists),
        albumTokens: tokenize(album),
        haystackTokens: tokenize(haystack),
        isDerivative: containsDerivativeKeyword(`${name} ${album}`),
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
        primaryArtist,
        album,
        haystack,
        compactName,
        compactArtists,
        compactPrimaryArtist,
        compactHaystack,
        nameTokens,
        artistTokens,
        albumTokens,
        haystackTokens,
        isDerivative,
    } = extractSongSearchFields(song);
    const compactQuery = normalizeCompact(query);
    const queryTerms = tokenize(query).filter(token => !QUERY_NOISE_WORDS.has(token));
    // A query such as "Malayalam songs" is a browse request, not a title
    // lookup. Treating its language and generic words as required title terms
    // rejects nearly every valid result before it reaches the client.
    const isLanguageBrowseQuery = Boolean(languageHint) && queryTerms.length === 0;
    if (isLanguageBrowseQuery) {
        const language = normalizeQuery(song.language ?? '');
        if (language !== languageHint) return null;
        return {
            score: 180 + sourceWeight - (variantIndex * 15),
            matchTier: MATCH_TIERS.CONTAINS,
        };
    }
    const effectiveTerms = queryTerms.length > 0 ? queryTerms : tokenize(query);
    const queryWantsDerivative = containsDerivativeKeyword(query);
    // For short queries (1-2 tokens), require ALL tokens to match. For longer, allow 1 miss.
    const maxMissingTerms = effectiveTerms.length > 2 ? 1 : 0;
    const minimumTermMatches = effectiveTerms.length === 0
        ? 0
        : Math.max(1, effectiveTerms.length - maxMissingTerms);

    let score = 0;
    let nameMatches = 0;
    let artistMatches = 0;
    let albumMatches = 0;
    let fuzzyMatches = 0;

    for (const term of effectiveTerms) {
        if (name.includes(term)) {
            nameMatches += 1;
            score += 25;
        } else if (artists.includes(term)) {
            artistMatches += 1;
            score += 15;
        } else if (album.includes(term)) {
            albumMatches += 1;
            score += 10;
        } else if (hasFuzzyTokenMatch(term, haystackTokens)) {
            fuzzyMatches += 1;
            score += 5;
        }
    }

    const directMatches = nameMatches + artistMatches + albumMatches;
    const totalMatches = directMatches + fuzzyMatches;
    const hasTermCoverage = effectiveTerms.length === 0 || totalMatches >= minimumTermMatches;
    const titlePhraseInQuery = Boolean(compactQuery && compactName && compactQuery.includes(compactName));
    const primaryArtistPhraseInQuery = Boolean(
        compactQuery &&
        compactPrimaryArtist &&
        compactQuery.includes(compactPrimaryArtist)
    );
    const artistPhraseInQuery = Boolean(
        compactQuery &&
        compactArtists &&
        compactQuery.includes(compactArtists)
    );
    const hasBalancedTitleArtistCoverage =
        nameMatches > 0 &&
        artistMatches > 0 &&
        directMatches >= minimumTermMatches;
    const hasStrongTitleArtistIntent =
        titlePhraseInQuery &&
        (primaryArtistPhraseInQuery || artistPhraseInQuery || artistMatches > 0) &&
        directMatches >= minimumTermMatches;
    // Bonus for having ALL terms match directly (precision signal)
    if (effectiveTerms.length > 0 && directMatches === effectiveTerms.length) {
        score += 30;
    }
    if (titlePhraseInQuery) {
        score += 22;
    }
    if (primaryArtistPhraseInQuery) {
        score += 38;
    } else if (artistPhraseInQuery) {
        score += 24;
    } else if (artistMatches > 0) {
        score += Math.min(24, artistMatches * 10);
    }

    let matchTier = null;
    if (name === query || (compactQuery && compactName === compactQuery)) {
        matchTier = MATCH_TIERS.EXACT;
        score += 300;
    } else if (hasStrongTitleArtistIntent) {
        matchTier = MATCH_TIERS.EXACT;
        score += 285;
    } else if (hasBalancedTitleArtistCoverage) {
        matchTier = MATCH_TIERS.STARTS_WITH;
        score += 235;
    } else if (
        name.startsWith(query) ||
        (compactQuery && compactName.startsWith(compactQuery))
    ) {
        matchTier = MATCH_TIERS.STARTS_WITH;
        score += 220;
    } else if (
        name.includes(query) ||
        (compactQuery && compactName.includes(compactQuery))
    ) {
        // Name-level substring match is stronger than haystack substring
        matchTier = MATCH_TIERS.CONTAINS;
        score += 160;
    } else if (
        haystack.includes(query) ||
        (compactQuery && compactHaystack.includes(compactQuery))
    ) {
        matchTier = MATCH_TIERS.CONTAINS;
        score += 120;
    } else {
        const maxCompactDistance = resolveMaxEditDistance(compactQuery.length);
        const hasCompactFuzzy = Boolean(compactQuery && compactName)
            && Math.abs(compactQuery.length - compactName.length) <= maxCompactDistance
            && levenshteinDistance(compactQuery, compactName) <= maxCompactDistance;
        const bigramScore = compactQuery && compactName
            ? bigramOverlap(compactQuery, compactName)
            : 0;
        if (hasTermCoverage && (directMatches > 0 || hasCompactFuzzy || bigramScore >= BIGRAM_MIN_OVERLAP)) {
            matchTier = MATCH_TIERS.FUZZY;
            score += 70;
        } else if (fuzzyMatches > 0 && hasTermCoverage) {
            matchTier = MATCH_TIERS.FUZZY;
            score += 50;
        }
    }

    if (matchTier == null) return null;
    if (matchTier === MATCH_TIERS.FUZZY && effectiveTerms.length >= 2 && !hasTermCoverage) {
        return null;
    }
    // Reject fuzzy matches with no direct matches and no strong bigram overlap
    if (matchTier === MATCH_TIERS.FUZZY && directMatches === 0 && fuzzyMatches <= 1) {
        const bigramScore = compactQuery && compactName
            ? bigramOverlap(compactQuery, compactName)
            : 0;
        if (bigramScore < 0.4) return null;
    }

    // Avoid noisy unrelated results for unmatched long queries.
    if (effectiveTerms.length >= 2 && totalMatches === 0 && matchTier > MATCH_TIERS.CONTAINS) {
        return null;
    }

    if (languageHint) {
        const language = normalizeQuery(song.language ?? '');
        if (language === languageHint) {
            score += 22;
        } else {
            score -= 6;
        }
    }

    if (preferredLanguageSet?.size > 0) {
        const language = normalizeQuery(song.language ?? '');
        if (preferredLanguageSet.has(language)) {
            score += 32;
        } else {
            score -= 4;
        }
    }

    if (isDerivative) {
        if (!queryWantsDerivative) {
            score -= 90;
            if (matchTier >= MATCH_TIERS.CONTAINS) {
                score -= 20;
            }
        } else {
            score += 18;
        }
    } else if (queryWantsDerivative) {
        score -= 22;
    }

    // Prefer clean original titles when the query is simple and the candidate
    // title adds a lot of extra descriptor words.
    if (!queryWantsDerivative && titlePhraseInQuery) {
        const extraNameTerms = Math.max(0, nameTokens.length - effectiveTerms.length);
        if (extraNameTerms >= 3) {
            score -= Math.min(18, extraNameTerms * 4);
        }
    }

    score += sourceWeight;
    score -= variantIndex * 15;
    if (matchTier === MATCH_TIERS.FUZZY) {
        score -= 15;
    }

    return {
        score,
        matchTier,
    };
}

function resolveMaxEditDistance(length) {
    if (length >= 12) return 2;
    if (length >= 6) return 1;
    return 1;
}

function bigramOverlap(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const bigramsA = new Set();
    for (let i = 0; i < a.length - 1; i += 1) bigramsA.add(a.slice(i, i + 2));
    let matches = 0;
    let total = 0;
    for (let i = 0; i < b.length - 1; i += 1) {
        total += 1;
        if (bigramsA.has(b.slice(i, i + 2))) matches += 1;
    }
    return total === 0 ? 0 : matches / Math.max(bigramsA.size, total);
}

function hasFuzzyTokenMatch(queryTerm, targetTokens) {
    if (!queryTerm || queryTerm.length < 3) return false;
    for (const token of targetTokens) {
        if (!token || token.length < 3) continue;
        // Tighter fuzzy: max 1 edit for shorter terms, 2 only for 8+ char terms
        const maxDistance = queryTerm.length >= 8 ? 2 : 1;
        if (Math.abs(queryTerm.length - token.length) > maxDistance) continue;
        // First character must match for single-edit tolerance,
        // or first 2 chars must share at least 1 for double-edit tolerance
        if (maxDistance <= 1 && queryTerm[0] !== token[0]) continue;
        if (maxDistance > 1 && queryTerm[0] !== token[0] && queryTerm[1] !== token[1]) continue;
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
    const queryWantsDerivative = containsDerivativeKeyword(normalizedQuery);
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
            artists,
            primaryArtist,
            haystack,
            compactName,
            compactArtists,
            compactPrimaryArtist,
            compactHaystack,
            isDerivative,
            nameTokens,
            haystackTokens,
        } = entry;
        let score = 0;
        let matches = 0;
        let nameMatches = 0;
        let artistMatches = 0;

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
            if (name.includes(term)) {
                matches += 1;
                nameMatches += 1;
                score += 14;
            } else if (artists.includes(term) || primaryArtist.includes(term)) {
                matches += 1;
                artistMatches += 1;
                score += 10;
            } else if (haystack.includes(term)) {
                matches += 1;
                score += 10;
            } else if (hasFuzzyTokenMatch(term, haystackTokens)) {
                matches += 1;
                score += 5;
            }
        }

        const titlePhraseInQuery = Boolean(
            compactQuery &&
            compactName &&
            compactQuery.includes(compactName)
        );
        const primaryArtistPhraseInQuery = Boolean(
            compactQuery &&
            compactPrimaryArtist &&
            compactQuery.includes(compactPrimaryArtist)
        );
        const artistPhraseInQuery = Boolean(
            compactQuery &&
            compactArtists &&
            compactQuery.includes(compactArtists)
        );
        const hasStrongTitleArtistIntent =
            titlePhraseInQuery &&
            (primaryArtistPhraseInQuery || artistPhraseInQuery || artistMatches > 0) &&
            matches >= minimumMatches;
        const hasBalancedTitleArtistCoverage =
            nameMatches > 0 &&
            artistMatches > 0 &&
            matches >= minimumMatches;

        if (hasStrongTitleArtistIntent) {
            score += 150;
        } else if (hasBalancedTitleArtistCoverage) {
            score += 110;
        }
        if (titlePhraseInQuery) {
            score += 20;
        }
        if (primaryArtistPhraseInQuery) {
            score += 26;
        } else if (artistPhraseInQuery) {
            score += 16;
        }

        if (minimumMatches > 0 && matches < minimumMatches && score < 70) {
            continue;
        }
        if (isDerivative && !queryWantsDerivative) {
            score -= 80;
        } else if (!isDerivative && queryWantsDerivative) {
            score -= 18;
        }
        if (!queryWantsDerivative && titlePhraseInQuery) {
            const extraNameTerms = Math.max(0, nameTokens.length - effectiveTerms.length);
            if (extraNameTerms >= 3) {
                score -= Math.min(18, extraNameTerms * 4);
            }
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

function containsDerivativeKeyword(value) {
    const normalized = normalizeQuery(value);
    if (!normalized) return false;

    for (const rawKeyword of DERIVATIVE_KEYWORDS) {
        const keyword = normalizeQuery(rawKeyword);
        if (!keyword) continue;

        if (keyword.includes(' ')) {
            if (normalized.includes(keyword)) return true;
            continue;
        }

        const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'u');
        if (pattern.test(normalized)) return true;
    }

    return false;
}

function escapeRegex(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    // JS Map preserves insertion order — delete the first key (oldest inserted)
    // when over capacity. O(1) per eviction instead of O(n).
    while (localSongIndex.size > LOCAL_INDEX_MAX_ENTRIES) {
        const firstKey = localSongIndex.keys().next().value;
        if (firstKey === undefined) break;
        localSongIndex.delete(firstKey);
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
    if (!data || (Array.isArray(data) && data.length === 0)) return;
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
    // O(1): delete the oldest inserted entry (Map preserves insertion order)
    const firstKey = smartSearchCache.keys().next().value;
    if (firstKey !== undefined) smartSearchCache.delete(firstKey);
}
