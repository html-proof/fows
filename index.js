import 'dotenv/config';
import dns from 'node:dns';
import { setGlobalDispatcher, Agent } from 'undici';
import app from './src/app.js';
import { markShuttingDown } from './src/runtimeState.js';

// Force Node.js & Undici to resolve and connect via IPv4.
// Render containers do not have outbound IPv6 routing; without this, Happy Eyeballs
// tries IPv6 addresses (2600:1413:...) first and throws ENETUNREACH / ETIMEDOUT.
try {
    dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

try {
    setGlobalDispatcher(new Agent({
        connect: {
            family: 4,
            timeout: 10_000,
        },
        pipelining: 0,
    }));
} catch (_) {}

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
        // ping OK
    } catch (err) {
        // Keepalive failures are transient — only log if they persist
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
    if (KEEPALIVE_URL) {
        keepaliveTimer = setInterval(selfPing, KEEPALIVE_INTERVAL_MS);
        initialKeepaliveTimeout = setTimeout(selfPing, 5_000);
    }
});

server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
});

async function shutdown(signal) {
    if (shutdownInFlight) return;

    shutdownInFlight = true;
    markShuttingDown();
    clearKeepaliveTimers();

    const forceShutdownTimer = setTimeout(() => {
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
        process.exit(0);
    });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        void shutdown(signal);
    });
}
