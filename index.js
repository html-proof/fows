import 'dotenv/config';
import app from './src/app.js';

const PORT = process.env.PORT || 3000;

// ── Self-ping keepalive to prevent Render free tier from sleeping ──
// Render sets RENDER_EXTERNAL_URL automatically for web services.
const KEEPALIVE_URL =
    process.env.KEEPALIVE_URL ||
    (process.env.RENDER_EXTERNAL_URL
        ? `${process.env.RENDER_EXTERNAL_URL}/healthz`
        : '');
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 240_000); // 4 min

let keepaliveTimer = null;

async function selfPing() {
    if (!KEEPALIVE_URL) return;
    try {
        const res = await fetch(KEEPALIVE_URL, {
            signal: AbortSignal.timeout(10_000),
        });
        console.log(
            `[keepalive] ${new Date().toISOString()} -> ${res.status}`
        );
    } catch (err) {
        console.warn(`[keepalive] ping failed: ${err.message}`);
    }
}

app.listen(PORT, () => {
    console.log(`🎵 Music Hub API server running on http://localhost:${PORT}`);

    // Start self-ping only in production (when a public URL is available).
    if (KEEPALIVE_URL) {
        console.log(
            `[keepalive] Pinging ${KEEPALIVE_URL} every ${KEEPALIVE_INTERVAL_MS / 1000}s`
        );
        keepaliveTimer = setInterval(selfPing, KEEPALIVE_INTERVAL_MS);
        // First ping after a short delay to let the server fully boot.
        setTimeout(selfPing, 5_000);
    }
});

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        console.log(`${signal} received, shutting down...`);
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        process.exit(0);
    });
}
