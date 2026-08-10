import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import saavnRoutes from './routes/saavn.js';
import userRoutes from './routes/user.js';
import activityRoutes from './routes/activity.js';
import recommendationRoutes from './routes/recommendations.js';
import playlistImportRoutes from './routes/playlistImport.js';
import catalogRoutes from './routes/catalog.js';
import { isShuttingDown } from './runtimeState.js';

const app = express();

// Trust the first proxy hop (nginx / cloud LB sets X-Forwarded-For)
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const corsOptions = {
    origin: (origin, callback) => {
        // No origin = server-to-server or curl; allow only in non-production
        if (!origin) {
            if (process.env.NODE_ENV === 'production') return callback(null, false);
            return callback(null, true);
        }
        if (allowedOrigins.length === 0) {
            // Deny all browser cross-origin requests when no allowlist is configured
            return callback(null, false);
        }
        return callback(null, allowedOrigins.includes(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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

app.use('/api', saavnRoutes);
app.use('/api/user', userRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/recommendations', recommendationRoutes);
app.use('/api/playlist', strictLimiter, playlistImportRoutes);
app.use('/v1', catalogRoutes);

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
