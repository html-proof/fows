import {
    getArtistPlayCounts,
    getSkippedSongIds,
    getRecentActivity,
    getGlobalTrending,
    getCoListenedSongs,
    calculateEngagementDepth,
    getSessionPlays,
} from './database.js';
import { searchSongsOnly, searchSongsSmart, getSongById } from './saavnApi.js';
import { rerankSongsForUser } from './personalizationModel.js';

// ── Constants ──
const EXPLORATION_RATIO = 0.25; // 25% of results are exploration/discovery
const SESSION_MOOD_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ── Time-of-day mood mapping ──
const TIME_MOOD_MAP = {
    // hour -> { mood, queryHints[] }
    5:  { mood: 'calm',     queryHints: ['peaceful morning songs', 'devotional songs'] },
    6:  { mood: 'calm',     queryHints: ['morning songs', 'soft songs'] },
    7:  { mood: 'upbeat',   queryHints: ['morning motivation songs', 'upbeat songs'] },
    8:  { mood: 'upbeat',   queryHints: ['energetic songs', 'workout songs'] },
    9:  { mood: 'upbeat',   queryHints: ['happy songs', 'pop songs'] },
    10: { mood: 'focus',    queryHints: ['chill songs', 'instrumental'] },
    11: { mood: 'focus',    queryHints: ['focus music', 'lo-fi'] },
    12: { mood: 'neutral',  queryHints: ['popular songs', 'trending songs'] },
    13: { mood: 'neutral',  queryHints: ['latest songs', 'top hits'] },
    14: { mood: 'chill',    queryHints: ['afternoon vibes', 'chill songs'] },
    15: { mood: 'chill',    queryHints: ['relaxing songs', 'acoustic songs'] },
    16: { mood: 'upbeat',   queryHints: ['evening songs', 'party songs'] },
    17: { mood: 'upbeat',   queryHints: ['drive songs', 'upbeat songs'] },
    18: { mood: 'romantic',  queryHints: ['romantic songs', 'love songs'] },
    19: { mood: 'romantic',  queryHints: ['romantic songs', 'evening songs'] },
    20: { mood: 'party',    queryHints: ['party songs', 'dance songs'] },
    21: { mood: 'party',    queryHints: ['club songs', 'DJ mix'] },
    22: { mood: 'mellow',   queryHints: ['night songs', 'slow songs'] },
    23: { mood: 'mellow',   queryHints: ['sad songs', 'late night songs'] },
    0:  { mood: 'sleep',    queryHints: ['sleep songs', 'calm night songs'] },
    1:  { mood: 'sleep',    queryHints: ['lullaby songs', 'ambient'] },
    2:  { mood: 'sleep',    queryHints: ['ambient music', 'rain sounds'] },
    3:  { mood: 'sleep',    queryHints: ['calm music'] },
    4:  { mood: 'calm',     queryHints: ['early morning songs'] },
};

/**
 * Generate song recommendations for a user based on their preferences, activity,
 * session context, trending data, and collaborative signals.
 *
 * Features:
 *  1. Collaborative Filtering (co-listen pairs)
 *  2. Session Mood Detection (time-of-day + current session)
 *  3. Engagement Depth Scoring (duration/skipTime weighting)
 *  4. Exploration Mix (25% discovery songs)
 *  5. Trending/Viral Boost (global play counts)
 */
export async function generateRecommendations(userPrefs, uid) {
    const { languages = [], favoriteArtists = [] } = userPrefs;

    // Gather all data sources in parallel
    const [
        artistPlayCounts,
        skippedIds,
        recentSearches,
        recentPlays,
        trendingSongs,
        sessionPlays,
    ] = await Promise.all([
        getArtistPlayCounts(uid, 10),
        getSkippedSongIds(uid, 100),
        getRecentActivity(uid, 'search', 10),
        getRecentActivity(uid, 'play', 30),
        getGlobalTrending(30),
        getSessionPlays(uid),
    ]);

    // ── FEATURE 2: Session Mood Detection ──
    const sessionMood = detectSessionMood(sessionPlays);
    const timeMood = getTimeMood();

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

    // ── FEATURE 2: Add mood-based seed queries ──
    const moodQueries = getMoodSeedQueries(sessionMood, timeMood, languages);
    for (const mq of moodQueries) {
        seedQueries.add(mq);
    }

    // Fallback
    if (seedQueries.size === 0) {
        for (const lang of languages.slice(0, 3)) {
            seedQueries.add(`Top ${lang} songs`);
        }
    }
    if (seedQueries.size === 0) {
        seedQueries.add('Top Hindi songs');
    }

    // Build scoring maps
    const artistScoreMap = {};
    for (const { artist, count } of artistPlayCounts) {
        artistScoreMap[artist.toLowerCase()] = count;
    }

    // ── FEATURE 3: Build engagement depth map ──
    const engagementMap = buildEngagementMap(recentPlays);

    // ── FEATURE 1: Get collaborative filtering candidates ──
    const coListenCandidateIds = new Set();
    const recentlyPlayedSongIds = recentPlays
        .map(p => p.songId)
        .filter(Boolean)
        .slice(0, 10);

    let coListenResults = [];
    try {
        const coListenPromises = recentlyPlayedSongIds.slice(0, 5).map(id =>
            getCoListenedSongs(id, 10).catch(() => [])
        );
        const coListenArrays = await Promise.all(coListenPromises);
        for (const arr of coListenArrays) {
            for (const item of arr) {
                if (item.songId && item.coListenCount >= 2) {
                    coListenCandidateIds.add(item.songId);
                }
            }
        }
    } catch (_err) {
        // Collaborative filtering is best-effort
    }

    // Fetch songs from Saavn for each seed (in parallel, limited)
    const queries = Array.from(seedQueries).slice(0, 15);
    const results = await Promise.allSettled(
        queries.map(q => searchSongsOnly(q).catch(() => ({ data: { results: [] } })))
    );

    // Collect all candidate songs
    const songMap = new Map();

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
            for (const favArtist of favoriteArtists) {
                const favName = (favArtist.name || favArtist || '').toLowerCase();
                if (songArtists.some(a => a.toLowerCase().includes(favName))) {
                    score += 30;
                }
            }

            // Boost if artist is frequently played
            for (const artistName of songArtists) {
                const playCount = artistScoreMap[artistName.toLowerCase()] || 0;
                score += playCount * 5;
            }

            // Penalize if skipped (VERY HIGH PENALTY)
            if (skippedIds.has(songId)) {
                score -= 100;
            }

            // Language filter boost
            const songLang = (song.language || '').toLowerCase();
            if (languages.length > 0 && languages.some(l => l.toLowerCase() === songLang)) {
                score += 10;
            }

            // ── FEATURE 3: Engagement depth weighting ──
            const engagement = engagementMap[songId];
            if (engagement) {
                // Songs user listened to fully get a boost; quick-skips get penalized
                score += (engagement.depth - 0.5) * 20;
            }

            // ── FEATURE 1: Collaborative filtering boost ──
            if (coListenCandidateIds.has(songId)) {
                score += 15; // "Users who listened to X also listened to this"
            }

            // ── FEATURE 5: Trending/viral boost ──
            const trendingMatch = trendingSongs.find(t => t.songId === songId);
            if (trendingMatch) {
                score += Math.min(25, (trendingMatch.playCount || 0) * 2);
            }

            // ── FEATURE 2: Session mood bonus ──
            score += getMoodMatchScore(song, sessionMood, timeMood);

            songMap.set(songId, { song, score, isExploration: false });
        }
    }

    // ── FEATURE 5: Inject trending songs not already in the candidates ──
    for (const trending of trendingSongs) {
        if (!trending.songId || songMap.has(trending.songId)) continue;
        const langMatch = languages.length === 0 ||
            languages.some(l => l.toLowerCase() === (trending.language || '').toLowerCase());
        if (langMatch) {
            songMap.set(trending.songId, {
                song: {
                    id: trending.songId,
                    name: trending.songName || '',
                    artist: trending.artist || '',
                    primaryArtists: trending.artist || '',
                    language: trending.language || '',
                    _trending: true,
                    _trendingPlayCount: trending.playCount || 0,
                },
                score: 10 + Math.min(25, (trending.playCount || 0) * 2),
                isExploration: false,
            });
        }
    }

    // Sort by score descending
    const ranked = Array.from(songMap.values())
        .sort((a, b) => b.score - a.score);

    // Filter: prefer songs in language preferences
    let filtered;
    if (languages.length > 0) {
        const langSet = new Set(languages.map(l => l.toLowerCase()));
        const inLang = ranked.filter(r => langSet.has((r.song.language || '').toLowerCase()));
        const notInLang = ranked.filter(r => !langSet.has((r.song.language || '').toLowerCase()));
        filtered = [...inLang, ...notInLang].slice(0, 100);
    } else {
        filtered = ranked.slice(0, 100);
    }

    // ── FEATURE 4: Exploration Mix ──
    // Split into "known" (high score) and "exploration" (lower score / new artists)
    const totalResults = filtered.length;
    const explorationCount = Math.max(2, Math.floor(totalResults * EXPLORATION_RATIO));
    const exploitationCount = totalResults - explorationCount;

    const knownArtists = new Set();
    for (const { artist } of artistPlayCounts) {
        knownArtists.add(artist.toLowerCase());
    }
    for (const fav of favoriteArtists) {
        knownArtists.add((fav.name || fav || '').toLowerCase());
    }

    const exploitationPool = [];
    const explorationPool = [];

    for (const item of filtered) {
        const songArtists = extractArtistNames(item.song).map(a => a.toLowerCase());
        const isKnown = songArtists.some(a => knownArtists.has(a));

        if (isKnown) {
            exploitationPool.push(item);
        } else {
            item.isExploration = true;
            explorationPool.push(item);
        }
    }

    // Shuffle exploration pool for variety
    shuffleArray(explorationPool);

    // Mix: 75% exploitation (songs you'll like) + 25% exploration (new discoveries)
    const finalMix = [
        ...exploitationPool.slice(0, exploitationCount),
        ...explorationPool.slice(0, explorationCount),
    ];

    // Re-sort the final mix so exploration songs are interspersed
    // Place exploration songs at positions 3, 7, 11, 15... (every 4th position)
    const exploitation = finalMix.filter(item => !item.isExploration);
    const exploration = finalMix.filter(item => item.isExploration);
    const interspersed = [];
    let expIdx = 0;
    let explIdx = 0;

    for (let i = 0; i < finalMix.length; i++) {
        if ((i + 1) % 4 === 0 && explIdx < exploration.length) {
            interspersed.push(exploration[explIdx++]);
        } else if (expIdx < exploitation.length) {
            interspersed.push(exploitation[expIdx++]);
        } else if (explIdx < exploration.length) {
            interspersed.push(exploration[explIdx++]);
        }
    }

    const baseRecommendationSongs = interspersed.map(({ song, score, isExploration }) => ({
        ...song,
        _recommendationScore: score,
        _isExploration: isExploration,
        _sessionMood: sessionMood.mood,
        _timeMood: timeMood.mood,
    }));

    // ML reranking pass
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
 * Generate next-song recommendations using strict playback constraints.
 * Now includes collaborative filtering and engagement depth.
 */
export async function generateNextSongRecommendations({ uid, currentSong, limit = 10 }) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 10, 20));
    const context = await resolveCurrentSongContext(currentSong);
    if (!context.songId && !context.language) {
        return [];
    }

    const [recentPlays, recentSkips, coListened] = await Promise.all([
        getRecentActivity(uid, 'play', 40),
        getRecentActivity(uid, 'skip', 40),
        context.songId ? getCoListenedSongs(context.songId, 15) : Promise.resolve([]),
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

    // ── FEATURE 3: Build engagement map for scoring ──
    const engagementMap = buildEngagementMap(recentPlays);

    const filtered = mergedSongs
        .filter(song => validateNextTrackCandidate({
            song,
            context,
            recentSongIds,
        }))
        .map(song => ({
            song,
            score: scoreNextTrackCandidate(song, context, {
                engagementMap,
                coListened,
            }),
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

// ══════════════════════════════════════════════════════
// ── SESSION MOOD DETECTION (Feature 2) ──
// ══════════════════════════════════════════════════════

/**
 * Detect the "mood" of the current listening session based on
 * recent plays' tempo indicators, genres, and languages.
 */
function detectSessionMood(sessionPlays) {
    if (!Array.isArray(sessionPlays) || sessionPlays.length === 0) {
        return { mood: 'neutral', confidence: 0, genres: [], languages: [] };
    }

    const genres = [];
    const languages = [];
    const artists = [];
    let totalEngagement = 0;

    for (const play of sessionPlays) {
        if (play.genre) genres.push(play.genre.toLowerCase());
        if (play.language) languages.push(play.language.toLowerCase());
        if (play.artist) artists.push(play.artist.toLowerCase());
        totalEngagement += calculateEngagementDepth(play);
    }

    const avgEngagement = totalEngagement / sessionPlays.length;
    const topGenre = getMostFrequent(genres);
    const topLanguage = getMostFrequent(languages);

    // Infer mood from genre patterns
    let mood = 'neutral';
    if (topGenre) {
        const genreLower = topGenre.toLowerCase();
        if (['romance', 'love', 'romantic'].some(g => genreLower.includes(g))) mood = 'romantic';
        else if (['party', 'dance', 'edm', 'club'].some(g => genreLower.includes(g))) mood = 'party';
        else if (['sad', 'melancholy', 'blues'].some(g => genreLower.includes(g))) mood = 'mellow';
        else if (['rock', 'metal', 'punk'].some(g => genreLower.includes(g))) mood = 'energetic';
        else if (['classical', 'devotional', 'ambient'].some(g => genreLower.includes(g))) mood = 'calm';
        else if (['hip-hop', 'rap', 'trap'].some(g => genreLower.includes(g))) mood = 'upbeat';
    }

    return {
        mood,
        confidence: Math.min(1, sessionPlays.length / 5),
        genres: [...new Set(genres)].slice(0, 5),
        languages: [...new Set(languages)].slice(0, 3),
        avgEngagement,
    };
}

/**
 * Get mood based on current time of day.
 */
function getTimeMood() {
    const hour = new Date().getHours();
    return TIME_MOOD_MAP[hour] || { mood: 'neutral', queryHints: ['popular songs'] };
}

/**
 * Generate mood-aware seed queries combining session mood and time mood.
 */
function getMoodSeedQueries(sessionMood, timeMood, languages) {
    const queries = [];
    const lang = languages[0] || '';

    // If session has enough data, prefer session mood
    if (sessionMood.confidence >= 0.5) {
        if (sessionMood.mood === 'romantic') queries.push(`${lang} romantic songs`.trim());
        else if (sessionMood.mood === 'party') queries.push(`${lang} party songs`.trim());
        else if (sessionMood.mood === 'mellow') queries.push(`${lang} sad songs`.trim());
        else if (sessionMood.mood === 'energetic') queries.push(`${lang} rock songs`.trim());
        else if (sessionMood.mood === 'calm') queries.push(`${lang} peaceful songs`.trim());

        // Add genre-specific queries from session
        for (const genre of sessionMood.genres.slice(0, 2)) {
            queries.push(`${lang} ${genre} songs`.trim());
        }
    } else {
        // Fall back to time-of-day mood
        for (const hint of timeMood.queryHints || []) {
            queries.push(lang ? `${lang} ${hint}` : hint);
        }
    }

    return queries.slice(0, 3);
}

/**
 * Score how well a song matches the current mood context.
 */
function getMoodMatchScore(song, sessionMood, timeMood) {
    let bonus = 0;
    const songGenre = (song.genre || song.label || '').toLowerCase();

    if (sessionMood.confidence >= 0.5 && songGenre) {
        // Check if song genre aligns with session genres
        for (const genre of sessionMood.genres) {
            if (songGenre.includes(genre) || genre.includes(songGenre)) {
                bonus += 8;
                break;
            }
        }
    }

    // Time-of-day bonus for matching mood
    if (timeMood.mood === 'party' && songGenre.match(/party|dance|edm|club/)) bonus += 5;
    if (timeMood.mood === 'calm' && songGenre.match(/classical|devotional|ambient|soft/)) bonus += 5;
    if (timeMood.mood === 'romantic' && songGenre.match(/love|romantic|romance/)) bonus += 5;

    return bonus;
}

// ══════════════════════════════════════════════════════
// ── ENGAGEMENT DEPTH (Feature 3) ──
// ══════════════════════════════════════════════════════

/**
 * Build a map of engagement depth per song from recent plays.
 * Uses duration/skipTime tracking data.
 */
function buildEngagementMap(recentPlays) {
    const map = {};
    if (!Array.isArray(recentPlays)) return map;

    for (const play of recentPlays) {
        const songId = play.songId;
        if (!songId) continue;

        const depth = calculateEngagementDepth(play);
        if (!map[songId]) {
            map[songId] = { depth, count: 1 };
        } else {
            // Average engagement across multiple plays
            map[songId].count += 1;
            map[songId].depth = (map[songId].depth * (map[songId].count - 1) + depth) / map[songId].count;
        }
    }

    return map;
}

// ══════════════════════════════════════════════════════
// ── HELPER FUNCTIONS ──
// ══════════════════════════════════════════════════════

/**
 * Extract artist names from a song object.
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

function scoreNextTrackCandidate(song, context, { engagementMap = {}, coListened = [] } = {}) {
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

    // ── FEATURE 1: Collaborative filtering bonus for next-song ──
    const songId = String(song?.id || '').trim();
    const coListenMatch = coListened.find(c => c.songId === songId);
    if (coListenMatch) {
        score += Math.min(30, coListenMatch.coListenCount * 5);
    }

    // ── FEATURE 3: Engagement depth influence ──
    const engagement = engagementMap[songId];
    if (engagement) {
        score += (engagement.depth - 0.5) * 15;
    }

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
    const seenIds = new Set();
    const seenVibes = new Set(); // Stores canonicalTitle|primaryArtist

    for (const list of songLists) {
        const safeList = Array.isArray(list) ? list : [];
        for (const song of safeList) {
            if (!song || typeof song !== 'object') continue;
            const id = String(song?.id || '').trim();
            if (!id || seenIds.has(id)) continue;
            
            // Deduplicate by "vibe" (canonical title + artist)
            const title = canonicalSongTitle(song.name || song.title || '');
            const artists = extractArtistNames(song).map(normalizeText);
            const primaryArtist = artists[0] || '';
            const vibe = `${title}|${primaryArtist}`;
            
            // Only deduplicate by vibe if the title contains enough distinctive content 
            // to avoid over-filtering generic terms, while still catching clear repeats.
            if (vibe.length > 6 && seenVibes.has(vibe)) continue;

            seenIds.add(id);
            if (vibe.length > 6) seenVibes.add(vibe);
            merged.push(song);
        }
    }

    return merged;
}

function getMostFrequent(arr) {
    if (!arr || arr.length === 0) return null;
    const counts = {};
    for (const item of arr) {
        counts[item] = (counts[item] || 0) + 1;
    }
    let maxItem = null;
    let maxCount = 0;
    for (const [item, count] of Object.entries(counts)) {
        if (count > maxCount) {
            maxItem = item;
            maxCount = count;
        }
    }
    return maxItem;
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
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
