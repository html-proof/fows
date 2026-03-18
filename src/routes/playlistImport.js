import { Router } from 'express';
import {
    matchPlaylistItems,
    parsePlaylistText,
    parseSpotifyEmbedHtml,
    unescapeHtml,
} from '../services/playlistMatcher.js';

const router = Router();

const MAX_ITEMS = 1000000;
const SCRAPE_TIMEOUT_MS = 15000;

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
        let resolvedPlaylistName = playlistName || 'Imported Playlist';

        if (type === 'text') {
            items = parsePlaylistText(content);
        } else if (type === 'url') {
            const parsed = await parsePlaylistUrl(content);
            items = parsed.items;
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
                error: 'No songs could be parsed from the input.',
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

        if (type === 'text') {
            items = parsePlaylistText(content);
        } else if (type === 'url') {
            const parsed = await parsePlaylistUrl(content);
            items = parsed.items;
            name = parsed.name;
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
    let normalizedUrl = String(url ?? '').trim();
    if (!normalizedUrl) {
        return { items: [], name: '' };
    }

    try {
        // Spotify: handle shortened links (spotify.link) and ensuring embed format
        // Use embed format where possible as it's cleaner for scraping
        if (normalizedUrl.includes('spotify.link/') || 
           (normalizedUrl.includes('spotify.com/') && normalizedUrl.includes('/playlist/'))) {
            // Keep the original URL if it's a playlist to avoid embed caps
            // For spotify.link, we'll follow the redirect first
        }

        const html = await fetchPageHtml(normalizedUrl);

        // Detect source and parse accordingly
        // Check URL or HTML content for clues
        const isSpotify = normalizedUrl.includes('spotify.com') || 
                         normalizedUrl.includes('spotify.link') || 
                         html.includes('spotify-embed') ||
                         html.includes('spotify.com');

        if (isSpotify) {
            return parseSpotifyPage(html, normalizedUrl);
        }

        if (normalizedUrl.includes('youtube.com') || normalizedUrl.includes('youtu.be') || html.includes('youtube.com')) {
            return parseYouTubePage(html);
        }

        if (normalizedUrl.includes('music.apple.com') || html.includes('apple.com/apple-music')) {
            return parseAppleMusicPage(html);
        }

        // Generic: try to extract anything useful
        return parseGenericPage(html);
    } catch (error) {
        console.error('URL parse failed:', error?.message);
        return { items: [], name: '' };
    }
}

async function fetchPageHtml(url) {
    let lastError;
    const maxRetries = 3;

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

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();

            // Handle spotify.link redirection if returned as meta refresh
            if (url.includes('spotify.link') && html.length < 500 && html.includes('url=https://open.spotify.com')) {
                const metaMatch = html.match(/url=(https:\/\/open\.spotify\.com\/[^"]+)/i);
                if (metaMatch) {
                    const target = metaMatch[1]; //.replace('open.spotify.com/', 'open.spotify.com/embed/');
                    return fetchPageHtml(target);
                }
            }

            return html;
        } catch (error) {
            lastError = error;
            console.warn(`Fetch attempt ${i + 1} failed for ${url}:`, error?.message);
            // Wait 1s before next attempt (if not last)
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastError;
}

function parseSpotifyPage(html, url) {
    let name = '';

    // Try to get playlist name from og:title
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
    if (ogTitle) {
        name = unescapeHtml(ogTitle[1].trim());
    }

    // Try JSON-LD or initial state for track data
    const items = parseSpotifyEmbedHtml(html);

    // If direct parse failed, try the embed URL variant
    if (items.length === 0 && !url.includes('/embed/')) {
        // We can't fetch embed in the same call, but return what we have
        // The client can retry with the embed URL
    }

    return { items, name };
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
