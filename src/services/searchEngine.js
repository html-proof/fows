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

// ─── Field-scoped search ──────────────────────────────────────────────────────
//
// A listener looking for one particular recording knows more than its title —
// who sang it, which film it is from, what language it is in — and until now
// there was no way to say so. Everything typed went into one string and the
// providers guessed. These prefixes let the query carry the facets explicitly:
//
//   title:malare artist:"vijay yesudas" movie:premam language:malayalam
//
// Every facet is optional and free to appear in any order. Quotes group a
// multi-word value; without them the value runs to the next facet or the end
// of the query. Anything typed outside a facet stays the title, so an ordinary
// search is parsed exactly as it always was.
const QUERY_FACETS = new Map([
    ['title', 'title'], ['song', 'title'], ['track', 'title'],
    ['artist', 'artist'], ['singer', 'artist'], ['by', 'artist'],
    ['composer', 'artist'], ['music', 'artist'],
    ['movie', 'movie'], ['film', 'movie'], ['album', 'movie'], ['ost', 'movie'],
    ['language', 'language'], ['lang', 'language'],
    ['year', 'year'],
]);

const FACET_KEYS = [...QUERY_FACETS.keys()].join('|');
// Value runs to the next facet or the end of the query, so a multi-word value
// needs no quotes: `movie:dhruva natchathiram lang:tamil` parses as both.
const FACET_PATTERN = new RegExp(
    String.raw`\b(${FACET_KEYS})\s*:\s*("[^"]*"|'[^']*'|\S+(?:\s+(?!(?:${FACET_KEYS})\s*:)\S+)*)`,
    'gi',
);

/**
 * Pull `facet:value` pairs out of a query, returning them alongside whatever
 * text was left over. Returns nulls and the untouched query when the user typed
 * no facets at all, which is the overwhelmingly common case.
 */
export function extractQueryFacets(rawQuery) {
    const query = String(rawQuery ?? '');
    const found = { title: null, artist: null, movie: null, language: null, year: null };
    if (!query.includes(':')) return { facets: found, rest: query.trim(), hasFacets: false };

    let hasFacets = false;
    const rest = query.replace(FACET_PATTERN, (_match, key, value) => {
        const field = QUERY_FACETS.get(String(key).toLowerCase());
        const cleaned = String(value).replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
        if (!field || !cleaned) return ' ';
        hasFacets = true;
        // First occurrence of a facet wins, so a repeated one cannot quietly
        // overwrite what the user typed first.
        if (!found[field]) found[field] = cleaned;
        return ' ';
    }).replace(/\s+/g, ' ').trim();

    return { facets: found, rest, hasFacets };
}

/**
 * The natural-language form of the artist facet: "malare by vijay yesudas".
 *
 * Deliberately cautious. It only splits when what follows "by" is at least two
 * words, because performer credits practically always are and song titles that
 * merely contain the word ("Stand By Me", "Drive By") do not survive that test.
 * The original query is searched as a variant regardless, so even a wrong split
 * cannot cost the user their result.
 */
function splitNaturalArtist(query) {
    const m = String(query ?? '').match(/^(.{2,}?)\s+by\s+(.+)$/i);
    if (!m) return null;
    const title = m[1].trim();
    const artist = m[2].trim();
    if (!title || artist.split(/\s+/).filter(Boolean).length < 2) return null;
    return { title, artist };
}

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
    // Facets the user stated outright are authority, not hints: they are what
    // was typed, so nothing inferred below may overrule them. Everything left
    // over is analysed exactly as an unfacetted query always was, which is why
    // an ordinary search behaves identically to before.
    const { facets, rest, hasFacets } = extractQueryFacets(rawQuery);
    const plain = hasFacets
        ? [facets.title, rest, facets.movie, facets.language].filter(Boolean).join(' ')
        : String(rawQuery ?? '');

    const analysis = _analyzePlainQuery(plain);

    const statedLanguage = facets.language
        ? (LANGUAGE_MAP.get(String(facets.language).toLowerCase()) ?? String(facets.language).toLowerCase())
        : null;

    // "malare by vijay yesudas" — only consulted when no artist was stated, and
    // only when it splits cleanly. See splitNaturalArtist.
    const natural = facets.artist ? null : splitNaturalArtist(analysis.cleanTitle);

    return {
        ...analysis,
        cleanTitle: facets.title || natural?.title || analysis.cleanTitle,
        artist: facets.artist || natural?.artist || null,
        movie: facets.movie || analysis.movie,
        language: statedLanguage || analysis.language,
        year: facets.year || null,
        hasFacets,
        // Scoring and the widest search variant both read this, so it must be
        // plain searchable text — never the `artist:`/`movie:` syntax itself.
        originalQuery: hasFacets
            ? [facets.title || rest, facets.artist, facets.movie, statedLanguage].filter(Boolean).join(' ')
            : analysis.originalQuery,
    };
}

function _analyzePlainQuery(rawQuery) {
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
    const { cleanTitle, language, movie, originalQuery, artist } = analysis;
    const variants = [];

    const push = (q) => {
        const normalized = String(q ?? '').replace(/\s+/g, ' ').trim();
        if (normalized && !variants.includes(normalized)) {
            variants.push(normalized);
        }
    };

    // Most specific → least specific. Each facet the user actually stated
    // narrows the query, so the combinations naming more of them are asked
    // first — a provider given "malare premam malayalam" answers with the one
    // recording meant, where "malare" alone answers with a dozen.
    if (artist && movie && language) push(`${cleanTitle} ${artist} ${movie} ${language}`);
    if (artist && movie) push(`${cleanTitle} ${artist} ${movie}`);
    if (artist && language) push(`${cleanTitle} ${artist} ${language}`);
    if (movie && language) push(`${cleanTitle} ${movie} ${language}`);
    if (artist) push(`${cleanTitle} ${artist}`);
    if (movie) push(`${cleanTitle} ${movie}`);
    if (language) push(`${cleanTitle} ${language}`);
    push(cleanTitle);
    // The performer's own catalogue, for when the title is spelled differently
    // in the provider's index than the listener spelled it.
    if (artist && movie) push(`${artist} ${movie}`);

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
    const title = normText(song?.name ?? song?.title ?? '');
    const canonicalId = String(song?.canonicalId ?? song?.canonicalSongId ?? '').trim();

    // Identity is content-first, ids second.
    //
    // canonicalId was checked first, which defeated the whole point once two
    // catalogues feed one result set: JioSaavn rows carry a canonical id and
    // key as `canonical:trk_…`, Gaana rows carry none and key on content, so
    // the same track could never match itself across providers. Content
    // (title + album + language) is the only identity both sides state, so it
    // now wins whenever it is available; ids remain the fallback for rows too
    // sparse to identify by content.
    //
    // They used to be preferred over title+artist, which silently broke
    // deduplication across providers: a JioSaavn row carries songId and keys as
    // `song:<id>`, while the same track from Gaana carries no id at all and
    // keys as `title::artist`. Different keys, so the same song appeared twice
    // in one result list once both catalogues were searched together. Falling
    // back to the id only when there is no title keeps rows without metadata
    // addressable while letting real tracks match on what both providers
    // actually agree on.
    if (!title) {
        if (canonicalId) return `canonical:${canonicalId}`;
        const songId = String(song?.songId ?? '').trim();
        if (songId) return `song:${songId}`;
    }

    // Prefer title + album + language over title + artist for cross-provider
    // identity. The providers do not agree on what "primary artist" means —
    // Gaana returns the composer where JioSaavn returns the singers — so an
    // artist-based key leaves the same track double-listed once both
    // catalogues feed one result set. Album and language are stated
    // consistently, and a title is unique within an album, which makes this
    // both stricter and more portable. Language is part of the key so two
    // same-named regional soundtracks (a Tamil and a Malayalam "Pattalam")
    // never collapse into each other.
    const albumName = typeof song?.album === 'string'
        ? song.album
        : String(song?.album?.name ?? '');
    const normalizedAlbum = stripAlbumEditionSuffix(normText(albumName));
    if (normalizedAlbum) {
        // Language is deliberately NOT part of the key. Providers disagree on
        // it constantly — the same "Tum Hi Ho" from Aashiqui 2 comes back
        // tagged hindi, malayalam and punjabi — so including it split one track
        // into three. Title plus album is already a precise identity: a title
        // is unique within a release.
        return `${stripVersionSuffix(title)}@@${normalizedAlbum}`;
    }

    if (canonicalId) return `canonical:${canonicalId}`;

    const rawArtist = song?.primaryArtists
        ?? (Array.isArray(song?.artists?.primary)
            ? song.artists.primary.map(a => a?.name ?? '').join(', ')
            : '')
        ?? '';
    // Only use first artist for dedup key — handles "Artist A, Artist B" vs "Artist A feat Artist B"
    const artist = normText(rawArtist.split(/[,&]/)[0]);
    return `${stripVersionSuffix(title)}::${artist}`;
}

/**
 * Drops edition/packaging wording that one provider appends to an album title
 * and the other does not, e.g. JioSaavn's "Pattalam" vs Gaana's
 * "Pattalam (Original Motion Picture Soundtrack)".
 *
 * Operates on normText output, which has already flattened punctuation to
 * spaces — so these patterns must match bare words, not bracketed groups.
 */
export function stripAlbumEditionSuffix(album) {
    return String(album ?? '')
        .replace(/\b(original\s+)?(motion\s+picture\s+)?sound\s*track\b/gi, ' ')
        .replace(/\boriginal\s+motion\s+picture\b/gi, ' ')
        .replace(/\bfrom\s+the\s+(motion\s+picture|film|movie)\b/gi, ' ')
        .replace(/\b(deluxe|remastered|special|extended)\s+(edition|version)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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
                // Prefer the candidate with real download URLs so search
                // results never lose a valid stream URL to an album-injected
                // song that has empty/placeholder downloadUrl.
                const currentHasUrls = Array.isArray(current.song?.downloadUrl) && current.song.downloadUrl.length > 0;
                const candidateHasUrls = Array.isArray(song?.downloadUrl) && song.downloadUrl.length > 0;
                if (!currentHasUrls || candidateHasUrls) {
                    current.song = song;
                    current.bestRelevanceScore = relevanceScore;
                }
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

    // Retrieval lanes whose songs are relevant by PROVENANCE rather than by
    // their title, and so must survive a filter that scores against the query
    // text. A soundtrack is the case that needs this: once "bangalore days" is
    // known to name a film, every track on that film's album belongs in the
    // answer, but "Aethu Kari Raavilum" and "Maangalyam" share no word with the
    // query and scored below the threshold, while compilation rows like "Diwali
    // - 5 Divine Days" scored above it on the word "days" alone. The film lost
    // three of its five songs to rows that merely rhymed with its name.
    const alwaysKeep = new Set(
        Array.isArray(options?.alwaysKeepSources) ? options.alwaysKeepSources : [],
    );
    const isExempt = (song) => {
        if (alwaysKeep.size === 0) return false;
        const ranks = song?._searchFeatures?.sourceRanks;
        if (!Array.isArray(ranks)) return false;
        return ranks.some(entry => alwaysKeep.has(entry?.source));
    };

    const withScores = safeSongs.map(song => ({
        song,
        score: song?._searchFeatures?.relevanceScore ?? scoreSong(song, analysis),
        exempt: isExempt(song),
    }));
    const relevant = withScores.filter(entry => entry.exempt || entry.score >= threshold);

    if (relevant.length >= minKeep) {
        return relevant.map(entry => entry.song);
    }

    const fallbackCount = Math.min(safeSongs.length, Math.max(minKeep, relevant.length));
    return withScores
        // Exempt rows sort ahead of the rest so the slice cannot drop them
        // either — otherwise the guarantee above would hold only on the path
        // where enough rows cleared the threshold.
        .sort((a, b) => (b.exempt - a.exempt) || (b.score - a.score))
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

    // ── Artist match ─────────────────────────────────────────────────────
    // Only when the listener actually named a performer. An unstated artist
    // leaves scoring exactly as it was, so ordinary searches do not shift.
    const statedArtist = analysis?.artist ? normText(analysis.artist) : null;
    if (statedArtist && songArtist) {
        if (songArtist === statedArtist || songArtist.includes(statedArtist) || statedArtist.includes(songArtist)) {
            score += 30;
        } else {
            const artistSim = bigramSimilarity(songArtist, statedArtist);
            if (artistSim > 0.5) score += artistSim * 22;
            // A stated performer the candidate plainly is not is evidence
            // against it — enough to sort it below the real match, never enough
            // to drop it, since credits are spelled many ways.
            else score -= 20;
        }
    }

    // ── Year match ───────────────────────────────────────────────────────
    const statedYear = analysis?.year ? String(analysis.year).trim() : null;
    if (statedYear && song?.year && String(song.year).trim() === statedYear) {
        score += 12;
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
