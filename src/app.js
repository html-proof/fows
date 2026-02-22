import express from 'express';
import cors from 'cors';

// Route imports
import saavnRoutes from './routes/saavn.js';
import userRoutes from './routes/user.js';
import activityRoutes from './routes/activity.js';
import recommendationRoutes from './routes/recommendations.js';

const app = express();

// ─── Global Middleware ──────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Public Routes (no auth required) ──────────────────────
app.use('/api', saavnRoutes);

// ─── Protected Routes (auth required — middleware is per-route) ─
app.use('/api/user', userRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/recommendations', recommendationRoutes);

// ─── Health Check ───────────────────────────────────────────
app.get('/', (req, res) => {
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
                'POST /api/activity/play',
                'POST /api/activity/skip',
                'GET  /api/activity/history',
                'GET  /api/recommendations',
            ],
        },
    });
});

export default app;
