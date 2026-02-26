import { getArtistPlayCounts, getSkippedSongIds, getRecentActivity } from './database.js';
import { searchSongsOnly, searchSongsSmart, getSongById } from './saavnApi.js';
import { rerankSongsForUser } from './personalizationModel.js';

/**
 * Generate song recommendations for a user based on their preferences and activity.
 *
 * Strategy:
 *  1. Gather user's preferred languages & favorite artists
 *  2. Fetch top played artists and recent searches from activity
 *  3. Query Saavn API for songs by top artists and recent search terms
 *  4. Score results: boost frequently played artists, penalize skipped songs
 *  5. Filter by preferred languages
 *  6. Deduplicate & rank
 *
 * @param {object} userPrefs - { languages: string[], favoriteArtists: { id, name }[] }
 * @param {string} uid - User ID for fetching activity data
 * @returns {Promise<object[]>} Ranked list of recommended songs
 */
export async function generateRecommendations(userPrefs, uid) {
    const { languages = [], favoriteArtists = [] } = userPrefs;

    // Gather activity data
    const [artistPlayCounts, skippedIds, recentSearches, recentPlays] = await Promise.all([
        getArtistPlayCounts(uid, 10),
        getSkippedSongIds(uid, 100),
        getRecentActivity(uid, 'search', 10),
        getRecentActivity(uid, 'play', 20),
    ]);

    // Build a set of seed queries from multiple sources
    const seedQueries = new Set();

    // From favorite artists
    for (const artist of favoriteArtists.slice(0, 5)) {
        seedQueries.add(artist.name || artist);
    }

    // From top played artists
    for (const { artist } of artistPlayCounts.slice(0, 5)) {
        seedQueries.add(artist);
    }

    // From recent searches
    for (const search of recentSearches.slice(0, 5)) {
        if (search.query) seedQueries.add(search.query);
    }

    // If we still don't have enough seeds, use recently played song artists
    if (seedQueries.size < 3) {
        for (const play of recentPlays.slice(0, 5)) {
            if (play.artist) seedQueries.add(play.artist);
        }
    }

    // Fallback: if no data at all, use language-based generic queries
    if (seedQueries.size === 0) {
        for (const lang of languages.slice(0, 3)) {
            seedQueries.add(`Top ${lang} songs`);
        }
    }

    if (seedQueries.size === 0) {
        seedQueries.add('Top Hindi songs');
    }

    // Build artist name -> play count map for scoring
    const artistScoreMap = {};
    for (const { artist, count } of artistPlayCounts) {
        artistScoreMap[artist.toLowerCase()] = count;
    }

    // NEW: Also include artist IDs in the score map for better matching
    const favoriteArtistIds = new Set(favoriteArtists.map(a => (a.id || a).toString()));

    // Fetch songs from Saavn for each seed (in parallel, limited)
    const queries = Array.from(seedQueries).slice(0, 15);
    const results = await Promise.allSettled(
        queries.map(q => searchSongsOnly(q).catch(() => ({ data: { results: [] } })))
    );

    // Collect all candidate songs
    const songMap = new Map(); // songId -> { song, score }

    for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const data = result.value;

        const songs = data?.data?.results || data?.results || [];
        for (const song of songs) {
            const songId = song.id;
            if (!songId || songMap.has(songId)) continue;

            // Base score
            let score = 10;

            // Boost if artist is in favorites (HIGH WEIGHT)
            const songArtists = extractArtistNames(song);
            let matchFavorite = false;
            for (const favArtist of favoriteArtists) {
                const favName = (favArtist.name || favArtist || '').toLowerCase();
                if (songArtists.some(a => a.toLowerCase().includes(favName))) {
                    score += 30; // Strong boost for favorite artists
                    matchFavorite = true;
                }
            }

            // Boost if artist is frequently played
            for (const artistName of songArtists) {
                const playCount = artistScoreMap[artistName.toLowerCase()] || 0;
                score += playCount * 5; // +5 per play
            }

            // Penalize if skipped (VERY HIGH PENALTY)
            if (skippedIds.has(songId)) {
                score -= 100; // Strong skip penalty
            }

            // Language filter boost (if song language matches preference)
            const songLang = (song.language || '').toLowerCase();
            if (languages.length > 0 && languages.some(l => l.toLowerCase() === songLang)) {
                score += 10;
            }

            // Recency boost (simple)
            // Ideally we'd have year/release date, but for now we trust search order

            songMap.set(songId, { song, score });
        }
    }

    // Sort by score descending
    const ranked = Array.from(songMap.values())
        .sort((a, b) => b.score - a.score);

    // Filter: if languages are specified, prefer songs in those languages
    // but still include others if we don't have enough
    let filtered;
    if (languages.length > 0) {
        const langSet = new Set(languages.map(l => l.toLowerCase()));
        const inLang = ranked.filter(r => langSet.has((r.song.language || '').toLowerCase()));
        const notInLang = ranked.filter(r => !langSet.has((r.song.language || '').toLowerCase()));

        // Prioritize songs in preferred languages, pad with others
        filtered = [...inLang, ...notInLang].slice(0, 100);
    } else {
        filtered = ranked.slice(0, 100);
    }

    const baseRecommendationSongs = filtered.map(({ song, score }) => ({
        ...song,
        _recommendationScore: score,
    }));

    let personalizedSongs = baseRecommendationSongs;
    try {
        personalizedSongs = await rerankSongsForUser({
            uid,
            songs: baseRecommendationSongs,
            query: queries.slice(0, 4).join(' '),
            preferredLanguages: languages,
            mode: 'recommendation',
        });
    } catch (error) {
        console.error('Recommendation reranking fallback:', error?.message ?? error);
    }

    return personalizedSongs.map((song) => {
        const ruleScore = Number(song._recommendationScore || 0);
        const modelScore = Number(song?._ranking?.finalScore || 0) * 100;
        return {
            ...song,
            _recommendationScore: Number((ruleScore * 0.6 + modelScore * 0.4).toFixed(2)),
        };
    });
}

/**
 * Generate next-song recommendations using strict playback constraints:
 * - same language as current song
 * - different artist
 * - not same album
 * - not recently played/skipped
 * - prefer same genre + popular songs
 *
 * @param {{ uid: string, currentSong: object, limit?: number }} params
 * @returns {Promise<object[]>}
 */
export async function generateNextSongRecommendations({ uid, currentSong, limit = 10 }) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 20));
    const context = await resolveCurrentSongContext(currentSong);
    if (!context.songId && !context.language) {
        return [];
    }

    const [recentPlays, recentSkips] = await Promise.all([
        getRecentActivity(uid, 'play', 40),
        getRecentActivity(uid, 'skip', 40),
    ]);

    const recentSongIds = new Set([
        ...recentPlays.map(item => item.songId),
        ...recentSkips.map(item => item.songId),
    ].filter(Boolean));
    if (context.songId) {
        recentSongIds.add(context.songId);
    }

    const seedQueries = buildNextTrackSeedQueries(context);
    const settled = await Promise.allSettled(
        seedQueries.map(query => searchSongsSmart(query, {
            preferredLanguages: context.language ? [context.language] : [],
            waitForFresh: false,
        }))
    );

    const mergedSongs = mergeUniqueSongs(
        ...settled
            .filter(item => item.status === 'fulfilled')
            .map(item => item.value ?? [])
    );

    const filtered = mergedSongs
        .filter(song => validateNextTrackCandidate({
            song,
            context,
            recentSongIds,
        }))
        .map(song => ({
            song,
            score: scoreNextTrackCandidate(song, context),
        }))
        .sort((a, b) => b.score - a.score)
        .map(item => item.song);

    const reranked = await rerankSongsForUser({
        uid,
        songs: filtered.slice(0, safeLimit * 4),
        query: `${context.language || ''} ${context.genre || ''}`.trim(),
        preferredLanguages: context.language ? [context.language] : [],
        mode: 'recommendation',
    }).catch(() => filtered.slice(0, safeLimit * 4));

    return reranked.slice(0, safeLimit).map(song => ({
        ...song,
        _nextReason: {
            sameLanguage: true,
            differentArtist: true,
            differentAlbum: true,
            filteredRecent: true,
        },
    }));
}

/**
 * Extract artist names from a song object.
 * Handles various Saavn API response formats.
 */
function extractArtistNames(song) {
    const names = [];

    if (song.primaryArtists) {
        if (typeof song.primaryArtists === 'string') {
            names.push(...song.primaryArtists.split(',').map(s => s.trim()));
        } else if (Array.isArray(song.primaryArtists)) {
            for (const a of song.primaryArtists) {
                names.push(typeof a === 'string' ? a : a.name || '');
            }
        }
    }

    if (song.artists?.primary) {
        for (const a of song.artists.primary) {
            if (a.name) names.push(a.name);
        }
    }

    return names.filter(Boolean);
}

async function resolveCurrentSongContext(currentSong) {
    const input = currentSong && typeof currentSong === 'object' ? currentSong : {};
    const songId = String(input.songId || input.id || '').trim();
    const shouldFetchDetails = songId && (
        !input.language ||
        !input.artist && !input.primaryArtists &&
        !input.artists
    );

    let resolvedSong = input;
    if (shouldFetchDetails) {
        try {
            const details = await getSongById(songId);
            resolvedSong = extractSongFromDetails(details) || input;
        } catch (_error) {
            resolvedSong = input;
        }
    }

    const artists = extractArtistNames(resolvedSong).map(normalizeText);
    const artistIds = extractArtistIds(resolvedSong);
    const language = normalizeText(resolvedSong.language || input.language);
    const genre = normalizeText(resolvePrimaryGenre(resolvedSong));
    const albumId = String(
        resolvedSong?.album?.id ||
        resolvedSong?.albumId ||
        input?.album?.id ||
        input?.albumId ||
        ''
    ).trim();
    const albumName = normalizeText(
        resolvedSong?.album?.name ||
        input?.album?.name ||
        ''
    );
    const title = normalizeText(resolvedSong?.name || resolvedSong?.title || input?.songName || '');

    return {
        songId,
        language,
        genre,
        artistIds,
        artistNames: new Set(artists),
        albumId,
        albumName,
        title,
    };
}

function extractSongFromDetails(detailsPayload) {
    if (!detailsPayload || typeof detailsPayload !== 'object') return null;
    if (Array.isArray(detailsPayload?.data) && detailsPayload.data.length > 0) {
        return detailsPayload.data[0];
    }
    if (detailsPayload?.data && typeof detailsPayload.data === 'object') {
        if (Array.isArray(detailsPayload.data.songs) && detailsPayload.data.songs.length > 0) {
            return detailsPayload.data.songs[0];
        }
        if (Array.isArray(detailsPayload.data.results) && detailsPayload.data.results.length > 0) {
            return detailsPayload.data.results[0];
        }
    }
    if (Array.isArray(detailsPayload?.results) && detailsPayload.results.length > 0) {
        return detailsPayload.results[0];
    }
    return null;
}

function extractArtistIds(song) {
    const ids = new Set();
    if (Array.isArray(song?.artists?.primary)) {
        for (const artist of song.artists.primary) {
            const id = String(artist?.id || '').trim();
            if (id) ids.add(id);
        }
    }
    if (Array.isArray(song?.primaryArtists)) {
        for (const artist of song.primaryArtists) {
            const id = String(artist?.id || '').trim();
            if (id) ids.add(id);
        }
    }
    return ids;
}

function resolvePrimaryGenre(song) {
    if (song?.genre) return song.genre;
    if (Array.isArray(song?.genres) && song.genres.length > 0) return song.genres[0];
    if (typeof song?.music === 'string') return song.music;
    if (typeof song?.label === 'string') return song.label;
    return '';
}

function buildNextTrackSeedQueries(context) {
    const queries = [];
    const push = (value) => {
        const normalized = String(value || '').trim();
        if (!normalized) return;
        if (queries.includes(normalized)) return;
        queries.push(normalized);
    };

    if (context.language && context.genre) {
        push(`Top ${context.language} ${context.genre} songs`);
        push(`${context.language} ${context.genre} songs`);
    }
    if (context.language) {
        push(`Top ${context.language} songs`);
        push(`Latest ${context.language} songs`);
        push(`${context.language} songs`);
    }
    if (context.genre) {
        push(`Top ${context.genre} songs`);
    }
    if (context.title) {
        push(context.title);
    }
    if (queries.length === 0) {
        push('Top Hindi songs');
    }

    return queries.slice(0, 6);
}

function validateNextTrackCandidate({ song, context, recentSongIds }) {
    const songId = String(song?.id || '').trim();
    if (!songId) return false;
    if (recentSongIds.has(songId)) return false;

    const songLanguage = normalizeText(song?.language);
    if (context.language && songLanguage !== context.language) {
        return false;
    }

    if (isSameArtist(song, context)) return false;
    if (isSameAlbum(song, context)) return false;
    if (isDuplicateVibe(song, context)) return false;

    return true;
}

function isSameArtist(song, context) {
    const candidateArtistIds = extractArtistIds(song);
    for (const artistId of candidateArtistIds) {
        if (context.artistIds.has(artistId)) return true;
    }

    const candidateArtists = extractArtistNames(song).map(normalizeText);
    for (const artistName of candidateArtists) {
        if (context.artistNames.has(artistName)) return true;
    }

    return false;
}

function isSameAlbum(song, context) {
    const albumId = String(song?.album?.id || song?.albumId || '').trim();
    if (context.albumId && albumId && context.albumId === albumId) return true;

    const albumName = normalizeText(song?.album?.name || song?.album || '');
    if (context.albumName && albumName && context.albumName === albumName) return true;

    return false;
}

function isDuplicateVibe(song, context) {
    const currentCanonical = canonicalSongTitle(context.title);
    const candidateCanonical = canonicalSongTitle(song?.name || song?.title || '');
    if (!currentCanonical || !candidateCanonical) return false;
    if (currentCanonical === candidateCanonical) return true;

    return currentCanonical.length >= 6
        && candidateCanonical.includes(currentCanonical);
}

function canonicalSongTitle(value) {
    const normalized = normalizeText(value);
    if (!normalized) return '';

    return normalized
        .replace(/\((.*?)\)/g, ' ')
        .replace(/\[(.*?)\]/g, ' ')
        .replace(/\b(remix|version|live|slowed|reverb|karaoke|instrumental|lofi|cover)\b/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreNextTrackCandidate(song, context) {
    let score = 0;
    const language = normalizeText(song?.language);
    if (context.language && language === context.language) score += 120;

    const genre = normalizeText(resolvePrimaryGenre(song));
    if (context.genre && genre === context.genre) {
        score += 50;
    } else if (context.genre && genre.includes(context.genre)) {
        score += 30;
    }

    score += resolvePopularityScore(song) * 40;

    const year = Number.parseInt(song?.year, 10) || 0;
    if (year >= 2020) score += 8;
    else if (year >= 2015) score += 4;

    return score;
}

function resolvePopularityScore(song) {
    const raw = Number(
        song?.global_popularity_score ??
        song?.popularity ??
        song?.playCount ??
        song?.play_count ??
        0
    );
    if (!Number.isFinite(raw) || raw <= 0) return 0.2;
    return Math.min(1, Math.log10(raw + 1) / 2.6);
}

function mergeUniqueSongs(...songLists) {
    const merged = [];
    const seen = new Set();

    for (const list of songLists) {
        const safeList = Array.isArray(list) ? list : [];
        for (const song of safeList) {
            if (!song || typeof song !== 'object') continue;
            const id = String(song?.id || '').trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            merged.push(song);
        }
    }

    return merged;
}

function normalizeText(value) {
    return String(value ?? '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
}

export default {
    generateRecommendations,
    generateNextSongRecommendations,
};
