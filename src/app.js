import express from 'express';
import cors from 'cors';

import saavnRoutes from './routes/saavn.js';
import userRoutes from './routes/user.js';
import activityRoutes from './routes/activity.js';
import recommendationRoutes from './routes/recommendations.js';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', saavnRoutes);
app.use('/api/user', userRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/recommendations', recommendationRoutes);

// Lightweight health routes for keepalive probes.
app.get('/healthz', (_req, res) => {
    res.status(200).json({
        ok: true,
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
            ],
        },
    });
});

export default app;