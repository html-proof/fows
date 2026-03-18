import express from 'express';
import cors from 'cors';

import saavnRoutes from './routes/saavn.js';
import userRoutes from './routes/user.js';
import activityRoutes from './routes/activity.js';
import recommendationRoutes from './routes/recommendations.js';
import playlistImportRoutes from './routes/playlistImport.js';
import { isShuttingDown } from './runtimeState.js';

const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0) {
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
app.use(express.json());

app.use('/api', saavnRoutes);
app.use('/api/user', userRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/recommendations', recommendationRoutes);
app.use('/api/playlist', playlistImportRoutes);

// Lightweight health routes for keepalive probes.
app.get('/healthz', (_req, res) => {
    const shuttingDown = isShuttingDown();
    res.status(shuttingDown ? 503 : 200).json({
        ok: !shuttingDown,
        state: shuttingDown ? 'shutting_down' : 'ok',
        service: 'music-hub-backend',
        timestamp: new Date().toISOString(),
    });
});

app.get('/health', (_req, res) => {
    res.redirect(302, '/healthz');
});

app.get('/', (_req, res) => {
    res.json({
        message: 'Music Hub API Backend is running',
        version: '2.0.0',
        endpoints: {
            public: [
                'GET /api/search?query=...',
                'GET /api/songs/:id',
                'GET /api/albums?id=...&query=...',
            ],
            authenticated: [
                'POST /api/user/preferences',
                'GET  /api/user/preferences',
                'POST /api/activity/search',
                'POST /api/activity/search-click',
                'POST /api/activity/play',
                'POST /api/activity/skip',
                'GET  /api/activity/history',
                'GET  /api/recommendations',
                'POST /api/recommendations/next',
                'POST /api/playlist/import',
                'POST /api/playlist/parse',
            ],
        },
    });
});

export default app;
