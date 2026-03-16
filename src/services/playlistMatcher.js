import { searchSongsSmart } from './saavnApi.js';

const MATCH_CONCURRENCY = 20;
const MATCH_TIMEOUT_MS = 3000;
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
                    setTimeout(() => reject(new Error('Match timeout')), 1500)
                ),
            ]);

            if (!Array.isArray(songs) || songs.length === 0) continue;

            const best = pickBestMatch(songs, title, artist);
            if (best) return best;
        } catch (_error) {
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

    // Just title
    push(title);

    // Title without parenthetical info (e.g. "feat." or "remix")
    const cleaned = title
        .replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (cleaned && cleaned !== title) {
        if (artist) push(`${cleaned} ${artist}`);
        push(cleaned);
    }

    return queries.slice(0, 3);
}

/**
 * Pick the best match from search results for a given title + artist.
 */
function pickBestMatch(songs, targetTitle, targetArtist) {
    const normalizedTitle = normalize(targetTitle);
    const normalizedArtist = normalize(targetArtist);

    let bestSong = null;
    let bestScore = -1;

    for (const song of songs) {
        const songName = normalize(song?.name ?? song?.title ?? '');
        const songArtist = normalize(
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
        // Look for track data in the initial state / resource JSON
        const jsonMatches = html.match(/<script[^>]*type="application\/json"[^>]*>(.*?)<\/script>/gs);
        if (jsonMatches) {
            for (const match of jsonMatches) {
                const jsonContent = match.replace(/<\/?script[^>]*>/g, '');
                try {
                    const data = JSON.parse(jsonContent);
                    const extracted = extractTracksFromSpotifyJson(data);
                    if (extracted.length > 0) {
                        items.push(...extracted);
                    }
                } catch (_e) { /* not JSON, skip */ }
            }
        }

        // Fallback: look for track info in meta tags
        if (items.length === 0) {
            const titleMatches = html.match(/content="([^"]+?)(?:\s+by\s+|\s*[-–]\s*)([^"]+?)"/g);
            if (titleMatches) {
                for (const match of titleMatches) {
                    const contentMatch = match.match(/content="(.+?)"/);
                    if (contentMatch) {
                        const line = contentMatch[1];
                        const parsed = parsePlaylistLine(line);
                        if (parsed.title) items.push(parsed);
                    }
                }
            }
        }
    } catch (_e) { /* parsing failed */ }

    return items;
}

function extractTracksFromSpotifyJson(data) {
    const items = [];

    function walk(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
            for (const item of obj) walk(item);
            return;
        }

        // Look for track-like objects
        const name = obj.name ?? obj.title;
        const artists = obj.artists ?? obj.artist;
        if (name && artists) {
            let artistName = '';
            if (typeof artists === 'string') {
                artistName = artists;
            } else if (Array.isArray(artists)) {
                artistName = artists
                    .map(a => (typeof a === 'string' ? a : a?.name ?? ''))
                    .filter(Boolean)
                    .join(', ');
            }

            if (name && typeof name === 'string') {
                items.push({ title: name.trim(), artist: artistName.trim() });
            }
        }

        for (const value of Object.values(obj)) {
            walk(value);
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
