import express from 'express';
import dns from 'node:dns';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';

try {
    dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

import saavnRoutes from './routes/saavn.js';
import userRoutes from './routes/user.js';
import activityRoutes from './routes/activity.js';
import recommendationRoutes from './routes/recommendations.js';
import playlistImportRoutes from './routes/playlistImport.js';
import catalogRoutes from './routes/catalog.js';
import playerRoutes from './routes/player.js';
import streamRoutes from './routes/stream.js';
import playbackRoutes from './routes/playback.js';
import { isShuttingDown } from './runtimeState.js';

const app = express();

// Trust Cloudflare + Render proxy hops (sets X-Forwarded-For correctly)
app.set('trust proxy', 2);

// Gzip / Brotli compression — reduces payload size 60-80% for JSON responses.
// Cloudflare also compresses at the edge, but this covers direct Render traffic.
// CRITICAL: Do NOT compress audio streaming routes — gzip breaks Content-Length
// and Content-Range headers that ExoPlayer/AVPlayer need for byte-accurate seeking.
const STREAMING_ROUTE_PREFIXES = ['/api/stream', '/stream', '/api/v1/playback'];
app.use((req, res, next) => {
    const path = req.path;
    const isStreamingRoute = STREAMING_ROUTE_PREFIXES.some(prefix => path.startsWith(prefix));
    if (isStreamingRoute) return next();
    compression({ level: 6, threshold: 512 })(req, res, next);
});

// Security headers
app.use(helmet());

const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const corsOptions = {
    origin: (origin, callback) => {
        // No Origin header = mobile app (Flutter), server-to-server, or curl.
        // Mobile clients like Flutter never send an Origin header — blocking them
        // in production would reject ALL Flutter playback requests.
        if (!origin) return callback(null, true);

        if (allowedOrigins.length === 0) {
            // No allowlist configured — public API, allow all browser origins.
            return callback(null, true);
        }
        return callback(null, allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'If-Range'],
    exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'X-Stream-Provider'],
    credentials: true,
    maxAge: 86400,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Limit request body size
app.use(express.json({ limit: '50kb' }));

// Global rate limit: 120 requests/minute per IP
const globalLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});

// Tighter limit for write-heavy / scraping endpoints
const strictLimiter = rateLimit({
    windowMs: 60_000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});

app.use(globalLimiter);

// ── Cache-Control helpers ──────────────────────────────────────────────────────
// s-maxage is respected by Cloudflare CDN; max-age is the client-side TTL.
// Authenticated / write routes use `private, no-store` so they bypass the CDN.

function cachePublic(maxAgeS, cdnAgeS) {
    return (_req, res, next) => {
        res.set('Cache-Control', `public, max-age=${maxAgeS}, s-maxage=${cdnAgeS}`);
        next();
    };
}

const cachePrivate = (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
};

// Per-route cache policies
//   Search / trending  — fresh for 5 min client, 10 min CDN
//   Albums / artists   — fresh for 1 h client, 6 h CDN
//   Songs              — fresh for 1 h client, 24 h CDN (stream URLs change, song metadata doesn't)
//   Authenticated      — never cached at CDN

app.use('/api/user', cachePrivate, userRoutes);
app.use('/api/activity', cachePrivate, activityRoutes);
app.use('/api/recommendations', cachePrivate, recommendationRoutes);
app.use('/api/playlist', strictLimiter, cachePrivate, playlistImportRoutes);
// Playback gateway — never cache, never compress (registered before catalogRoutes)
app.use('/api/v1/playback', cachePrivate, playbackRoutes);
app.use('/v1/catalog/resolve', cachePublic(600, 1800));      // stream URLs: 10 min / 30 min
app.use('/v1/catalog/tracks', cachePublic(3600, 86400));     // track meta: 1 h / 24 h
app.use('/v1', cachePublic(300, 600), catalogRoutes);
app.use('/v1', playerRoutes);
app.use('/api/playback', cachePrivate, catalogRoutes);
app.use('/api/gaana', cachePublic(600, 1800), catalogRoutes);
app.use('/api/trending', cachePublic(300, 600));             // 5 min / 10 min
app.use('/api/songs', cachePublic(3600, 86400));             // 1 h / 24 h
app.use('/api/albums', cachePublic(3600, 21600));            // 1 h / 6 h
app.use('/api/artists', cachePublic(1800, 7200));            // 30 min / 2 h
app.use('/api/search', cachePublic(300, 600));               // 5 min / 10 min
app.use('/stream', streamRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api', playerRoutes);
app.use('/api', saavnRoutes);

// Lightweight health routes for keepalive probes.
app.get('/healthz', (_req, res) => {
    const shuttingDown = isShuttingDown();
    res.status(shuttingDown ? 503 : 200).json({
        ok: !shuttingDown,
        state: shuttingDown ? 'shutting_down' : 'ok',
        service: 'music-hub-backend',
        timestamp: new Date().toISOString(),
        providers: {},
    });
});
app.head('/healthz', (_req, res) => {
    const shuttingDown = isShuttingDown();
    res.sendStatus(shuttingDown ? 503 : 200);
});

app.get('/health', (_req, res) => {
    res.redirect(302, '/healthz');
});
app.head('/health', (_req, res) => {
    res.redirect(302, '/healthz');
});

app.get('/', (_req, res) => {
    res.json({
        message: 'Music Hub API — JioSaavn-powered backend',
        version: '2.1.0',
        endpoints: {
            search: [
                'GET  /api/search?query=&limit=&page=       — songs + albums + artists + top result',
                'GET  /api/search/trending                  — trending search queries',
            ],
            songs: [
                'GET  /api/songs/:id                        — song detail + 5-quality download URLs',
                'GET  /api/songs/:id/stream?quality=320kbps — best stream URL (client plays directly)',
                'GET  /api/songs/:id/lyrics                 — lyrics (JioSaavn Pro required)',
                'GET  /api/songs/:id/recommendations?limit= — similar songs via reco engine',
            ],
            albums: [
                'GET  /api/albums?id=                       — album by JioSaavn ID',
                'GET  /api/albums/by-link?link=             — album by JioSaavn perma_url',
            ],
            artists: [
                'GET  /api/artists/:id                      — artist profile + follower count',
                'GET  /api/artists/:id/songs                — artist top songs',
                'GET  /api/artists/:id/albums?page=&limit=  — artist albums',
                'GET  /api/artists/by-language?language=    — artists by language',
            ],
            trending: [
                'GET  /api/trending?language=&type=song|album&limit= — live trending',
            ],
            authenticated: [
                'POST /api/user/preferences',
                'GET  /api/user/preferences',
                'POST /api/activity/play',
                'POST /api/activity/skip',
                'GET  /api/activity/history',
                'GET  /api/recommendations',
                'POST /api/recommendations/next',
                'POST /api/playlist/import',
                'POST /api/playlist/parse',
            ],
            catalog: [
                'GET  /v1/catalog/search?q=                 — canonical search',
                'GET  /v1/catalog/tracks/:id                — canonical track detail',
                'GET  /v1/catalog/resolve/:id               — resolve canonical → stream URL',
                'GET  /v1/home                              — personalised home feed (auth)',
            ],
            health: [
                'GET  /healthz',
            ],
        },
    });
});
app.head('/', (_req, res) => {
    res.sendStatus(200);
});

export default app;
