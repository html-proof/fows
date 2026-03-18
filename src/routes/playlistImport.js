import { Router } from 'express';
import {
    matchPlaylistItems,
    parsePlaylistText,
    parseSpotifyEmbedHtml,
    sanitizePlaylistItems,
    unescapeHtml,
} from '../services/playlistMatcher.js';

const router = Router();

const MAX_ITEMS = 1000000;
const SCRAPE_TIMEOUT_MS = 7000;

/**
 * POST /api/playlist/import
 *
 * Import a playlist from text or URL. No API keys needed.
 *
 * Body (JSON):
 *  - type: 'text' | 'url'
 *  - content: string (plain text lines OR a URL)
 *  - playlistName?: string (optional name for the playlist)
 *  - preferredLanguages?: string[] (optional, for better matching)
 *
 * Response:
 *  {
 *    success: boolean,
 *    playlistName: string,
 *    matched: [{ original: { title, artist }, song: { ...saavnSong } }],
 *    unmatched: [{ title, artist, reason }],
 *    stats: { total, matchedCount, unmatchedCount, matchRate }
 *  }
 */
router.post('/import', async (req, res) => {
    try {
        const { type, content, playlistName, preferredLanguages } = req.body ?? {};

        if (!type || !content) {
            return res.status(400).json({
                success: false,
                error: 'Both "type" and "content" are required. type: "text" | "url"',
            });
        }

        let items = [];
        let parseError = '';
        let resolvedPlaylistName = playlistName || 'Imported Playlist';

        if (type === 'text') {
            items = parsePlaylistText(content);
        } else if (type === 'url') {
            const parsed = await parsePlaylistUrl(content);
            items = parsed.items;
            parseError = parsed.error || '';
            if (parsed.name && !playlistName) {
                resolvedPlaylistName = parsed.name;
            }
        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid type. Must be "text" or "url".',
            });
        }

        if (items.length === 0) {
            return res.json({
                success: false,
                error: parseError || 'No songs could be parsed from the input.',
                playlistName: resolvedPlaylistName,
                matched: [],
                unmatched: [],
                stats: { total: 0, matchedCount: 0, unmatchedCount: 0, matchRate: 0 },
            });
        }

        // Cap at MAX_ITEMS to prevent abuse
        const cappedItems = items.slice(0, MAX_ITEMS);

        const results = await matchPlaylistItems(cappedItems, {
            preferredLanguages: Array.isArray(preferredLanguages) ? preferredLanguages : [],
        });

        return res.json({
            success: true,
            playlistName: resolvedPlaylistName,
            ...results,
        });
    } catch (error) {
        console.error('Playlist import error:', error?.message ?? error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error during playlist import.',
        });
    }
});

/**
 * POST /api/playlist/parse
 *
 * Preview: just parse text or URL into { title, artist } items without searching.
 * Useful for showing the user what will be imported before the actual match.
 *
 * Body: same as /import
 * Response: { success, items: [{ title, artist }] }
 */
router.post('/parse', async (req, res) => {
    try {
        const { type, content } = req.body ?? {};

        if (!type || !content) {
            return res.status(400).json({
                success: false,
                error: 'Both "type" and "content" are required.',
            });
        }

        let items = [];
        let name = '';
        let parseError = '';

        if (type === 'text') {
            items = parsePlaylistText(content);
        } else if (type === 'url') {
            const parsed = await parsePlaylistUrl(content);
            items = parsed.items;
            name = parsed.name;
            parseError = parsed.error || '';
        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid type. Must be "text" or "url".',
            });
        }

        if (items.length === 0 && parseError) {
            return res.json({
                success: false,
                name: name || '',
                items: [],
                error: parseError,
            });
        }

        return res.json({
            success: true,
            name: name || '',
            items: items.slice(0, MAX_ITEMS),
        });
    } catch (error) {
        console.error('Playlist parse error:', error?.message ?? error);
        return res.status(500).json({
            success: false,
            error: 'Failed to parse playlist data.',
        });
    }
});

/**
 * Fetch and parse a playlist URL (Spotify, YouTube, or generic).
 */
async function parsePlaylistUrl(url) {
    const normalizedUrl = normalizeIncomingUrl(url);
    if (!normalizedUrl) {
        return {
            items: [],
            name: '',
            error: 'Please enter a valid playlist URL.',
        };
    }

    try {
        const html = await fetchPageHtml(normalizedUrl);
        const lowerUrl = normalizedUrl.toLowerCase();
        const lowerHtml = html.toLowerCase();

        const isSpotify = lowerUrl.includes('spotify.com') ||
            lowerUrl.includes('spotify.link') ||
            lowerHtml.includes('spotify.com') ||
            lowerHtml.includes('spotify-embed');

        const isYouTube = lowerUrl.includes('youtube.com') ||
            lowerUrl.includes('youtu.be') ||
            lowerHtml.includes('youtube.com');

        const isAppleMusic = lowerUrl.includes('music.apple.com') ||
            lowerHtml.includes('apple.com/apple-music');

        const parsed = isSpotify
            ? await parseSpotifyPage(html, normalizedUrl)
            : isYouTube
                ? parseYouTubePage(html)
                : isAppleMusic
                    ? parseAppleMusicPage(html)
                    : parseGenericPage(html);

        return {
            items: sanitizePlaylistItems(parsed?.items),
            name: parsed?.name || '',
            error: parsed?.error || '',
        };
    } catch (error) {
        console.error('URL parse failed:', error?.message);
        return {
            items: [],
            name: '',
            error: 'Failed to fetch playlist data from this URL.',
        };
    }
}

function normalizeIncomingUrl(rawUrl) {
    let value = String(rawUrl ?? '').trim();
    if (!value) return '';

    value = value
        .replace(/^<+|>+$/g, '')
        .replace(/^["']+|["']+$/g, '')
        .trim();

    const spotifyUriMatch = value.match(/^spotify:playlist:([a-zA-Z0-9]+)$/i);
    if (spotifyUriMatch) {
        return `https://open.spotify.com/playlist/${spotifyUriMatch[1]}`;
    }

    if (!/^https?:\/\//i.test(value)) {
        if (/^(open\.)?spotify\.com\//i.test(value) ||
            /^spotify\.link\//i.test(value) ||
            /^music\.apple\.com\//i.test(value) ||
            /^(www\.)?(youtube\.com|youtu\.be)\//i.test(value) ||
            /^[a-z0-9.-]+\.[a-z]{2,}\/\S+/i.test(value)) {
            value = `https://${value.replace(/^\/+/, '')}`;
        }
    }

    try {
        return new URL(value).toString();
    } catch (_error) {
        return value;
    }
}

async function fetchPageHtml(url) {
    let lastError;
    const maxRetries = 1;
    for (let i = 0; i < maxRetries; i++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                },
                redirect: 'follow',
            });

            const html = await response.text();
            if (!html) {
                throw new Error(`Empty response body (HTTP ${response.status})`);
            }

            if (!response.ok) {
                console.warn(`Received HTTP ${response.status} from ${url}`);
            }

            // Handle spotify.link redirection if returned as meta refresh
            if (url.includes('spotify.link') && html.includes('open.spotify.com')) {
                const metaMatch = html.match(/url\s*=\s*(https:\/\/open\.spotify\.com\/[^"'<>\\\s]+)/i);
                if (metaMatch) {
                    const target = metaMatch[1];
                    if (target && target !== url) {
                        return fetchPageHtml(target);
                    }
                }
            }

            return html;
        } catch (error) {
            lastError = error;
            console.warn(`Fetch attempt ${i + 1} failed for ${url}:`, error?.message);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastError ?? new Error('Failed to fetch page');
}

function extractSpotifyPlaylistId(url, html = '') {
    const urlMatch = String(url ?? '').match(/spotify\.com\/(?:embed\/)?playlist\/([a-zA-Z0-9]+)/i);
    if (urlMatch?.[1]) return urlMatch[1];

    const shortUrlMatch = String(url ?? '').match(/spotify\.link\/([a-zA-Z0-9]+)/i);
    if (shortUrlMatch?.[1]) return shortUrlMatch[1];

    const htmlMatch = String(html ?? '').match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/i);
    if (htmlMatch?.[1]) return htmlMatch[1];

    return '';
}

function isSpotifyUnavailablePage(html) {
    const lower = String(html ?? '').toLowerCase();
    return lower.includes('page not found') ||
        lower.includes('404') ||
        lower.includes('this content is unavailable') ||
        lower.includes('this playlist is private');
}

function extractMetaContent(html, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const propertyPattern = new RegExp(`<meta[^>]*property=["']${escapedKey}["'][^>]*content=["']([^"']+)["']`, 'i');
    const namePattern = new RegExp(`<meta[^>]*name=["']${escapedKey}["'][^>]*content=["']([^"']+)["']`, 'i');

    const propertyMatch = html.match(propertyPattern);
    if (propertyMatch?.[1]) return unescapeHtml(propertyMatch[1].trim());

    const nameMatch = html.match(namePattern);
    if (nameMatch?.[1]) return unescapeHtml(nameMatch[1].trim());

    return '';
}

function toSpotifyEmbedUrl(playlistId) {
    return `https://open.spotify.com/embed/playlist/${playlistId}`;
}

async function parseSpotifyPage(html, url) {
    let name = '';
    let error = '';

    // Try to get playlist name from og:title
    name = extractMetaContent(html, 'og:title') || extractMetaContent(html, 'twitter:title');

    // Try JSON-LD or initial state for track data
    let items = parseSpotifyEmbedHtml(html);

    // If direct parse failed, try the embed URL variant
    if (items.length === 0 && !url.includes('/embed/')) {
        const playlistId = extractSpotifyPlaylistId(url, html);
        if (playlistId) {
            try {
                const embedHtml = await fetchPageHtml(toSpotifyEmbedUrl(playlistId));
                if (!name) {
                    name = extractMetaContent(embedHtml, 'og:title')
                        || extractMetaContent(embedHtml, 'twitter:title');
                }
                items = parseSpotifyEmbedHtml(embedHtml);
                if (items.length === 0 && isSpotifyUnavailablePage(embedHtml)) {
                    error = 'This Spotify playlist is unavailable, private, or invalid.';
                }
            } catch (embedError) {
                console.warn('Spotify embed fallback failed:', embedError?.message);
            }
        }
    }

    if (items.length === 0 && isSpotifyUnavailablePage(html)) {
        error = error || 'This Spotify playlist is unavailable, private, or invalid.';
    }

    return { items: sanitizePlaylistItems(items), name, error };
}

function parseYouTubePage(html) {
    const items = [];
    let name = '';

    // Get playlist title
    const titleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)
        ?? html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
        name = titleMatch[1]
            .replace(/ - YouTube$/i, '')
            .replace(/^\s*Playlist\s*-\s*/i, '')
            .trim();
    }

    // YouTube embeds initial data as JSON in a script tag
    const ytInitialData = html.match(/(?:var|window\[['"]ytInitialData['"]\])\s*=\s*(\{.+?\});/s)
        ?? html.match(/ytInitialData\s*=\s*(\{.+?\});/s)
        ?? html.match(/>window\["ytInitialData"\]\s*=\s*(\{.+?\});<\/script>/s);

    if (ytInitialData) {
        try {
            const data = JSON.parse(ytInitialData[1]);
            const tracks = extractYouTubePlaylistTracks(data);
            items.push(...tracks);
        } catch (_e) { /* JSON parse failed */ }
    }

    // Try to handle YouTube Music specifically if it's a song
    if (items.length === 0) {
        const musicMatch = html.match(/"videoDetails"\s*:\s*\{[^}]*"title"\s*:\s*"([^"]+)"[^}]*"author"\s*:\s*"([^"]+)"/);
        if (musicMatch) {
            items.push({ title: musicMatch[1], artist: musicMatch[2] });
        }
    }

    // Fallback: look for video titles in the HTML
    if (items.length === 0) {
        const videoTitles = html.match(/(?:"title"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]+)")/g);
        if (videoTitles) {
            for (const match of videoTitles) {
                const textMatch = match.match(/"text"\s*:\s*"([^"]+)"/);
                if (textMatch) {
                    const parsed = parsePlaylistText(textMatch[1]);
                    items.push(...parsed);
                }
            }
        }
    }

    return { items, name };
}

function extractYouTubePlaylistTracks(data) {
    const items = [];

    function walk(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
            for (const item of obj) walk(item);
            return;
        }

        // Look for playlistVideoRenderer
        if (obj.playlistVideoRenderer) {
            const renderer = obj.playlistVideoRenderer;
            const title = renderer?.title?.runs?.[0]?.text
                ?? renderer?.title?.simpleText ?? '';
            const artist = renderer?.shortBylineText?.runs?.[0]?.text ?? '';

            if (title) {
                // YouTube titles often have "Song - Artist" format
                const parsed = parsePlaylistText(title);
                if (parsed.length > 0) {
                    // Override artist if we found one in the byline
                    if (artist && artist !== 'Various Artists') {
                        parsed[0].artist = parsed[0].artist || artist;
                    }
                    items.push(parsed[0]);
                }
            }
        }

        for (const value of Object.values(obj)) {
            walk(value);
        }
    }

    walk(data);
    return items;
}

function parseAppleMusicPage(html) {
    const items = [];
    let name = '';

    const titleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
    if (titleMatch) {
        name = titleMatch[1].replace(/\s*on Apple Music$/i, '').trim();
    }

    // Apple Music embeds song data in JSON-LD
    const jsonLdMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs);
    if (jsonLdMatches) {
        for (const match of jsonLdMatches) {
            const jsonContent = match.replace(/<\/?script[^>]*>/g, '');
            try {
                const data = JSON.parse(jsonContent);
                const tracks = data?.track ?? data?.tracks ?? (data?.['@type'] === 'MusicRecording' ? [data] : []);
                if (Array.isArray(tracks)) {
                    for (const track of tracks) {
                        const title = track?.name ?? '';
                        const artist = track?.byArtist?.name ?? track?.artist?.name ?? '';
                        if (title) items.push({ title, artist });
                    }
                }
            } catch (_e) { /* skip */ }
        }
    }

    return { items, name };
}

function parseGenericPage(html) {
    const items = [];
    let name = '';

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
        name = titleMatch[1].trim();
    }

    // Try JSON-LD for MusicPlaylist schemas
    const jsonLdMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs);
    if (jsonLdMatches) {
        for (const match of jsonLdMatches) {
            const jsonContent = match.replace(/<\/?script[^>]*>/g, '');
            try {
                const data = JSON.parse(jsonContent);
                if (data?.['@type'] === 'MusicPlaylist' && Array.isArray(data.track)) {
                    for (const track of data.track) {
                        const title = track?.name ?? '';
                        const artist = track?.byArtist?.name ?? '';
                        if (title) items.push({ title, artist });
                    }
                }
            } catch (_e) { /* skip */ }
        }
    }

    return { items, name };
}

export default router;
