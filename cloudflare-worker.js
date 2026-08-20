/**
 * Cloudflare Worker — Edge proxy for fows.onrender.com
 *
 * Deploy pipeline test: 2026-08-18
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
    '/api/notifications',
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

// How long a resolved playback redirect may be served from the edge. Kept well
// under the origin's 15-minute stream-URL cache and the CDN's token lifetime,
// so an edge hit can never hand out a URL the CDN has already stopped honouring.
const PLAYBACK_REDIRECT_TTL = 240;

// An HLS segment is immutable — one fixed slice of one track — so it is held
// far longer than the redirect. The wrapped CDN URL and its token are part of
// the cache key, so an expired token simply misses rather than serving stale.
const HLS_SEGMENT_TTL = 3600;

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

        // 1b. Playback redirects, cached at the edge.
        //
        // This route was excluded as an "audio proxy", and that was right when
        // the gateway streamed the bytes itself. It no longer does: for a plain
        // GET it resolves the track and answers with a 302 to the CDN. That
        // redirect is a few hundred bytes, and it was costing a full round trip
        // to the origin on every single tap — the origin being far from most
        // listeners, while a Cloudflare PoP is not. It is the largest fixed cost
        // between tapping a song and hearing it.
        //
        // Deliberately narrow:
        //   * GET without Range only. Range requests and HEAD still pass
        //     straight through, so byte serving is untouched.
        //   * Only a 302 is stored. An HLS answer is a 200 with a playlist body
        //     whose chunk URLs have their own lifetimes, and is left alone.
        //   * The TTL is far shorter than both the origin's 15-minute URL cache
        //     and the CDN's own token lifetime, so a cached redirect cannot
        //     outlive the URL it points at.
        //   * `quality` rides in the query string, so tiers never share a key.
        if (
            request.method === 'GET' &&
            !hasRangeHeader &&
            pathname.startsWith('/api/v1/playback/') &&
            !pathname.startsWith('/api/v1/playback/prefetch/') &&
            !pathname.startsWith('/api/v1/playback/diagnostics/')
        ) {
            const redirectKey = new Request(url.toString());
            const redirectCache = caches.default;
            const cachedRedirect = await redirectCache.match(redirectKey);
            if (cachedRedirect) {
                const hit = new Response(cachedRedirect.body, cachedRedirect);
                hit.headers.set('X-Cache', 'HIT');
                hit.headers.set('Access-Control-Allow-Origin', '*');
                return hit;
            }

            const originResponse = await forwardToBackend(request, url);

            // An HLS track answers 200 with a flattened playlist instead of a
            // redirect, and rebuilding it is the slowest thing on the path —
            // measured at 3.3s against 0.3s for a progressive resolve. Caching
            // it for the same short window turns the worst first-play in the
            // catalogue into an edge read. Same TTL as the redirect, so it
            // cannot outlive the segment URLs it names.
            if (
                originResponse.status === 200 &&
                (originResponse.headers.get('Content-Type') ?? '').includes('mpegurl')
            ) {
                const playlist = await originResponse.clone().text();
                const headers = new Headers(originResponse.headers);
                headers.set('Cache-Control', `public, max-age=${PLAYBACK_REDIRECT_TTL}, s-maxage=${PLAYBACK_REDIRECT_TTL}`);
                headers.set('Access-Control-Allow-Origin', '*');
                headers.delete('Content-Encoding');
                headers.delete('Content-Length');
                ctx.waitUntil(redirectCache.put(
                    redirectKey,
                    new Response(playlist, { status: 200, headers }),
                ));
                const out = new Response(playlist, { status: 200, headers });
                out.headers.set('X-Cache', 'MISS');
                return out;
            }

            if (originResponse.status === 302) {
                const location = originResponse.headers.get('Location');
                if (location) {
                    const headers = new Headers(originResponse.headers);
                    headers.set('Cache-Control', `public, max-age=${PLAYBACK_REDIRECT_TTL}, s-maxage=${PLAYBACK_REDIRECT_TTL}`);
                    headers.set('Access-Control-Allow-Origin', '*');
                    // Built fresh rather than cloned: a 302 carries no body, and
                    // Response.redirect() would strip the headers set above.
                    const toCache = new Response(null, { status: 302, headers });
                    ctx.waitUntil(redirectCache.put(redirectKey, toCache.clone()));
                    const out = new Response(null, { status: 302, headers });
                    out.headers.set('X-Cache', 'MISS');
                    return out;
                }
            }
            return originResponse;
        }

        // 1c. HLS segments, cached at the edge.
        //
        // A segment is immutable: the CDN URL it wraps names one fixed slice of
        // one track. Uncached, every six seconds of audio travelled edge →
        // origin → CDN and back, ~0.6s a segment over 42 segments, all of it
        // repeated for every listener and every replay. That is the stall
        // between "playing" and actually hearing anything on an HLS track.
        //
        // Keyed on the full URL, so the wrapped CDN URL and its token are part
        // of the key and no two segments can collide. Range requests pass
        // through untouched.
        if (
            request.method === 'GET' &&
            !hasRangeHeader &&
            pathname.startsWith('/api/stream/chunk')
        ) {
            const chunkKey = new Request(url.toString());
            const chunkCache = caches.default;
            const cachedChunk = await chunkCache.match(chunkKey);
            if (cachedChunk) {
                const hit = new Response(cachedChunk.body, cachedChunk);
                hit.headers.set('X-Cache', 'HIT');
                hit.headers.set('Access-Control-Allow-Origin', '*');
                return hit;
            }

            const chunkResponse = await forwardToBackend(request, url);
            if (chunkResponse.status === 200) {
                const headers = new Headers(chunkResponse.headers);
                headers.set('Cache-Control', `public, max-age=${HLS_SEGMENT_TTL}, s-maxage=${HLS_SEGMENT_TTL}`);
                headers.set('Access-Control-Allow-Origin', '*');
                headers.delete('Content-Encoding');
                const [toCache, toReturn] = chunkResponse.body.tee();
                ctx.waitUntil(chunkCache.put(chunkKey, new Response(toCache, { status: 200, headers })));
                const out = new Response(toReturn, { status: 200, headers });
                out.headers.set('X-Cache', 'MISS');
                return out;
            }
            return chunkResponse;
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

    // ── Cron: keep Render warm (schedule lives in wrangler.toml: */5) ────────
    //
    // This is the ONLY reliable keep-alive. The GitHub Actions schedule that
    // also pings /healthz is throttled heavily in practice — measured gaps of
    // 20-106 minutes against its 5-minute cron — so on its own it leaves the
    // free-tier container asleep most of the time, and the cold start (20-40 s)
    // lands on whichever song the user taps next.
    //
    // NOTE: this handler only runs if the Worker was deployed with the
    // wrangler.toml triggers (`wrangler deploy`). A Worker pasted into the
    // dashboard has no cron attached and this never fires.
    async scheduled(_event, _env, _ctx) {
        try {
            // 30s, not 10s: a cold container needs 20-40s to answer. The old
            // timeout aborted mid-boot, so the ping reported failure on exactly
            // the runs that mattered most.
            await fetch(`${BACKEND_URL}/healthz`, {
                method: 'HEAD',
                signal: AbortSignal.timeout(30000),
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

    const isStreamingRoute =
        url.pathname.startsWith('/api/stream') ||
        url.pathname.startsWith('/stream') ||
        url.pathname.startsWith('/api/v1/playback') ||
        url.pathname.includes('/chunk');

    // Never compress audio streams, HLS playlists, or byte-range requests.
    if (isStreamingRoute || request.headers.has('range')) {
        headers.set('Accept-Encoding', 'identity');
    } else {
        headers.set('Accept-Encoding', 'gzip, br');
    }

    // The playback gateway may answer with a 302 to a public CDN (saavncdn).
    // Pass that redirect straight through to the player (ExoPlayer/AVPlayer
    // follow redirects natively) so audio bytes go player→CDN directly and
    // never relay through the Worker. Every other route follows redirects here.
    const isPlaybackRoute = url.pathname.startsWith('/api/v1/playback');

    const init = {
        method: request.method,
        headers,
        redirect: isPlaybackRoute ? 'manual' : 'follow',
    };

    // Buffer body for POST/PUT/PATCH to prevent Cloudflare Worker streaming deadlock
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.arrayBuffer();
    }

    // 90s for streaming audio routes (progressive MP4/MP3 can take >15s to pipe
    // a full 5-8 MB track at slow CDN speeds). 15s for all other API calls.
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
        const contentType = response.headers.get('content-type') || '';
        if (contentType.startsWith('audio/') || contentType.includes('octet-stream') || contentType.includes('mpegurl')) {
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
