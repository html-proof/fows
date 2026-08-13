/**
 * Cloudflare Worker — Edge proxy for fows.onrender.com
 *
 * What this does:
 *  - Routes all requests through Cloudflare's 300+ global edge nodes
 *  - Caches GET responses at the edge (honoring Cache-Control and avoiding empty result pollution)
 *  - Supports full CORS preflight (OPTIONS)
 *  - Passes through Range headers for streaming audio byte probes
 *  - Keeps the Render backend warm with periodic pings (avoids cold-start delays)
 *  - Adds Brotli/Gzip compression automatically at the edge
 *
 * Deploy steps:
 *  1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 *  2. Paste this entire file into the editor
 *  3. Click Deploy — you get a URL like https://music-hub.YOUR-NAME.workers.dev
 *  4. Update BACKEND_URL below if your Render URL ever changes
 *  5. Update baseUrl in lib/services/api_service.dart to your workers.dev URL
 */

const BACKEND_URL = 'https://fows.onrender.com';

// Routes that must never be cached (user-specific, streaming audio, or write operations)
const PRIVATE_PREFIXES = [
    '/api/user',
    '/api/activity',
    '/api/recommendations',
    '/api/playlist',
    '/api/songs/',        // /api/songs/:id/stream must not be cached as a static GET
    '/v1/catalog/play',   // stream redirects must not be cached as static GET
];

// Cache TTLs (seconds) for edge caching — overrides backend headers when needed
const EDGE_CACHE_TTLS = {
    '/api/songs':          86400, // 24 h — song metadata is stable
    '/api/albums':         21600, // 6 h
    '/api/artists':        7200,  // 2 h
    '/api/search':         600,   // 10 min
    '/api/trending':       600,   // 10 min
    '/v1/home':            300,   // 5 min
    '/v1/catalog/search':  600,   // 10 min
    '/v1/catalog/tracks':  86400, // 24 h
    '/v1/catalog/resolve': 1800,  // 30 min — stream URLs expire
};

function getEdgeTtl(pathname) {
    for (const [prefix, ttl] of Object.entries(EDGE_CACHE_TTLS)) {
        if (pathname.startsWith(prefix)) return ttl;
    }
    return 0; // don't cache unknown paths at edge
}

function isPrivate(pathname) {
    // Specifically allow /api/songs?id=... but bypass /api/songs/:id/stream
    if (pathname.includes('/stream') || pathname.includes('/play/')) return true;
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

        // 1. Handle CORS Pre-flight (OPTIONS)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, Cache-Control, Accept, X-Forwarded-For, X-Requested-With',
                    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, X-Cache',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        // 2. Only cache GET requests; pass everything else straight through
        if (request.method !== 'GET' || isPrivate(pathname)) {
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
                return response;
            }
        }

        // Cache miss — fetch from backend and store.
        const backendResponse = await forwardToBackend(request, url);
        if (backendResponse.ok) {
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
    headers.set('Accept-Encoding', 'gzip, br');

    const init = {
        method: request.method,
        headers,
        redirect: 'follow',
    };

    // Don't attach a body to GET/HEAD
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
    }

    // 25s timeout: returns a proper 504 instead of dropping the TCP connection
    init.signal = AbortSignal.timeout(25000);

    try {
        const response = await fetch(backendUrl.toString(), init);
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
        newHeaders.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, Cache-Control, Accept');
        newHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, X-Cache');

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
