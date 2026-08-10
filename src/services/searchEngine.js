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
        return { originalQuery: '', cleanTitle: '', language: null, movie: null, versionHints: [], isVersionSearch: false, likelyArtist: false };
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
    }

    // 5. Detect if query is a mood search (no title, just "malayalam songs")
    const isMoodSearch = tokens.length <= 2 && tokens.some(t => MOOD_SUFFIXES.has(t));

    // 6. Heuristic: likely-artist query (single name or known artist abbreviation)
    // We rely on the caller's ARTIST_CORRECTIONS map for this; just flag short queries
    const likelyArtist = tokens.length <= 3 && !language && !movie && !isMoodSearch;

    return {
        originalQuery: query,
        cleanTitle: cleanTitle || query,
        language,
        movie,
        versionHints,
        isVersionSearch: versionHints.length > 0,
        isMoodSearch,
        likelyArtist,
    };
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

    // Broad fallback: just first 2 words of title (helps with long Indian song titles)
    const titleWords = cleanTitle.split(/\s+/);
    if (titleWords.length > 3) {
        push(titleWords.slice(0, 2).join(' '));
    }

    // Movie/album name search: when the query is short (≤ 3 tokens) and has no
    // explicit movie detected, also try it as a movie title so JioSaavn's album
    // search returns songs from that film (e.g. "perumazhakkalam songs").
    if (!movie && titleWords.length <= 3) {
        push(`${cleanTitle} songs`);
    }

    return variants.slice(0, 5);
}

// ─── Song Identity ────────────────────────────────────────────────────────────

/**
 * Compute a stable deduplication key for a song.
 * Two results with the same key are considered the same song.
 */
export function getSongIdentityKey(song) {
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
    if (dur >= 120) score += 5;   // >= 2 min: real song
    if (dur < 60 && dur > 0) score -= 8; // < 1 min: clip/intro

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

// ─── Utilities ────────────────────────────────────────────────────────────────

export function normText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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
