/**
 * Cloudflare Worker — Edge proxy for fows.onrender.com
 *
 * What this does:
 *  - Routes all requests through Cloudflare's 300+ global edge nodes
 *  - Passes through Range headers & 206 Partial Content for streaming audio byte probes & seeking
 *  - Unconditionally bypasses edge caching for stream resolvers (/api/stream/resolve) and stream proxies
 *  - Caches catalog & search responses at the edge with proper TTLs
 *  - Supports full CORS preflight (OPTIONS)
 *  - Keeps the Render backend warm with periodic pings
 *  - Adds Brotli/Gzip compression for non-range JSON/API payloads
 *
 * Deploy steps:
 *  1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 *  2. Paste this entire file into the editor
 *  3. Click Deploy — you get a URL like https://music-hub.YOUR-NAME.workers.dev
 *  4. Update BACKEND_URL below if your Render URL ever changes
 *  5. Update baseUrl in lib/services/api_service.dart to your workers.dev URL
 */

const BACKEND_URL = 'https://fows.onrender.com';

// Routes that must never be cached at the edge (user-specific, stream resolving, or proxy audio)
const PRIVATE_PREFIXES = [
    '/api/user',
    '/api/activity',
    '/api/recommendations',
    '/api/playlist',
    '/api/player/resolve',
    '/api/stream',
    '/stream',
    '/v1/player/resolve',
    '/v1/stream',
    '/api/songs/',        // /api/songs/:id/stream must not be cached as a static GET
    '/v1/catalog/play',   // stream redirects must not be cached as static GET
    '/api/v1/playback',   // new clean playback gateway — never cache audio proxy
];

const EDGE_CACHE_TTLS = {
    '/api/songs':                 86400, // 24 h — song metadata is stable
    '/api/albums':                21600, // 6 h
    '/api/artists':               7200,  // 2 h
    '/api/search':                600,   // 10 min
    '/api/trending':              600,   // 10 min
    '/api/recommendations/moods': 86400, // 24 h — static mood presets
    '/v1/home':                   300,   // 5 min
    '/v1/catalog/search':         600,   // 10 min
    '/v1/catalog/tracks':         86400, // 24 h
};

function getEdgeTtl(pathname) {
    for (const [prefix, ttl] of Object.entries(EDGE_CACHE_TTLS)) {
        if (pathname.startsWith(prefix)) return ttl;
    }
    return 0; // don't cache unknown paths at edge
}

function isPrivate(pathname) {
    if (pathname === '/api/recommendations/moods') return false;
    if (
        pathname.includes('/stream') ||
        pathname.includes('/play/') ||
        pathname.includes('/resolve') ||
        pathname.endsWith('/stream')
    ) {
        return true;
    }
    return PRIVATE_PREFIXES.some(p => pathname.startsWith(p));
}

function isPayloadEmpty(body) {
    if (!body || typeof body !== 'object') return true;
    if (body.success === false) return true;

    const data = body.data;
    if (!data) return true;

    // Direct arrays (e.g. songs or albums)
    if (Array.isArray(data) && data.length === 0) return true;

    // Nested structures (e.g. search responses with { songs: [], albums: [], artists: [] })
    if (Array.isArray(data.results) && data.results.length === 0) return true;
    if (
        Array.isArray(data.songs) && data.songs.length === 0 &&
        (!Array.isArray(data.albums) || data.albums.length === 0) &&
        (!Array.isArray(data.artists) || data.artists.length === 0)
    ) {
        return true;
    }

    return false;
}

export default {
    // ── Main fetch handler ───────────────────────────────────────────────────
    async fetch(request, _env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const hasRangeHeader = request.headers.has('range');

        // 1. Handle CORS Pre-flight (OPTIONS)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, Cache-Control, Accept, X-Forwarded-For, X-Requested-With, Origin, User-Agent',
                    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Cache',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        // 2. Only cache GET requests without Range headers; pass everything else straight through
        if (request.method !== 'GET' || isPrivate(pathname) || hasRangeHeader) {
            return forwardToBackend(request, url);
        }

        const edgeTtl = getEdgeTtl(pathname);
        if (edgeTtl === 0) {
            return forwardToBackend(request, url);
        }

        // Honour Cache-Control: no-cache from the client (used by force-refresh paths)
        const clientCacheControl = request.headers.get('Cache-Control') ?? '';
        const bypassCache = clientCacheControl.includes('no-cache') || clientCacheControl.includes('no-store');

        // Cache key is URL-only — Authorization header must not leak across users
        const cacheKey = new Request(url.toString());
        const cache = caches.default;

        if (!bypassCache) {
            const cached = await cache.match(cacheKey);
            if (cached) {
                const response = new Response(cached.body, cached);
                response.headers.set('X-Cache', 'HIT');
                response.headers.set('Access-Control-Allow-Origin', '*');
                response.headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Cache');
                return response;
            }
        }

        // Cache miss — fetch from backend and store.
        const backendResponse = await forwardToBackend(request, url);
        if (backendResponse.ok && backendResponse.status === 200) {
            const clone = backendResponse.clone();
            ctx.waitUntil((async () => {
                try {
                    const body = await clone.json();
                    // DO NOT cache failure responses or empty result arrays at edge
                    if (isPayloadEmpty(body)) return;

                    const cachedHeaders = new Headers(clone.headers);
                    cachedHeaders.delete('Content-Encoding');
                    cachedHeaders.set('Content-Type', 'application/json; charset=utf-8');
                    cachedHeaders.set(
                        'Cache-Control',
                        `public, max-age=60, s-maxage=${edgeTtl}`,
                    );
                    cachedHeaders.set('Access-Control-Allow-Origin', '*');
                    cachedHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Cache');
                    const toCache = new Response(JSON.stringify(body), {
                        status: clone.status,
                        headers: cachedHeaders,
                    });
                    await cache.put(cacheKey, toCache);
                } catch (_) { /* non-JSON response — skip caching */ }
            })());
        }

        const response = new Response(backendResponse.body, backendResponse);
        response.headers.set('X-Cache', 'MISS');
        response.headers.set('Access-Control-Allow-Origin', '*');
        response.headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Cache');
        return response;
    },

    // ── Cron: keep Render warm every 10 minutes ──────────────────────────────
    async scheduled(_event, _env, _ctx) {
        try {
            await fetch(`${BACKEND_URL}/healthz`, {
                method: 'HEAD',
                signal: AbortSignal.timeout(10000),
            });
        } catch (_) {
            // Ping is best-effort
        }
    },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function forwardToBackend(request, url) {
    const backendUrl = new URL(url.pathname + url.search, BACKEND_URL);

    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', url.hostname);

    // If client requested byte ranges, do NOT force compression encoding
    // (compression breaks Range chunking and Content-Range calculation)
    if (!request.headers.has('range')) {
        headers.set('Accept-Encoding', 'gzip, br');
    }

    const init = {
        method: request.method,
        headers,
        redirect: 'follow',
    };

    // Don't attach a body to GET/HEAD
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
    }

    // 90s for streaming audio routes (progressive MP4/MP3 can take >15s to pipe
    // a full 5-8 MB track at slow CDN speeds). 15s for all other API calls.
    const isStreamingRoute =
        url.pathname.startsWith('/api/stream') ||
        url.pathname.startsWith('/stream') ||
        url.pathname.startsWith('/api/v1/playback');
    init.signal = AbortSignal.timeout(isStreamingRoute ? 90000 : 15000);

    try {
        const response = await fetch(backendUrl.toString(), init);
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
        newHeaders.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, If-Range, Cache-Control, Accept, Origin, User-Agent');
        newHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Cache, X-Stream-Provider');

        // Strip Content-Encoding from audio/streaming responses — Cloudflare must
        // not re-compress bytes that the backend has already served uncompressed.
        // Applying gzip on top of raw audio corrupts Content-Length & Content-Range.
        const contentType = response.headers.get('content-type') || '';
        if (contentType.startsWith('audio/') || contentType.includes('octet-stream')) {
            newHeaders.delete('Content-Encoding');
        }

        return new Response(response.body, {
            status: response.status,
            headers: newHeaders,
        });
    } catch (err) {
        const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
        return new Response(
            JSON.stringify({ error: isTimeout ? 'Gateway timeout' : 'Gateway error', detail: err.message }),
            {
                status: isTimeout ? 504 : 502,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            },
        );
    }
}
