/**
 * Cloudflare Worker — Edge proxy for fows.onrender.com
 *
 * What this does:
 *  - Routes all requests through Cloudflare's 300+ global edge nodes
 *  - Caches GET responses at the edge (honoring Cache-Control from the backend)
 *  - Keeps the Render backend warm with periodic pings (avoids cold-start delays)
 *  - Adds Brotli compression automatically (Cloudflare handles this at the edge)
 *
 * Deploy steps:
 *  1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 *  2. Paste this entire file into the editor
 *  3. Click Deploy — you get a URL like https://music-hub.YOUR-NAME.workers.dev
 *  4. Update BACKEND_URL below if your Render URL ever changes
 *  5. Update baseUrl in lib/services/api_service.dart to your workers.dev URL
 *
 * Optional — keep Render warm (prevents 15-20s cold starts):
 *  In the Worker dashboard → Triggers → Cron Triggers → Add: * /10 * * * *
 *  (runs every 10 minutes; Render free tier sleeps after 15 min of inactivity)
 */

const BACKEND_URL = 'https://fows.onrender.com';

// Routes that must never be cached (user-specific or write operations)
const PRIVATE_PREFIXES = [
    '/api/user',
    '/api/activity',
    '/api/recommendations',
    '/api/playlist',
];

// Cache TTLs (seconds) for edge caching — overrides backend headers when needed
const EDGE_CACHE_TTLS = {
    '/api/songs':    86400,  // 24 h  — song metadata is stable
    '/api/albums':   21600,  // 6 h
    '/api/artists':  7200,   // 2 h
    '/api/search':   600,    // 10 min
    '/api/trending': 600,    // 10 min
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
    return PRIVATE_PREFIXES.some(p => pathname.startsWith(p));
}

export default {
    // ── Main fetch handler ───────────────────────────────────────────────────
    async fetch(request, _env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // Only cache GET requests; pass everything else straight through
        if (request.method !== 'GET' || isPrivate(pathname)) {
            return forwardToBackend(request, url);
        }

        const edgeTtl = getEdgeTtl(pathname);
        if (edgeTtl === 0) {
            return forwardToBackend(request, url);
        }

        // Cache key is URL-only — Authorization header must not leak across users.
        const cacheKey = new Request(url.toString());
        const cache = caches.default;
        const cached = await cache.match(cacheKey);
        if (cached) {
            const response = new Response(cached.body, cached);
            response.headers.set('X-Cache', 'HIT');
            return response;
        }

        // Cache miss — fetch from backend and store
        const backendResponse = await forwardToBackend(request, url);
        if (backendResponse.ok) {
            const responseToCache = backendResponse.clone();
            responseToCache.headers.set(
                'Cache-Control',
                `public, max-age=60, s-maxage=${edgeTtl}`,
            );
            ctx.waitUntil(cache.put(cacheKey, responseToCache));
        }

        const response = new Response(backendResponse.body, backendResponse);
        response.headers.set('X-Cache', 'MISS');
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
            // Ignore — ping is best-effort
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
        method:  request.method,
        headers,
        redirect: 'follow',
    };
    // Don't attach a body to GET/HEAD (some runtimes reject it)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
    }

    try {
        const response = await fetch(backendUrl.toString(), init);
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');
        newHeaders.set('Vary', 'Accept-Encoding');
        return new Response(response.body, {
            status:  response.status,
            headers: newHeaders,
        });
    } catch (err) {
        return new Response(
            JSON.stringify({ error: 'Gateway error', detail: err.message }),
            { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
    }
}
