const express = require('express');
require('dotenv').config();

const searchRoutes = require('./routes/search');
const recommendRoutes = require('./routes/recommend');
const activityRoutes = require('./routes/activity');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'node-api',
    });
});

app.use('/search', searchRoutes);
app.use('/recommend', recommendRoutes);
app.use('/activity', activityRoutes);

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
    console.log(`Node API running on port ${PORT}`);
});
