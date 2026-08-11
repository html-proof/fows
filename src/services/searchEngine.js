/**
 * Search Engine — Query Analysis, Scoring, Ranking, Deduplication
 *
 * Core principle: never expose raw API order to users.
 * Every result passes through intent analysis → scoring → deduplication → ranking.
 */

// ─── Language dictionary ──────────────────────────────────────────────────────

const LANGUAGE_MAP = new Map([
    ['malayalam', 'malayalam'], ['mallu', 'malayalam'], ['mollywood', 'malayalam'],
    ['hindi', 'hindi'], ['bollywood', 'hindi'], ['desi', 'hindi'],
    ['tamil', 'tamil'], ['kollywood', 'tamil'],
    ['telugu', 'telugu'], ['tollywood', 'telugu'],
    ['kannada', 'kannada'], ['sandalwood', 'kannada'],
    ['english', 'english'], ['western', 'english'],
    ['punjabi', 'punjabi'], ['bhangra', 'punjabi'],
    ['bengali', 'bengali'], ['bangla', 'bengali'],
    ['marathi', 'marathi'],
    ['gujarati', 'gujarati'],
    ['odia', 'odia'], ['oriya', 'odia'],
    ['urdu', 'urdu'],
    ['assamese', 'assamese'],
]);

// Keywords that indicate a non-original version
const VERSION_MARKERS = new Set([
    'remix', 'cover', 'slowed', 'reverb', 'karaoke', 'instrumental',
    'acoustic', 'live', 'unplugged', 'mashup', 'lofi', 'lo-fi',
    'sped up', 'nightcore', 'remastered', 'extended', 'radio edit',
    'reprise', 'reprise version', 'redux', 'rework', 'edit', 'version',
    'cover version', 'tribute', 'recreation',
]);

// Keywords that indicate mood/activity searches
const MOOD_SUFFIXES = new Set([
    'songs', 'music', 'hits', 'playlist', 'top', 'best', 'latest',
    'new', 'old', 'classic', 'greatest',
]);

const TRAILING_QUERY_NOISE = new Set([
    'song',
    'songs',
    'music',
    'movie',
    'film',
    'album',
    'soundtrack',
    'ost',
    'official',
    'audio',
    'video',
    'lyrics',
    'full',
    'track',
]);

// ─── Query Analysis ───────────────────────────────────────────────────────────

/**
 * Decompose a raw search query into structured intent.
 *
 * Examples:
 *   "malare"                   → { cleanTitle: "malare" }
 *   "malare premam malayalam"  → { cleanTitle: "malare", movie: "premam", language: "malayalam" }
 *   "malare vijay yesudas"     → { cleanTitle: "malare vijay yesudas" }  (can't reliably split)
 *   "arijit singh"             → { cleanTitle: "arijit singh", likelyArtist: true }
 *   "blinding lights remix"    → { cleanTitle: "blinding lights", versionHints: ["remix"] }
 */
export function analyzeQuery(rawQuery) {
    const query = String(rawQuery ?? '').replace(/\s+/g, ' ').trim();
    if (!query) {
        return { originalQuery: '', cleanTitle: '', language: null, movie: null, versionHints: [], isVersionSearch: false, isKnownItemSearch: false, intent: 'EMPTY', likelyArtist: false };
    }

    const lower = query.toLowerCase();
    const tokens = lower.split(/\s+/).filter(Boolean);

    let language = null;
    let movie = null;
    const versionHints = [];
    const usedTokenIndices = new Set();

    // 1. Extract language tokens (trailing preferred)
    for (let i = tokens.length - 1; i >= 0; i--) {
        if (LANGUAGE_MAP.has(tokens[i])) {
            language = LANGUAGE_MAP.get(tokens[i]);
            usedTokenIndices.add(i);
            break; // only strip one language token
        }
    }

    // 2. Extract movie from parentheticals: "song (premam)" or "(from premam)"
    const parenMatch = query.match(/\(\s*(?:from\s+)?([^)]{1,60})\s*\)/i);
    if (parenMatch) {
        movie = parenMatch[1].trim();
        // Remove the parenthetical from the query string for title extraction
    }

    // Also support the natural form "song name from movie name". Without
    // this split the provider receives one long query and the album/movie
    // lookup is performed against the song title instead of the movie.
    const fromMatch = query.match(/^(.+?)\s+from\s+(.+)$/i);
    if (!movie && fromMatch) {
        const possibleMovie = fromMatch[2].trim();
        if (possibleMovie.length >= 2) {
            movie = possibleMovie;
        }
    }

    // 3. Detect version hints
    for (const marker of VERSION_MARKERS) {
        if (lower.includes(marker)) {
            versionHints.push(marker);
        }
    }

    // 4. Build clean title: original query minus language token and parenthetical
    let cleanTitle = query;
    if (parenMatch) {
        cleanTitle = cleanTitle.replace(parenMatch[0], '').trim();
    }
    if (fromMatch && movie === fromMatch[2].trim()) {
        cleanTitle = fromMatch[1].trim();
    }

    // Remove trailing language word from cleanTitle
    if (language) {
        const escapedLang = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        cleanTitle = cleanTitle.replace(new RegExp(`\\s+${escapedLang}\\s*$`, 'i'), '').trim();
        // Also remove alternate names
        for (const [alias, mapped] of LANGUAGE_MAP) {
            if (mapped === language) {
                cleanTitle = cleanTitle.replace(new RegExp(`\\s+${alias}\\s*$`, 'i'), '').trim();
            }
        }
        if (movie) {
            movie = movie.replace(new RegExp(`\\s+${escapedLang}\\s*$`, 'i'), '').trim();
            for (const [alias, mapped] of LANGUAGE_MAP) {
                if (mapped === language) {
                    movie = movie.replace(new RegExp(`\\s+${alias}\\s*$`, 'i'), '').trim();
                }
            }
        }
    }

    cleanTitle = stripTrailingQueryNoise(cleanTitle);
    if (movie) {
        movie = stripTrailingQueryNoise(movie);
    }

    // 5. Detect if query is a mood search (no title, just "malayalam songs")
    const isMoodSearch = tokens.length <= 2 && tokens.some(t => MOOD_SUFFIXES.has(t));

    // 6. Heuristic: likely-artist query. Keep this conservative so short
    // movie-title searches do not get misclassified as artists.
    const likelyArtist = tokens.length === 1 && !language && !movie && !isMoodSearch;
    const discoveryWords = tokens.filter(token => MOOD_SUFFIXES.has(token) || TRAILING_QUERY_NOISE.has(token));
    const meaningfulTokenCount = tokens.length - discoveryWords.length;
    const isKnownItemSearch = !isMoodSearch && !likelyArtist && (
        Boolean(movie) ||
        meaningfulTokenCount >= 2 ||
        (meaningfulTokenCount === 1 && !discoveryWords.length)
    );
    const intent = isMoodSearch
        ? 'EXPLORATORY_SEARCH'
        : likelyArtist
            ? 'ARTIST_EXACT'
            : isKnownItemSearch
                ? 'TRACK_EXACT'
                : 'TRACK_DISCOVERY';

    return {
        originalQuery: query,
        cleanTitle: cleanTitle || query,
        language,
        movie,
        versionHints,
        isVersionSearch: versionHints.length > 0,
        isKnownItemSearch,
        isMoodSearch,
        intent,
        likelyArtist,
    };
}

function stripTrailingQueryNoise(value) {
    const words = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    while (words.length > 0) {
        const last = words[words.length - 1].toLowerCase();
        if (!TRAILING_QUERY_NOISE.has(last)) break;
        words.pop();
    }

    return words.join(' ').trim();
}

/**
 * Build multiple search query variants from an analysis, ordered by specificity.
 * The caller searches all variants in parallel and merges results.
 */
export function buildSearchVariants(analysis) {
    const { cleanTitle, language, movie, originalQuery } = analysis;
    const variants = [];

    const push = (q) => {
        const normalized = String(q ?? '').replace(/\s+/g, ' ').trim();
        if (normalized && !variants.includes(normalized)) {
            variants.push(normalized);
        }
    };

    // Most specific → least specific
    if (movie && language) push(`${cleanTitle} ${movie} ${language}`);
    if (movie) push(`${cleanTitle} ${movie}`);
    if (language) push(`${cleanTitle} ${language}`);
    push(cleanTitle);

    // Also try original query (might differ from cleanTitle)
    if (originalQuery !== cleanTitle) push(originalQuery);

    const titleWords = cleanTitle.split(/\s+/);

    // Broad fallback: just first 2 words of title (helps with long Indian song titles)
    if (titleWords.length > 3) {
        push(titleWords.slice(0, 2).join(' '));
    }

    // Movie/album name search: when the query is short (≤ 3 tokens) and has no
    // explicit movie detected, also try it as a movie title so JioSaavn's album
    // search returns songs from that film (e.g. "perumazhakkalam songs").
    if (!movie && titleWords.length <= 3) {
        push(`${cleanTitle} songs`);
    }

    // Last-resort single-word fallback: try each word alone (catches cases where
    // JioSaavn has no results for the full phrase but indexes individual words).
    // Only do this when the title is 2-3 words so we don't over-broaden long queries.
    if (language && titleWords.length >= 2 && titleWords.length <= 3) {
        for (const word of titleWords) {
            if (word.length >= 4) {
                push(`${word} ${language}`);
                break; // just try the first meaningful word
            }
        }
    }

    return variants.slice(0, 6);
}

// ─── Song Identity ────────────────────────────────────────────────────────────

/**
 * Compute a stable deduplication key for a song.
 * Two results with the same key are considered the same song.
 */
export function getSongIdentityKey(song) {
    const canonicalId = String(song?.canonicalId ?? song?.canonicalSongId ?? '').trim();
    if (canonicalId) return `canonical:${canonicalId}`;

    const songId = String(song?.songId ?? '').trim();
    if (songId) return `song:${songId}`;

    const title = normText(song?.name ?? song?.title ?? '');
    const rawArtist = song?.primaryArtists
        ?? (Array.isArray(song?.artists?.primary)
            ? song.artists.primary.map(a => a?.name ?? '').join(', ')
            : '')
        ?? '';
    // Only use first artist for dedup key — handles "Artist A, Artist B" vs "Artist A feat Artist B"
    const artist = normText(rawArtist.split(/[,&]/)[0]);
    return `${stripVersionSuffix(title)}::${artist}`;
}

function stripVersionSuffix(title) {
    return title
        .replace(/\s*[\(\[](remix|cover|slowed|reverb|live|acoustic|karaoke|instrumental|lo-?fi|reprise|remastered)[^\)\]]*[\)\]]/gi, '')
        .replace(/\s*-\s*(remix|cover|slowed|reverb|live|acoustic|karaoke|instrumental|lo-?fi|reprise|remastered)\s*$/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Deduplicate a song list preserving first-occurrence order.
 * When duplicates exist, the first one wins (should already be highest-scored).
 */
export function deduplicateSongs(songs) {
    const seen = new Set();
    return (songs ?? []).filter(song => {
        const key = getSongIdentityKey(song);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function fuseSongCandidates(candidateGroups, analysis, options = {}) {
    const groups = Array.isArray(candidateGroups) ? candidateGroups : [];
    const k = Number.isFinite(options?.rrfK) ? options.rrfK : 60;
    const byKey = new Map();

    for (const group of groups) {
        const songs = Array.isArray(group?.songs) ? group.songs : [];
        const source = String(group?.source ?? group?.name ?? 'retrieval');
        const weight = Number.isFinite(group?.weight) ? group.weight : 1;

        songs.forEach((song, index) => {
            if (!song) return;
            const key = getSongIdentityKey(song);
            const rank = index + 1;
            const rrfScore = weight / (k + rank);
            const relevanceScore = scoreSong(song, analysis);
            const current = byKey.get(key);

            if (!current) {
                byKey.set(key, {
                    song,
                    bestRelevanceScore: relevanceScore,
                    rrfScore,
                    bestRank: rank,
                    sources: new Set([source]),
                    sourceRanks: [{ source, rank }],
                });
                return;
            }

            current.rrfScore += rrfScore;
            current.sources.add(source);
            current.sourceRanks.push({ source, rank });
            if (relevanceScore > current.bestRelevanceScore) {
                current.song = song;
                current.bestRelevanceScore = relevanceScore;
            }
            if (rank < current.bestRank) {
                current.bestRank = rank;
            }
        });
    }

    return Array.from(byKey.values())
        .map(entry => {
            const sourceCount = entry.sources.size;
            const fusionScore = entry.bestRelevanceScore + (entry.rrfScore * 950) + Math.min(12, sourceCount * 3);
            return {
                ...entry.song,
                _searchFeatures: {
                    ...(entry.song?._searchFeatures ?? {}),
                    relevanceScore: Number(entry.bestRelevanceScore.toFixed(3)),
                    rrfScore: Number(entry.rrfScore.toFixed(5)),
                    fusionScore: Number(fusionScore.toFixed(3)),
                    sourceCount,
                    bestRank: entry.bestRank,
                    sourceRanks: entry.sourceRanks.slice(0, 8),
                },
            };
        })
        .sort((a, b) => {
            const aFusion = a?._searchFeatures?.fusionScore ?? scoreSong(a, analysis);
            const bFusion = b?._searchFeatures?.fusionScore ?? scoreSong(b, analysis);
            if (bFusion !== aFusion) return bFusion - aFusion;
            return (a?._searchFeatures?.bestRank ?? 999) - (b?._searchFeatures?.bestRank ?? 999);
        });
}

export function filterRelevantSongs(songs, analysis, options = {}) {
    const safeSongs = Array.isArray(songs) ? songs : [];
    if (safeSongs.length === 0 || analysis?.isMoodSearch) return safeSongs;

    const minKeep = Number.isFinite(options?.minKeep) ? options.minKeep : 8;
    const threshold = Number.isFinite(options?.threshold)
        ? options.threshold
        : analysis?.isKnownItemSearch
            ? 44
            : 22;

    const withScores = safeSongs.map(song => ({
        song,
        score: song?._searchFeatures?.relevanceScore ?? scoreSong(song, analysis),
    }));
    const relevant = withScores.filter(entry => entry.score >= threshold);

    if (relevant.length >= minKeep) {
        return relevant.map(entry => entry.song);
    }

    const fallbackCount = Math.min(safeSongs.length, Math.max(minKeep, relevant.length));
    return withScores
        .sort((a, b) => b.score - a.score)
        .slice(0, fallbackCount)
        .map(entry => entry.song);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score a single song against a query analysis.
 * Returns a numeric score (higher = better match).
 *
 * Dynamic weight philosophy:
 *  - Title match always matters
 *  - If movie was extracted → movie weight goes up
 *  - If language was extracted → language weight goes up
 *  - Version markers in song title are penalized unless user asked for them
 */
export function scoreSong(song, analysis) {
    const { cleanTitle, language, movie, isVersionSearch, originalQuery } = analysis;

    const songNameRaw = String(song?.name ?? song?.title ?? '');
    const songName = normText(songNameRaw);
    const titleNorm = normText(cleanTitle);
    const queryNorm = normText(originalQuery);

    // Build artist string
    const rawArtist = song?.primaryArtists
        ?? (Array.isArray(song?.artists?.primary)
            ? song.artists.primary.map(a => a?.name ?? '').join(', ')
            : '')
        ?? '';
    const songArtist = normText(rawArtist);

    const songLang = normText(song?.language ?? '');
    const albumName = normText(
        typeof song?.album === 'string' ? song.album :
        (song?.album?.name ?? '')
    );

    let score = 0;
    const lexical = extractLexicalFeatures({
        query: originalQuery || cleanTitle,
        title: songName,
        artist: songArtist,
        album: albumName,
    });

    // ── Title match (up to 100 pts) ─────────────────────────────────────
    if (songName === titleNorm || songName === queryNorm) {
        score += 100;
    } else if (songName.startsWith(titleNorm + ' ') || songName.startsWith(titleNorm + '-')) {
        // "Blinding Lights (Radio Edit)" — title is exact prefix
        score += 78;
    } else if (songName.startsWith(titleNorm)) {
        score += 70;
    } else if (titleNorm.startsWith(songName) && songName.length >= 4) {
        // Song title is a prefix of the query (query has extra tokens)
        score += 60;
    } else if (songName.includes(titleNorm) || titleNorm.includes(songName)) {
        score += 45;
    } else {
        const sim = bigramSimilarity(songName, titleNorm);
        score += sim * 40;
    }

    // Known-item searches often look like "title artist" or "title movie".
    // Reward candidates whose title plus metadata covers the query even when
    // the title alone is only a prefix of the typed text.
    score += lexical.weightedCoverage * (analysis?.isKnownItemSearch ? 36 : 20);
    if (lexical.titleExactInQuery && lexical.facetHitCount > 0) {
        score += analysis?.isKnownItemSearch ? 42 : 24;
    }
    if (lexical.allTermsDirectlyCovered) {
        score += analysis?.isKnownItemSearch ? 28 : 14;
    }
    if (lexical.titleHitCount > 0 && lexical.facetHitCount > 0) {
        score += 18;
    }

    // ── Version penalty (big) ────────────────────────────────────────────
    const songNameLower = songNameRaw.toLowerCase();
    const songHasVersion = [...VERSION_MARKERS].some(v => songNameLower.includes(v));
    if (songHasVersion && !isVersionSearch) {
        score -= 45; // enough to push remixes/covers behind originals but not remove them
    } else if (songHasVersion && isVersionSearch) {
        score += 10; // bonus if user explicitly wants this version type
    }

    // ── Language match ───────────────────────────────────────────────────
    if (language && songLang) {
        const weight = movie ? 15 : 12; // language matters more when movie also detected
        if (songLang === language) score += weight;
    }

    // ── Movie/Album match ────────────────────────────────────────────────
    // When the user typed an explicit movie ("malare premam"), use that.
    // When they didn't (bare "perumazhakkalam"), still check if the album
    // name matches the cleanTitle — this handles "user searched a movie name"
    // without explicit movie syntax.
    const movieNorm = movie ? normText(movie) : null;
    const implicitMovieNorm = !movie && cleanTitle ? normText(cleanTitle) : null;

    if (movieNorm) {
        if (albumName === movieNorm || albumName.includes(movieNorm) || movieNorm.includes(albumName)) {
            score += 25;
        } else {
            const movieSim = bigramSimilarity(albumName, movieNorm);
            if (movieSim > 0.5) score += movieSim * 20;
        }
    } else if (implicitMovieNorm && albumName && albumName !== songName) {
        // Only apply implicit album boost when the query doesn't already match
        // the song title well (avoids double-counting on actual song title searches).
        const titleMatchScore = songName === implicitMovieNorm ? 100
            : (songName.startsWith(implicitMovieNorm) ? 70 : 0);
        if (titleMatchScore < 50) {
            const albumSim = bigramSimilarity(albumName, implicitMovieNorm);
            if (albumSim >= 0.85) score += 30;        // very strong album match
            else if (albumSim >= 0.65) score += 18;   // good album match
            else if (albumSim >= 0.45) score += 8;    // weak — small nudge
        }
    }

    // ── Duration heuristic ───────────────────────────────────────────────
    const dur = parseInt(song?.duration ?? 0, 10);
    if (dur >= 180) score += 8;   // >= 3 min: strong signal of a real song
    else if (dur >= 120) score += 5;
    if (dur < 90 && dur > 0) score -= 20;  // score/jingle — heavy penalty
    if (dur < 60 && dur > 0) score -= 20;  // stacked: < 1 min = -40 total

    // ── Light popularity signal (so we don't completely ignore JioSaavn's signals) ─
    const playCount = parseInt(song?.playCount ?? 0, 10);
    if (playCount > 10_000_000) score += 4;
    else if (playCount > 1_000_000) score += 2;

    // ── iTunes identity confirmation bonus ────────────────────────────────────
    // Set by enrichSongsWithItunes() — 0 when no iTunes match, up to 25 pts
    score += (song?.itunesBoost ?? 0);

    return score;
}

/**
 * Score + sort a list of songs against the query analysis.
 */
export function rankSongs(songs, analysis) {
    if (!Array.isArray(songs) || songs.length === 0) return [];
    return songs
        .map(song => ({ song, score: scoreSong(song, analysis) }))
        .sort((a, b) => b.score - a.score)
        .map(({ song }) => song);
}

// ─── Artist scoring ───────────────────────────────────────────────────────────

/**
 * Score an artist against the query for top-result selection.
 */
export function scoreArtist(artist, analysis) {
    const artistName = normText(artist?.name ?? '');
    const queryNorm = normText(analysis.originalQuery);
    const titleNorm = normText(analysis.cleanTitle);

    let score = 0;

    if (artistName === queryNorm || artistName === titleNorm) score += 120;
    else if (artistName.startsWith(queryNorm) || artistName.startsWith(titleNorm)) score += 90;
    else if (queryNorm.startsWith(artistName) || titleNorm.startsWith(artistName)) score += 70;
    else if (artistName.includes(titleNorm) || titleNorm.includes(artistName)) score += 50;
    else score += bigramSimilarity(artistName, titleNorm) * 40;

    if (artist?.isVerified) score += 20;
    if (artist?.followerCount > 100000) score += 10;
    if (artist?.followerCount > 1000000) score += 5;

    return score;
}

/**
 * Score an album against the query for top-result selection.
 */
export function scoreAlbum(album, analysis) {
    const albumName = normText(album?.name ?? '');
    const titleNorm = normText(analysis.cleanTitle);
    const queryNorm = normText(analysis.originalQuery);

    let score = 0;

    if (albumName === queryNorm || albumName === titleNorm) score += 100;
    else if (albumName.startsWith(titleNorm)) score += 75;
    else if (titleNorm.startsWith(albumName)) score += 60;
    else if (albumName.includes(titleNorm) || titleNorm.includes(albumName)) score += 40;
    else score += bigramSimilarity(albumName, titleNorm) * 35;

    if (album?.isOfficial) score += 10;

    return score;
}

/**
 * Select the single best "top result" from all candidates.
 * An artist wins if the query clearly targets an artist name.
 * Otherwise songs take priority when they have a very high title match.
 */
export function resolveTopResult({ analysis, songs, artists, albums }) {
    const candidates = [];

    const topSong = songs?.[0];
    const topArtist = artists?.[0];
    const topAlbum = albums?.[0];

    if (topSong) {
        candidates.push({ type: 'song', data: topSong, score: scoreSong(topSong, analysis) + 5 });
    }
    if (topArtist) {
        candidates.push({ type: 'artist', data: topArtist, score: scoreArtist(topArtist, analysis) });
    }
    if (topAlbum) {
        candidates.push({ type: 'album', data: topAlbum, score: scoreAlbum(topAlbum, analysis) - 5 });
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);

    // Only return top result if it has a meaningful score
    if (candidates[0].score < 20) return null;

    return { type: candidates[0].type, data: candidates[0].data };
}

function extractLexicalFeatures({ query, title, artist, album }) {
    const queryTerms = tokenizeForSearch(query).filter(term => !TRAILING_QUERY_NOISE.has(term));
    const effectiveTerms = queryTerms.length > 0 ? queryTerms : tokenizeForSearch(query);
    const titleTokens = tokenizeForSearch(title);
    const artistTokens = tokenizeForSearch(artist);
    const albumTokens = tokenizeForSearch(album);
    const metadataTokens = new Set([...artistTokens, ...albumTokens]);
    const titleTokenSet = new Set(titleTokens);
    const haystackTokens = new Set([...titleTokens, ...artistTokens, ...albumTokens]);
    const compactQuery = compactText(query);
    const compactTitle = compactText(title);

    let titleHitCount = 0;
    let facetHitCount = 0;
    let directHitCount = 0;
    let weightedHits = 0;

    for (const term of effectiveTerms) {
        if (!term) continue;

        if (titleTokenSet.has(term) || title.includes(term)) {
            titleHitCount += 1;
            directHitCount += 1;
            weightedHits += 1.3;
            continue;
        }

        if (metadataTokens.has(term) || artist.includes(term) || album.includes(term)) {
            facetHitCount += 1;
            directHitCount += 1;
            weightedHits += 1.05;
            continue;
        }

        for (const token of haystackTokens) {
            const maxDistance = term.length >= 7 ? 2 : 1;
            if (Math.abs(term.length - token.length) > maxDistance) continue;
            if (term[0] !== token[0]) continue;
            if (levenshteinDistance(term, token) <= maxDistance) {
                weightedHits += 0.45;
                break;
            }
        }
    }

    const maxWeighted = Math.max(1, effectiveTerms.length * 1.3);

    return {
        titleHitCount,
        facetHitCount,
        weightedCoverage: Math.min(1, weightedHits / maxWeighted),
        allTermsDirectlyCovered: effectiveTerms.length > 0 && directHitCount === effectiveTerms.length,
        titleExactInQuery: Boolean(compactTitle && compactQuery && compactQuery.includes(compactTitle)),
    };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function normText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function compactText(value) {
    return normText(value).replace(/[^\p{L}\p{N}]/gu, '');
}

function tokenizeForSearch(value) {
    return normText(value)
        .split(/\s+/)
        .filter(Boolean);
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

export function bigramSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const bigramsOf = (s) => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
    };

    const ba = bigramsOf(a);
    const bb = bigramsOf(b);
    if (ba.size === 0 || bb.size === 0) return 0;

    let intersection = 0;
    for (const bigram of ba) {
        if (bb.has(bigram)) intersection++;
    }

    return (2 * intersection) / (ba.size + bb.size);
}
