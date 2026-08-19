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
    getGaanaAlbum,
    searchAlbums,
    getLyricsBySongId,
} from '../services/saavnApi.js';
import { searchSongsDirect, searchAlbumsDirect, autocompleteAlbumSearch, getTrendingDirect } from '../services/jiosaavnDirect.js';
import {
    searchSongsOnly as searchGaanaSongsOnly,
    searchAlbums as searchGaanaAlbums,
    extractSeokeyFromUrl,
    looksLikeGaanaSeokey,
} from '../services/gaanaApi.js';
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
import { resolveStream, setCachedStream, generateTrackKey, normalizeQuality, bitrateLabelForStreamUrl } from '../services/playbackResolver.js';
import { validatePlayableStream } from '../services/streamValidator.js';
import {
    normalizeSongMetadata,
    normalizeSongList,
    normalizeAlbumMetadata,
    normalizeAlbumList,
    normalizeArtistMetadata,
    normalizeArtistList,
} from '../services/metadataService.js';

const router = Router();
const DEFAULT_LIMIT = 40;
const MIN_LIMIT = 20;
const MAX_LIMIT = 60;

// How long a search will wait for the secondary provider before answering
// without it. Cross-provider coverage is valuable but never worth making every
// search feel slow, so Gaana is best-effort: merged when it is quick enough,
// silently dropped when it is not.
const GAANA_SEARCH_BUDGET_MS = 3500;
// The budget handed to the Gaana client itself, kept just inside the lane's
// own deadline. Gaana hydrates one detail request per hit, so without an inner
// budget a slow tail meant the whole lane returned nothing and an entire
// catalogue vanished from the results; with it, the hits that arrived in time
// are merged and the stragglers finish in the background for the next search.
const GAANA_SEARCH_HYDRATION_MS = GAANA_SEARCH_BUDGET_MS - 400;

/**
 * Resolves to [promise]'s value, or to [fallback] if it has not settled within
 * [ms]. The underlying work is left running (its result is simply ignored) —
 * cancelling it would waste an upstream response that the provider cache can
 * still use for the next search.
 */
function withSearchBudget(promise, ms, fallback) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
}
/**
 * Collapses rows that are the SAME RECORDING to one entry, keeping the
 * best-ranked occurrence.
 *
 * Providers return one track once per release it appears on. A single
 * JioSaavn search for "arijit singh" comes back with 40 rows that are only 8
 * distinct songs: "Apna Bana Le" 17 times and "Zaalima" 16, each under a
 * different album — the single, the film soundtrack, three compilations, a
 * "best of". Fusion cannot collapse them because its key is title + album, and
 * the album is exactly what differs.
 *
 * The canonical id is the one identity that does see through this: it is
 * resolved from title, artist and duration, so all 17 rows carry the same
 * `trk_…`. Keying on it turns a page of 40 near-copies into a page of real
 * results.
 */
function dedupeByIdentity(items) {
    const seen = new Set();
    const out = [];
    for (const item of (Array.isArray(items) ? items : [])) {
        const key = String(item?.canonicalId ?? '').trim()
            || String(item?.id ?? '').trim();
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push(item);
    }
    return out;
}

// How deep into the ranked list to resolve canonical ids before cutting the
// page. Deduplication has to happen BEFORE the slice or the page is cut to
// `limit` rows and only then collapses to a handful — which is what made a
// search look empty. Resolving identity costs a SQLite round trip per row, so
// the depth is bounded rather than unbounded.
const IDENTITY_RESOLVE_DEPTH = 4;

// Best-effort budget for the artist-catalogue lane. It only ever adds results,
// so it must never hold a search open.
const ARTIST_CATALOGUE_BUDGET_MS = 2500;

/**
 * Round-robins a provider-grouped list so a fixed-size slice keeps every
 * provider represented. Order within a provider is preserved, and rows without
 * a provider field are treated as one group, so a single-provider list comes
 * back unchanged.
 */
function interleaveByProvider(items) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (list.length <= 1) return list;

    const buckets = new Map();
    for (const item of list) {
        const key = String(item?.provider ?? 'default');
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item);
    }
    if (buckets.size <= 1) return list;

    const lanes = [...buckets.values()];
    const out = [];
    for (let i = 0; out.length < list.length; i++) {
        for (const lane of lanes) {
            if (i < lane.length) out.push(lane[i]);
        }
    }
    return out;
}

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
            // Load-more used to query JioSaavn alone, so a user who kept
            // scrolling silently lost every Gaana-only track that page 1 had
            // shown them. Both catalogues are asked here for the same reason
            // they are asked on page 1: the second page of a search is still
            // the same search.
            const [songsRes, gaanaRes] = await Promise.allSettled([
                searchSongsOnly(nlpExpandedQuery, page),
                withSearchBudget(
                    searchGaanaSongsOnly(primaryQuery, 20 * page, { budgetMs: GAANA_SEARCH_HYDRATION_MS })
                        .catch(() => []),
                    GAANA_SEARCH_BUDGET_MS,
                    [],
                ),
            ]);
            const songsData = songsRes.status === 'fulfilled' ? songsRes.value : null;
            const rawSongs = songsData?.data?.results ?? [];
            const gaanaPageSongs = gaanaRes.status === 'fulfilled' && Array.isArray(gaanaRes.value)
                ? gaanaRes.value
                : [];
            // Gaana has no page cursor of its own, so ask for `page` pages'
            // worth of hits and drop the ones earlier pages already showed.
            const gaanaSlice = gaanaPageSongs.slice(20 * (page - 1));
            const merged = gaanaSlice.length > 0
                ? fuseSongCandidates([
                    { source: 'jiosaavn', weight: 1.0, songs: rawSongs },
                    { source: 'gaana', weight: 0.9, songs: gaanaSlice },
                ], analysis)
                : rawSongs;
            const scored = rankSongs(deduplicateSongs(merged), analysis);
            const orderedSongs = preferredLanguages.length > 0
                ? prioritizeSongsByLanguage(scored, preferredLanguages)
                : scored;
            const finalSongs = uid
                ? await rerankSongsForUser({ uid, songs: orderedSongs, query: rawQuery, preferredLanguages, mode: 'search' })
                : orderedSongs;
            const songs = normalizeSongList(
                dedupeByIdentity(
                    attachCanonicalIds(
                        finalSongs.slice(0, limit * IDENTITY_RESOLVE_DEPTH),
                    ),
                ).slice(0, limit),
            );
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
            searchSongsSmart(variant, { preferredLanguages, waitForFresh: false })
                .catch(() => [])
        );

        // Gaana runs on EVERY page-1 search, in parallel with the JioSaavn
        // variants — not only when JioSaavn comes back empty.
        //
        // The two catalogues genuinely differ, especially for regional cinema:
        // searching "Pattalam" returned plenty of Tamil tracks from JioSaavn,
        // so the zero-results fallback below never fired, and the Malayalam
        // film's entire soundtrack — which exists only on Gaana — was invisible
        // no matter how the user phrased the query. A provider that is only
        // consulted when the other one fails can never fill that kind of gap.
        //
        // Bounded so it can never slow a search down: results are merged if
        // they arrive within GAANA_SEARCH_BUDGET_MS and dropped otherwise. The
        // JioSaavn variants are unaffected either way.
        const gaanaFetch = withSearchBudget(
            searchGaanaSongsOnly(primaryQuery, 20, { budgetMs: GAANA_SEARCH_HYDRATION_MS })
                .catch(() => []),
            GAANA_SEARCH_BUDGET_MS,
            [],
        );

        const [songResults, albumsData, artistsData, gaanaSongs] = await Promise.allSettled([
            Promise.all(songFetches),
            searchAlbums(albumSearchQuery),
            searchArtists(primaryQuery),
            gaanaFetch,
        ]);

        // ── Step 4: Merge + deduplicate + rank songs ─────────────────────────
        let candidateGroups = songResults.status === 'fulfilled'
            ? songResults.value.map((songs, index) => ({
                source: index === 0 ? 'exact' : `variant:${index}`,
                weight: Math.max(0.45, 1 - index * 0.15),
                songs,
            }))
            : [];

        // Merge the Gaana lane as its own retrieval group. Weight sits just
        // below the exact JioSaavn variant (1.0) so cross-provider coverage is
        // additive: a Gaana-only soundtrack ranks high enough to be found,
        // without displacing an exact match from the primary catalogue.
        // Cross-provider duplicates collapse in fuseSongCandidates — Gaana rows
        // carry no songId/canonicalId, so getSongIdentityKey falls through to
        // the normalized title::artist key that both providers share.
        const gaanaList = gaanaSongs.status === 'fulfilled' && Array.isArray(gaanaSongs.value)
            ? gaanaSongs.value
            : [];
        if (gaanaList.length > 0) {
            candidateGroups.push({ source: 'gaana', weight: 0.9, songs: gaanaList });
        }

        // ── Artist queries deserve the artist's catalogue ───────────────────
        // A search for a performer is answered by the search endpoint with
        // whatever tracks happen to mention the name, and those collapse hard
        // once same-recording duplicates are removed: "arijit singh" yields
        // barely twenty distinct songs out of forty rows. The artist's own
        // track list is the obvious source for the rest, and it is one request
        // against an id the artist lane has already resolved.
        //
        // Gated on the query actually naming that artist, so a song search that
        // happens to surface an artist card never gets flooded with their back
        // catalogue.
        const topArtist = artistsData.status === 'fulfilled'
            ? (artistsData.value?.data?.results ?? [])[0]
            : null;
        const artistNameMatchesQuery = topArtist
            && areSearchTermsSimilar(normText(topArtist.name ?? ''), normText(primaryQuery));
        if (topArtist?.id && artistNameMatchesQuery) {
            const artistSongs = await withSearchBudget(
                getArtistSongs(String(topArtist.id)).catch(() => null),
                ARTIST_CATALOGUE_BUDGET_MS,
                null,
            );
            const list = artistSongs?.data?.songs ?? artistSongs?.data?.results ?? [];
            if (Array.isArray(list) && list.length > 0) {
                // Below the search variants: these are relevant by artist, not
                // by the query text, so they fill the page rather than lead it.
                candidateGroups.push({ source: 'artist-catalogue', weight: 0.6, songs: list });
            }
        }

        // Fallback: if JioSaavn AND Gaana both yielded nothing, try direct
        // JioSaavn (a different endpoint from the variant search) before
        // giving up.
        const totalVariantSongs = candidateGroups.reduce((acc, g) => acc + (Array.isArray(g.songs) ? g.songs.length : 0), 0);
        if (totalVariantSongs === 0) {
            const directSaavn = await searchSongsDirect(rawQuery, 20).catch(() => []);
            if (Array.isArray(directSaavn) && directSaavn.length > 0) {
                candidateGroups.push({ source: 'direct-fallback', weight: 1.0, songs: directSaavn });
            }
        }

        // minKeep is the floor on how many songs survive relevance filtering.
        // Pinning it at 20 while the client asked for `limit` (up to 60) threw
        // away results the user had explicitly requested, which is a large part
        // of "not all the songs are showing" — especially for the second
        // provider, whose rows score slightly lower and were the first to be
        // cut.
        const rankedByEngine = filterRelevantSongs(
            fuseSongCandidates(candidateGroups, analysis),
            analysis,
            { minKeep: limit },
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
                    const albumDetail = await Promise.race([
                        getAlbumById(matchedAlbum.id, matchedAlbum.url),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('album timeout')), 2000)),
                    ]);
                    const albumSongs = albumDetail?.data?.songs ?? albumDetail?.data?.list ?? [];
                    if (albumSongs.length > 0) {
                        const ranked = filterRelevantSongs(
                            fuseSongCandidates([
                                { source: 'album', weight: 0.85, songs: rankSongs(deduplicateSongs(albumSongs), analysis) },
                                { source: 'search', weight: 1.1, songs: finalRanked },
                            ], analysis),
                            analysis,
                            { minKeep: limit },
                        );
                        finalRanked = ranked;
                    }
                } catch (_) { /* album fetch is best-effort */ }
            }
        }

        // Final identity pass, applied to more rows than fit on the page so
        // that collapsing duplicates pulls the next real songs up into the
        // freed slots instead of leaving a short page.
        const songsOut = normalizeSongList(
            dedupeByIdentity(
                attachCanonicalIds(
                    finalRanked.slice(0, limit * IDENTITY_RESOLVE_DEPTH),
                ),
            ).slice(0, limit),
        );

        // The album lanes are merged provider-by-provider upstream (JioSaavn
        // first, then Gaana), so a flat `.slice(0, ALBUM_LIMIT)` cut Gaana off
        // entirely whenever JioSaavn alone filled the list — the exact case
        // where the missing album is the one only Gaana has. Interleaving keeps
        // both catalogues represented inside the same cap.
        const albumsOut = normalizeAlbumList(
            interleaveByProvider(
                albumsData.status === 'fulfilled' ? (albumsData.value?.data?.results ?? []) : [],
            ).slice(0, ALBUM_LIMIT)
        );
        const artistsOut = normalizeArtistList(
            artistsData.status === 'fulfilled'
                ? (artistsData.value?.data?.results ?? []).slice(0, ALBUM_LIMIT)
                : []
        );

        _rememberAlbumNames(albumsOut);

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
        if (data?.data && Array.isArray(data.data)) {
            data.data = normalizeSongList(data.data);
        } else if (data?.data && typeof data.data === 'object') {
            data.data = normalizeSongMetadata(data.data);
        }
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
            // Touch: re-insert to move to end so LRU eviction keeps hot entries
            _lyricsCache.delete(songId);
            _lyricsCache.set(songId, cached);
            return res.json(cached.data);
        }

        const data = await getLyricsBySongId(songId);
        _lyricsCache.set(songId, { data, expiresAt: now + _LYRICS_TTL_MS });
        // LRU eviction: Map preserves insertion order; first key is least-recently-used
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
//
// Opening an album is the hottest read in the app, and every tap used to pay
// the full upstream round trip plus canonical-id assignment and normalisation
// all over again -- the tenth open of an album was exactly as slow as the
// first. Cache the finished payload and collapse simultaneous taps onto a
// single fetch, so a repeat open (and the second half of a double tap) answers
// from memory in about a millisecond.
//
// The TTL stays well under the ~25 min JioSaavn CDN URL lifetime so a cached
// album can never hand the player a stream URL that has already expired.
const _albumCache = new Map();    // cacheKey -> { data, expiresAt }
const _albumInFlight = new Map(); // cacheKey -> Promise<data>
const _ALBUM_TTL_MS = 10 * 60 * 1000; // 10 min
const _ALBUM_CACHE_MAX = 300;

function _readAlbumCache(key) {
    const hit = _albumCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        _albumCache.delete(key);
        return null;
    }
    // Re-insert so Map insertion order stays least-recently-used first, which
    // is what the eviction in _writeAlbumCache relies on.
    _albumCache.delete(key);
    _albumCache.set(key, hit);
    return hit.data;
}

function _writeAlbumCache(key, data) {
    _albumCache.set(key, { data, expiresAt: Date.now() + _ALBUM_TTL_MS });
    if (_albumCache.size > _ALBUM_CACHE_MAX) {
        _albumCache.delete(_albumCache.keys().next().value);
    }
}

// Pre-warm playbackResolver's stream cache for every track in this album.
//
// The album payload's streamUrl is the TOP bitrate (320kbps). The cache is
// keyed per quality tier, and setCachedStream defaults to the 'normal' tier --
// so warming it with this URL used to file a 320kbps stream under 'normal',
// which is the tier every request without an explicit ?quality= resolves to.
// Opening an album page therefore pinned each of its tracks to ~8 MB/song for
// the next 15 minutes, no matter what quality the player asked for.
//
// Warm the tier the URL actually belongs to instead, so a 'normal' or 'low'
// request still resolves its own bitrate.
//
// This runs on cached responses too: it is pure in-memory bookkeeping, and the
// resolver's own cache expires sooner than this route's, so re-warming keeps a
// tap-to-play after a cached album open just as fast as after a cold one.
function _warmAlbumStreams(album) {
    if (!Array.isArray(album?.songs)) return;
    for (const song of album.songs) {
        if (!song.streamUrl) continue;
        const bitrate = bitrateLabelForStreamUrl(song.streamUrl);
        const streamInfo = {
            streamUrl: song.streamUrl,
            bitrate,
            contentType: song.streamUrl.includes('.mp4') ? 'audio/mp4' : 'audio/mpeg',
            isHls: song.streamUrl.includes('.m3u8'),
            // An album can arrive from either catalogue -- including via the
            // cross-provider recovery below -- and the provider decides which
            // Referer/Origin the stream is fetched with, so read it off the URL
            // rather than assuming.
            provider: /gaana|akamaized\.net/i.test(song.streamUrl) ? 'gaana' : 'jiosaavn',
            title: song.name || song.title,
            artist: song.artist || song.primaryArtists,
        };
        const tier = normalizeQuality(bitrate);
        if (song.id) setCachedStream(song.id, streamInfo, tier);
        if (song.canonicalId) setCachedStream(song.canonicalId, streamInfo, tier);
        if (song.providerId) setCachedStream(song.providerId, streamInfo, tier);
        const trackKey = generateTrackKey(song.id, song.name, song.artist, album.name);
        setCachedStream(trackKey, streamInfo, tier);
    }
}

// ─── Album title memory ───────────────────────────────────────────────────────
// Every album a client can open, it opened from a list WE served -- a search
// result, an artist page, a home row -- so the title was in our hands one
// request earlier. Remembering it means a failed album lookup can still be
// recovered by name even when the client sends nothing but a numeric id.
const _albumNames = new Map(); // album id -> title
const _ALBUM_NAME_MAX = 800;

function _rememberAlbumNames(albums) {
    for (const album of (Array.isArray(albums) ? albums : [])) {
        const id = String(album?.id ?? '').trim();
        const title = String(album?.name ?? album?.title ?? '').trim();
        if (!id || !title || title === 'Unknown Album') continue;
        if (_albumNames.has(id)) _albumNames.delete(id);
        _albumNames.set(id, title);
    }
    while (_albumNames.size > _ALBUM_NAME_MAX) {
        _albumNames.delete(_albumNames.keys().next().value);
    }
}

function _recallAlbumName(id) {
    const key = String(id ?? '').trim();
    return key ? (_albumNames.get(key) ?? '') : '';
}

/** The track list inside an album detail payload, or [] for anything else. */
function _payloadSongs(payload) {
    const d = payload?.data;
    if (!d || Array.isArray(d.results)) return [];
    const songs = d.songs ?? d.list ?? d.tracks;
    return Array.isArray(songs) ? songs : [];
}

/** True when an album payload actually carries a track list. */
function _payloadHasSongs(payload) {
    return _payloadSongs(payload).length > 0;
}

/**
 * How many of an album's tracks arrive with a usable stream.
 *
 * An album can load perfectly and still be unplayable: Gaana embeds an
 * encrypted `urls` block per track that occasionally fails to decrypt, and a
 * JioSaavn album can come back without `encrypted_media_url` on any track. Both
 * produce a full track list with nothing behind it -- the "no playable songs"
 * case, which is distinct from "album not found" and needs the same recovery.
 */
function _payloadPlayableCount(payload) {
    return _payloadSongs(payload).filter(song => {
        if (typeof song?.streamUrl === 'string' && song.streamUrl.startsWith('http')) return true;
        return Array.isArray(song?.downloadUrl)
            && song.downloadUrl.some(d => typeof d?.url === 'string' && d.url.startsWith('http'));
    }).length;
}

/**
 * Best available name for an album we could not open.
 *
 * The client sends one when it has it (it came from a search result), and when
 * it does not, both providers' identifiers still carry it: a Gaana seokey IS
 * the slugified title, and a JioSaavn perma_url embeds the same slug one path
 * segment before the id.
 */
function _albumNameHint({ name, id, link }) {
    const explicit = String(name ?? '').trim() || _recallAlbumName(id);
    if (explicit) return explicit;

    const slug = link ? extractSeokeyFromUrl(link) : (id && looksLikeGaanaSeokey(id) ? id : '');
    const words = String(slug ?? '').replace(/[-_]+/g, ' ').trim();
    // A bare id ("x2r2JfQW98M_", "55455073") slugifies into noise, not a title.
    if (!words || words.length < 3 || !/[a-z]/i.test(words)) return '';
    return words;
}

// How many album candidates a recovery may open before giving up. Each one is
// a full detail request, and a wrong guess is worse than an honest failure, so
// this stays small.
const ALBUM_RECOVERY_MAX_CANDIDATES = 3;

// Wall-clock ceiling for the whole recovery attempt.
const ALBUM_RECOVERY_BUDGET_MS = 6000;

/**
 * Reopen an album through the OTHER catalogue after the direct lookup failed.
 *
 * An album id belongs to exactly one provider, so when its own provider cannot
 * serve it there is nothing further to try on that side -- which is why this
 * screen failed outright ("album not available / no playable songs") even for
 * albums the other catalogue carries in full. The id is useless across the
 * divide, but the NAME is not: both providers index the same releases under
 * near-identical titles.
 *
 * Only a confident title match is accepted, and only a payload that actually
 * contains tracks is returned, so a recovery either opens the album the user
 * asked for or changes nothing.
 */
async function _recoverAlbumAcrossProviders({ nameHint, failedProvider }) {
    if (!nameHint) return null;
    const target = normText(nameHint);
    if (!target) return null;

    const [jioRes, gaanaRes] = await Promise.allSettled([
        searchAlbumsDirect(nameHint, 5),
        searchGaanaAlbums(nameHint, 5),
    ]);

    const jioAlbums = jioRes.status === 'fulfilled' ? (jioRes.value?.data?.results ?? []) : [];
    const gaanaAlbums = gaanaRes.status === 'fulfilled' ? (gaanaRes.value?.data?.results ?? []) : [];

    const candidates = [
        ...gaanaAlbums.map(album => ({ album, provider: 'gaana' })),
        ...jioAlbums.map(album => ({ album, provider: 'jiosaavn' })),
    ].filter(({ album }) => areSearchTermsSimilar(normText(album?.name ?? album?.title ?? ''), target));

    // The provider that just failed goes last: it is the least likely to
    // suddenly answer, but a different release id on the same catalogue is
    // still a better outcome than an error screen.
    candidates.sort((a, b) => (a.provider === failedProvider ? 1 : 0) - (b.provider === failedProvider ? 1 : 0));

    // Keeps the best non-playable-but-populated payload seen, in case no
    // candidate turns out to have streams.
    let best = null;

    for (const { album, provider } of candidates.slice(0, ALBUM_RECOVERY_MAX_CANDIDATES)) {
        const key = provider === 'gaana'
            ? (album.seokey || album.id)
            : (album.id || album.url);
        if (!key) continue;
        try {
            const detail = provider === 'gaana'
                ? await getGaanaAlbum(key)
                : await getAlbumById(album.id, album.url);
            if (_payloadPlayableCount(detail) > 0) return detail;
            if (!best && _payloadHasSongs(detail)) best = detail;
        } catch (_) { /* try the next candidate */ }
    }

    return best;
}

async function _loadAlbumPayload({ id, link, query, provider, name }) {
    let data;
    // A Gaana album is identified by a seokey slug, never by the numeric id
    // JioSaavn uses, so an explicit ?provider=gaana -- or an id that is plainly
    // a slug -- goes straight to Gaana instead of burning the JioSaavn attempts
    // that are guaranteed to miss first.
    const wantsGaana = provider === 'gaana'
        || (id && looksLikeGaanaSeokey(id))
        || (link && /(^|\.)gaana\.com/i.test(link));

    if (wantsGaana && (id || link)) {
        data = await getGaanaAlbum(id || link);
    } else if (id) {
        data = await getAlbumById(id);
    } else if (link) {
        data = await getAlbumById(null, link);
    } else {
        data = await searchAlbums(query);
    }

    // The id lookup came back empty, or came back with a track list that has
    // no streams behind it. An album id is meaningless to the other provider,
    // so without a name-based second attempt the screen simply fails -- even
    // for albums the other catalogue carries in full.
    if (!query && _payloadPlayableCount(data) === 0) {
        // Bounded: recovery costs two searches plus up to three album detail
        // requests, and Gaana's album endpoint alone can take several seconds.
        // An album screen that eventually fails is bad; one that hangs while
        // failing is worse.
        const recovered = await withSearchBudget(
            _recoverAlbumAcrossProviders({
                nameHint: _albumNameHint({ name, id, link }),
                failedProvider: wantsGaana ? 'gaana' : 'jiosaavn',
            }).catch(() => null),
            ALBUM_RECOVERY_BUDGET_MS,
            null,
        );
        // Only take the recovery when it is genuinely better. A track list the
        // player can still resolve by id beats replacing it with a worse one.
        if (recovered && _payloadPlayableCount(recovered) > 0) {
            data = recovered;
        } else if (recovered && !_payloadHasSongs(data)) {
            data = recovered;
        }
    }

    // Normalise: depending on the source, tracks may be under `list` or
    // `tracks`; unify everything to `songs` before sending to the client.
    if (data?.data) {
        const alt = data.data.list ?? data.data.tracks;
        if (Array.isArray(alt) && !Array.isArray(data.data.songs)) {
            data = { ...data, data: { ...data.data, songs: alt } };
        }
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

    // A `query` lookup answers with a RESULT SET, not one album. Normalising it
    // as a single album collapsed the whole list into one "Unknown Album" with
    // zero songs, which is why album search never showed anything useful.
    if (Array.isArray(data?.data?.results)) {
        const results = normalizeAlbumList(data.data.results);
        _rememberAlbumNames(results);
        return { success: true, data: { results } };
    }

    if (data?.data) {
        data = {
            success: true,
            data: normalizeAlbumMetadata(data.data),
        };
    }

    return data;
}

router.get('/albums', async (req, res) => {
    try {
        const { id, query, link } = req.query;
        const provider = String(req.query.provider ?? '').trim().toLowerCase() || null;
        // Optional: the album title the client already has from the search
        // result it opened. It is only ever a recovery hint -- the id still
        // decides which album is loaded.
        const name = String(req.query.name ?? req.query.title ?? '').trim();

        if (!id && !query && !link) {
            return res.status(400).json({ error: 'Either "id", "query", or "link" parameter is required' });
        }

        const cacheKey = `${provider ?? 'auto'}|` + (id ? `id:${id}`
            : link ? `link:${link}`
            : `query:${String(query).trim().toLowerCase()}`);

        let data = _readAlbumCache(cacheKey);

        if (!data) {
            let pending = _albumInFlight.get(cacheKey);
            if (!pending) {
                pending = _loadAlbumPayload({ id, link, query, provider, name })
                    .finally(() => _albumInFlight.delete(cacheKey));
                _albumInFlight.set(cacheKey, pending);
            }
            data = await pending;

            // Never cache a failure: a 503 that sticks for 10 minutes is far
            // worse than re-paying one upstream round trip.
            if (data?.data && data?.success !== false) _writeAlbumCache(cacheKey, data);
        }

        // Only album *detail* payloads carry tracks worth warming; a search
        // result set has none.
        _warmAlbumStreams(data?.data);

        // Return 503 (not 200) when all fallbacks failed so Cloudflare does NOT
        // cache the failure response. A 200 success:false gets cached for hours.
        if (data?.success === false && !data?.data) {
            return res.status(503).json({
                ...data,
                code: 'ALBUM_UNAVAILABLE',
                error: data.error || 'This album could not be opened on either provider',
            });
        }

        // Let the edge and the client answer repeat opens without reaching us at
        // all -- but bounded by the same TTL as the in-process cache, NOT by the
        // generic 1 h/6 h album policy in app.js. That policy is right for album
        // metadata and wrong for this payload: the track list it carries embeds
        // stream URLs, and Gaana's are signed with a ~4 h expiry, so a 6 h edge
        // copy would keep serving links that no longer play.
        const albumMaxAge = Math.floor(_ALBUM_TTL_MS / 1000);
        res.set('Cache-Control', `public, max-age=${albumMaxAge}, s-maxage=${albumMaxAge}`);
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
        let data = await getAlbumById(null, link);
        if (!data?.data?.name) return res.status(404).json({ error: 'Album not found' });
        if (data?.data) {
            data = {
                success: true,
                data: normalizeAlbumMetadata(data.data),
            };
        }
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
        let urls = null;

        const cached = _streamCache.get(songId);
        if (cached && cached.expiresAt > now) {
            urls = cached.urls;
        } else {
            try {
                const data = await getSongById(songId);
                const song = data?.data?.[0] ?? data?.data ?? null;
                if (song) {
                    urls = song.downloadUrl ?? song.streamUrl ?? [];
                    if (urls.length) {
                        _streamCache.set(songId, { urls, expiresAt: now + _STREAM_TTL_MS });
                        if (_streamCache.size > 1000) _streamCache.delete(_streamCache.keys().next().value);
                    }
                }
            } catch (_) {}
        }

        if (urls && urls.length) {
            // Pick requested quality, fall back down the chain
            const urlMap = Object.fromEntries(urls.map(u => [u.quality, u.url]));
            const startIdx = Math.max(0, QUALITY_ORDER.indexOf(quality));
            let chosenUrl = null;
            let chosenQuality = null;
            for (const q of QUALITY_ORDER.slice(startIdx)) {
                if (urlMap[q]) { chosenUrl = urlMap[q]; chosenQuality = q; break; }
            }
            if (!chosenUrl) { chosenUrl = urls[0].url; chosenQuality = urls[0].quality; }

            if (chosenUrl) {
                return res.json({
                    success: true,
                    data: {
                        songId,
                        streamUrl: chosenUrl,
                        quality: chosenQuality,
                        allQualities: urls.map(u => ({ quality: u.quality, url: u.url })),
                    },
                });
            }
        }

        // Fallback to verified parallel playback resolver
        const resolved = await resolveStream(songId, {
            forceRefresh: true,
            overrideTrack: {
                title: req.query.title ?? '',
                artist_name: req.query.artist ?? '',
                album_name: req.query.album ?? '',
                duration_ms: req.query.duration ? parseInt(req.query.duration, 10) * 1000 : undefined,
                language: req.query.language ?? '',
            }
        });

        return res.json({
            success: true,
            data: {
                songId,
                streamUrl: resolved.url,
                quality: resolved.quality,
                provider: resolved.provider,
                validationStatus: resolved.validationStatus,
                allQualities: [{ quality: resolved.quality, url: resolved.url }],
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

        // Step 3: from recommended albums, surface 1 top song each — fetched in parallel
        const albumResults = await Promise.allSettled(
            recoAlbums.slice(0, 8).map(album => getAlbumById(album.id ?? album.albumid))
        );
        const recommendations = [];
        for (let i = 0; i < albumResults.length; i++) {
            if (recommendations.length >= limit) break;
            if (albumResults[i].status !== 'fulfilled') continue;
            const albumDetail = albumResults[i].value;
            const album = recoAlbums[i];
            const songs = albumDetail?.data?.songs ?? albumDetail?.data?.list ?? [];
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
        }

        res.json({ success: true, data: normalizeSongList(attachCanonicalIds(recommendations.slice(0, limit))) });
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

    const now = Date.now();
    const cached = _trendingCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return res.json({ success: true, data: cached.data.slice(0, limit) });
    }

    try {
        // getTrendingDirect uses undici (not Node fetch) — works from any region.
        const rawData = await getTrendingDirect(type, language, limit);
        if (rawData.length > 0) {
            // Normalize so every item carries imageUrl/artwork like all other
            // endpoints; getTrendingDirect only emits a raw `image` field.
            const data = type === 'album' ? normalizeAlbumList(rawData) : normalizeSongList(rawData);
            _trendingCache.set(cacheKey, { data, expiresAt: now + _TRENDING_TTL_MS });
            return res.json({ success: true, data });
        }
    } catch (err) {
        // log and fall through to search-based fallback
        console.warn('Trending direct failed, using fallback:', err.message);
    }

    // Fallback: surface recent popular songs via search
    try {
        const query = type === 'album' ? `top ${language} albums` : `top ${language} songs`;
        const results = await searchSongsOnly(query, 20);
        const fallback = normalizeSongList((results?.data?.results ?? []).slice(0, limit));
        if (fallback.length > 0) {
            _trendingCache.set(cacheKey, { data: fallback, expiresAt: now + 2 * 60 * 1000 });
            return res.json({ success: true, data: fallback });
        }
    } catch (_) {}

    res.json({ success: true, data: [] });
});

export default router;
