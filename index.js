import 'dotenv/config';
import app from './src/app.js';
import { markShuttingDown } from './src/runtimeState.js';

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10_000);

const KEEPALIVE_URL =
    process.env.KEEPALIVE_URL ||
    (process.env.RENDER_EXTERNAL_URL
        ? `${process.env.RENDER_EXTERNAL_URL}/healthz`
        : '');
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 240_000);

let keepaliveTimer = null;
let initialKeepaliveTimeout = null;
let shutdownInFlight = false;
const sockets = new Set();

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

function clearKeepaliveTimers() {
    if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
    }
    if (initialKeepaliveTimeout) {
        clearTimeout(initialKeepaliveTimeout);
        initialKeepaliveTimeout = null;
    }
}

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Music Hub API server running on 0.0.0.0:${PORT}`);

    if (KEEPALIVE_URL) {
        console.log(
            `[keepalive] Pinging ${KEEPALIVE_URL} every ${KEEPALIVE_INTERVAL_MS / 1000}s`
        );
        keepaliveTimer = setInterval(selfPing, KEEPALIVE_INTERVAL_MS);
        initialKeepaliveTimeout = setTimeout(selfPing, 5_000);
    }
});

server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
});

async function shutdown(signal) {
    if (shutdownInFlight) {
        console.log(`[shutdown] ${signal} received while shutdown is already in progress`);
        return;
    }

    shutdownInFlight = true;
    console.log(`${signal} received, shutting down gracefully...`);
    markShuttingDown();
    clearKeepaliveTimers();

    const forceShutdownTimer = setTimeout(() => {
        console.warn(
            `[shutdown] forcing connection close after ${SHUTDOWN_TIMEOUT_MS}ms`
        );
        if (typeof server.closeIdleConnections === 'function') {
            server.closeIdleConnections();
        }
        if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
        }
        for (const socket of sockets) {
            socket.destroy();
        }
        process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);

    forceShutdownTimer.unref?.();

    server.close(err => {
        clearTimeout(forceShutdownTimer);
        if (err) {
            console.error(`[shutdown] server close failed: ${err.message}`);
            process.exit(1);
            return;
        }
        console.log('[shutdown] HTTP server closed cleanly');
        process.exit(0);
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        void shutdown(signal);
    });
}
