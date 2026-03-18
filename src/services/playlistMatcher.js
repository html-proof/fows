import { searchSongsSmart } from './saavnApi.js';

const MATCH_CONCURRENCY = 10;
const MATCH_TIMEOUT_MS = 6000;
const MIN_FUZZY_SIMILARITY = 0.45;

/**
 * Match a list of { title, artist } items to real songs via search.
 *
 * @param {Array<{ title: string, artist?: string }>} items
 * @param {{ preferredLanguages?: string[] }} [options]
 * @returns {Promise<{ matched: object[], unmatched: Array<{ title: string, artist?: string, reason: string }>, stats: object }>}
 */
export async function matchPlaylistItems(items, options = {}) {
    const preferredLanguages = options?.preferredLanguages ?? [];
    const safeItems = Array.isArray(items) ? items : [];
    const matched = [];
    const unmatched = [];

    // Process in small batches to avoid hammering the API
    for (let i = 0; i < safeItems.length; i += MATCH_CONCURRENCY) {
        const batch = safeItems.slice(i, i + MATCH_CONCURRENCY);
        const results = await Promise.allSettled(
            batch.map(item => matchSingleItem(item, { preferredLanguages }))
        );

        for (let j = 0; j < results.length; j++) {
            const result = results[j];
            const originalItem = batch[j];
            if (result.status === 'fulfilled' && result.value) {
                matched.push({
                    original: originalItem,
                    song: result.value,
                });
            } else {
                unmatched.push({
                    title: originalItem?.title ?? '',
                    artist: originalItem?.artist ?? '',
                    reason: result.status === 'rejected'
                        ? (result.reason?.message ?? 'Search failed')
                        : 'No matching song found',
                });
            }
        }
    }

    return {
        matched,
        unmatched,
        stats: {
            total: safeItems.length,
            matchedCount: matched.length,
            unmatchedCount: unmatched.length,
            matchRate: safeItems.length > 0
                ? Math.round((matched.length / safeItems.length) * 100)
                : 0,
        },
    };
}

/**
 * Search for a single song by title + artist.
 * Returns the best matching song or null.
 */
async function matchSingleItem(item, { preferredLanguages }) {
    const title = normalize(item?.title);
    const artist = normalize(item?.artist);

    if (!title) return null;

    // Build search queries in priority order
    const queries = buildSearchQueries(title, artist);

    for (const query of queries) {
        try {
            const songs = await Promise.race([
                searchSongsSmart(query, {
                    waitForFresh: true,
                    preferredLanguages,
                }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Match timeout')), MATCH_TIMEOUT_MS)
                ),
            ]);

            if (!Array.isArray(songs) || songs.length === 0) {
                continue;
            }

            const best = pickBestMatch(songs, title, artist);
            if (best) {
                return best;
            }
        } catch (error) {
            // Try next query variant
        }
    }

    return null;
}

/**
 * Build progressively broader search queries.
 */
function buildSearchQueries(title, artist) {
    const queries = [];
    const push = (q) => {
        const normalized = q.trim();
        if (normalized && !queries.includes(normalized)) {
            queries.push(normalized);
        }
    };

    // Most specific: "title artist"
    if (artist) {
        push(`${title} ${artist}`);
    }

    // Secondary: "title firstArtist" (if multiple artists)
    if (artist && artist.includes(',')) {
        const firstArtist = artist.split(',')[0].trim();
        if (firstArtist) push(`${title} ${firstArtist}`);
    }

    // Just title
    push(title);

    // Drops " - From ..." or similar noise common in various music platforms
    const noiseRemovals = [
        /\s*-\s*from\s+.*$/i,
        /\s*-\s*original\s+motion\s+picture\s+soundtrack\s*$/i,
        /\s*-\s*remastered\s*$/i,
        /\s*-\s*remix\s*$/i,
        /\s*-\s*single\s+version\s*$/i,
        /\s*[\(\[].*?[\)\]]\s*/g,
    ];

    let queryTitle = title;
    for (const pattern of noiseRemovals) {
        queryTitle = queryTitle.replace(pattern, ' ');
    }
    queryTitle = queryTitle.replace(/\s+/g, ' ').trim();

    if (queryTitle && queryTitle !== title) {
        if (artist) push(`${queryTitle} ${artist}`);
        const firstArtist = artist && artist.includes(',') ? artist.split(',')[0].trim() : artist;
        if (firstArtist && firstArtist !== artist) push(`${queryTitle} ${firstArtist}`);
        push(queryTitle);
    }

    // Fallback: search just first 3 words of title if it's long
    const words = title.split(/\s+/);
    if (words.length > 5) {
        const shortTitle = words.slice(0, 3).join(' ');
        if (artist) push(`${shortTitle} ${artist}`);
    }

    return queries.slice(0, 5); // Allow more variants
}

/**
 * Pick the best match from search results for a given title + artist.
 */
function pickBestMatch(songs, targetTitle, targetArtist) {
    const normalizedTitle = normalizeForSimilarity(targetTitle);
    const normalizedArtist = normalizeForSimilarity(targetArtist);

    let bestSong = null;
    let bestScore = -1;

    for (const song of songs) {
        const songName = normalizeForSimilarity(song?.name ?? song?.title ?? '');
        const songArtist = normalizeForSimilarity(
            song?.primaryArtists ??
            (Array.isArray(song?.artists?.primary)
                ? song.artists.primary.map(a => a?.name ?? '').join(' ')
                : '') ??
            ''
        );

        if (!songName) continue;

        let score = 0;

        // Title similarity (max 60 points)
        const titleSim = similarity(normalizedTitle, songName);
        score += titleSim * 60;

        // Exact title match bonus
        if (songName === normalizedTitle || songName.includes(normalizedTitle) || normalizedTitle.includes(songName)) {
            score += 15;
        }

        // Artist similarity (max 25 points)
        if (normalizedArtist) {
            const artistSim = similarity(normalizedArtist, songArtist);
            score += artistSim * 25;

            // Exact artist match bonus
            if (songArtist.includes(normalizedArtist) || normalizedArtist.includes(songArtist)) {
                score += 10;
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestSong = song;
        }
    }

    // Only return if score passes threshold
    const threshold = normalizedArtist
        ? MIN_FUZZY_SIMILARITY * 100
        : MIN_FUZZY_SIMILARITY * 60;

    return bestScore >= threshold ? bestSong : null;
}

/**
 * Parse raw multi-line text into { title, artist } items.
 * Supports formats:
 * - "Song Name - Artist Name"
 * - "Song Name by Artist Name"
 * - "Artist Name – Song Name"
 * - "Song Name"
 * - Numbered: "1. Song Name - Artist"
 */
export function parsePlaylistText(rawText) {
    const text = String(rawText ?? '').trim();
    if (!text) return [];

    const lines = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !isHeaderLine(line));

    return lines.map(parsePlaylistLine).filter(item => item.title);
}

function parsePlaylistLine(line) {
    // Strip leading numbers, bullets, etc.
    let cleaned = line
        .replace(/^\d+[\.\)\-\s]+/, '')
        .replace(/^[\•\-\*\#]+\s*/, '')
        .trim();

    // Try splitting by common delimiters
    const delimiters = [' - ', ' – ', ' — ', ' by ', ' • ', ' | '];
    for (const delimiter of delimiters) {
        const parts = cleaned.split(delimiter);
        if (parts.length >= 2) {
            const left = parts[0].trim();
            const right = parts.slice(1).join(delimiter).trim();

            if (left && right) {
                // Heuristic: if delimiter is "by", left=title, right=artist
                // Otherwise: could be either order, assume left=title
                return { title: left, artist: right };
            }
        }
    }

    return { title: cleaned, artist: '' };
}

function isHeaderLine(line) {
    const lower = line.toLowerCase();
    return lower.startsWith('#') ||
        lower.startsWith('playlist') ||
        lower.startsWith('songs') ||
        lower.startsWith('track') && lower.includes('artist') ||
        /^[\-=]{3,}$/.test(line);
}

/**
 * Parse Spotify share URL track listing from embed HTML.
 * Spotify share URLs like https://open.spotify.com/playlist/xxxxx
 * Their embed page at https://open.spotify.com/embed/playlist/xxxxx
 * contains track info in the initial HTML / JSON-LD.
 */
export function parseSpotifyEmbedHtml(html) {
    const items = [];

    try {
        // Look for track data in the initial state / resource JSON / JSON-LD / NEXT_DATA
        const jsonMatches = html.match(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>(.*?)<\/script>/gs)
            ?? [];
        const nextDataMatches = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/gs)
            ?? [];
        
        const allJsonBlocks = [...jsonMatches, ...nextDataMatches];

        for (const match of allJsonBlocks) {
            const jsonContent = match.replace(/<\/?script[^>]*>/gs, '');
            try {
                const data = JSON.parse(jsonContent);
                const extracted = extractTracksFromSpotifyJson(data);
                if (extracted.length > 0) {
                    items.push(...extracted);
                }
            } catch (_e) { /* not JSON, skip */ }
        }

        // Fallback: Scraping from the HTML structure (Spotify embed uses h3 for title and h4 for artist)
        const htmlTracks = [];
        const trackRegex = /<h3[^>]*>(.*?)<\/h3>\s*<h4[^>]*>(.*?)<\/h4>/gs;
        let match;
        while ((match = trackRegex.exec(html)) !== null) {
            const title = unescapeHtml(match[1].replace(/<[^>]+>/g, '').trim());
            const artist = unescapeHtml(match[2].replace(/<[^>]+>/g, '').trim());
            if (title && !title.includes('Spotify')) {
                htmlTracks.push({ title, artist });
            }
        }
        
        if (htmlTracks.length > items.length) {
            // Deduplicate and merge
            const seen = new Set(items.map(i => `${i.title.toLowerCase()}|${i.artist.toLowerCase()}`));
            for (const track of htmlTracks) {
                const key = `${track.title.toLowerCase()}|${track.artist.toLowerCase()}`;
                if (!seen.has(key)) {
                    items.push(track);
                    seen.add(key);
                }
            }
        }

        // Final Fallback: look for track info in meta tags
        if (items.length === 0) {
            const titleMatches = html.match(/content="([^"]+?)(?:\s+by\s+|\s*[-–]\s*)([^"]+?)"/g);
            if (titleMatches) {
                for (const match of titleMatches) {
                    const contentMatch = match.match(/content="(.+?)"/);
                    if (contentMatch) {
                        const line = contentMatch[1];
                        if (line.includes('viewport') || line.includes('device-width')) continue;
                        const parsed = parsePlaylistLine(line);
                        // Require both title and artist for meta tag fallback to ensure it's a song
                        if (parsed.title && parsed.artist) {
                            items.push(parsed);
                        }
                    }
                }
            }
        }
    } catch (_e) { /* parsing failed */ }

    return items;
}

function extractTracksFromSpotifyJson(data) {
    const items = [];

    // Case 1: Standard JSON-LD
    if (data?.['@type'] === 'MusicPlaylist' || data?.['@type'] === 'MusicAlbum' || data?.['@type'] === 'MusicRecording') {
        const tracks = data.track ?? data.tracks ?? (data?.['@type'] === 'MusicRecording' ? [data] : []);
        if (Array.isArray(tracks)) {
            for (const t of tracks) {
                const title = t.name ?? t.title;
                const artist = t.byArtist?.name ?? t.artist?.name ?? '';
                if (title) items.push({ 
                    title: unescapeHtml(String(title).trim()), 
                    artist: unescapeHtml(String(artist).trim()) 
                });
            }
        }
        if (items.length > 0) return items;
    }

    // Case 2: Deep walk for track-like objects
    function walk(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
            for (const item of obj) walk(item);
            return;
        }

        // Look for track-like objects: { name, artists: [...] } or { title, artist: "..." }
        const name = obj.name ?? obj.title;
        const artists = obj.artists ?? obj.artist ?? obj.subtitle;

        if (name && typeof name === 'string' && artists) {
            let artistName = '';
            if (typeof artists === 'string') {
                artistName = artists;
            } else if (Array.isArray(artists)) {
                artistName = artists
                    .map(a => (typeof a === 'string' ? a : a?.name ?? ''))
                    .filter(Boolean)
                    .join(', ');
            } else if (typeof artists === 'object' && artists.name) {
                artistName = artists.name;
            }

            if (name.length > 0 && artistName.length > 0 && 
                !name.toLowerCase().includes('viewport') && 
                !name.toLowerCase().includes('device-width') &&
                !artistName.toLowerCase().includes('viewport')) {
                items.push({ 
                    title: unescapeHtml(name.trim()), 
                    artist: unescapeHtml(artistName.trim()) 
                });
            }
        }

        // Specifically look for track lists in Spotify's internal structures
        if (obj.trackList && Array.isArray(obj.trackList)) {
            walk(obj.trackList);
        }
        if (obj.items && Array.isArray(obj.items)) {
            walk(obj.items);
        }
        if (obj.tracks && typeof obj.tracks === 'object') {
            walk(obj.tracks);
        }

        // Avoid infinite recursion by checking strictly for interesting keys
        // or just walking everything if it's small.
        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (val && typeof val === 'object') {
                // Heuristic: only dive into keys that likely contain music data
                if (['data', 'resources', 'track', 'tracks', 'items', 'pageProps', 'state', 'content', 'entity', 'trackList', 'tracklist', 'playlistData', 'body'].includes(key)) {
                    walk(val);
                }
            }
        }
    }

    walk(data);

    // Deduplicate by title+artist
    const seen = new Set();
    return items.filter(item => {
        const key = `${normalize(item.title)}::${normalize(item.artist)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Utility Functions ───────────────────────────────────────

function normalize(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * More aggressive normalization for similarity: removes punctuation.
 */
function normalizeForSimilarity(value) {
    return normalize(value)
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function unescapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&ndash;/g, '-')
        .replace(/&mdash;/g, '-')
        .replace(/&bull;/g, '•');
}

/**
 * Bigram-based string similarity (0..1).
 */
function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const bigramsA = toBigrams(a);
    const bigramsB = toBigrams(b);

    if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

    let intersection = 0;
    for (const bigram of bigramsA) {
        if (bigramsB.has(bigram)) intersection += 1;
    }

    return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

function toBigrams(value) {
    const bigrams = new Set();
    for (let i = 0; i < value.length - 1; i++) {
        bigrams.add(value.slice(i, i + 2));
    }
    return bigrams;
}
