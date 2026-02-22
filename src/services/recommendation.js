import { getArtistPlayCounts, getSkippedSongIds, getRecentActivity } from './database.js';
import { searchSongsOnly, getArtistSongs } from './saavnApi.js';

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

    return filtered.map(({ song, score }) => ({
        ...song,
        _recommendationScore: score,
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

export default { generateRecommendations };
