/**
 * Browser-spoofed header presets for outbound requests to JioSaavn, Gaana, and upstream CDNs.
 * Mimics desktop Google Chrome on Windows 10/11 identically.
 */

export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const CHROME_CLIENT_HINTS = {
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
};

export const JIOSAAVN_HEADERS = {
    'User-Agent': BROWSER_USER_AGENT,
    ...CHROME_CLIENT_HINTS,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8,ml;q=0.7',
    'Referer': 'https://www.jiosaavn.com/',
    'Origin': 'https://www.jiosaavn.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'X-Forwarded-For': '103.212.157.1',
    'Client-IP': '103.212.157.1',
    'Cookie': 'country=IN; geo_country=IN; DL=english,hindi,malayalam,tamil',
};

export const GAANA_HEADERS = {
    'User-Agent': BROWSER_USER_AGENT,
    ...CHROME_CLIENT_HINTS,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8,ml;q=0.7',
    'Referer': 'https://gaana.com/',
    'Origin': 'https://gaana.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'X-Forwarded-For': '103.212.157.1',
    'Client-IP': '103.212.157.1',
    'Cookie': 'country=IN; gaana_country=IN; geo_country=IN',
};

export const AUDIO_STREAM_HEADERS = {
    'User-Agent': BROWSER_USER_AGENT,
    ...CHROME_CLIENT_HINTS,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    // Explicitly forbid compression from CDN — gzip breaks Content-Length and
    // Content-Range calculations that ExoPlayer/AVPlayer require for seeking.
    'Accept-Encoding': 'identity',
    'Sec-Fetch-Dest': 'audio',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
};
