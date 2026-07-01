import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetch } from 'undici';

const rawUrl = process.env.KEEPALIVE_URL ?? '';
const intervalMs = Number(process.env.KEEPALIVE_INTERVAL_MS ?? 240000);
const timeoutMs = Number(process.env.KEEPALIVE_TIMEOUT_MS ?? 10000);

if (!rawUrl) {
    console.error('Missing KEEPALIVE_URL. Example: https://your-service.onrender.com/healthz');
    process.exit(1);
}

const normalizedUrl = rawUrl.endsWith('/healthz')
    ? rawUrl
    : `${rawUrl.replace(/\/$/, '')}/healthz`;

if (!Number.isFinite(intervalMs) || intervalMs < 60000) {
    console.error('KEEPALIVE_INTERVAL_MS must be a number >= 60000');
    process.exit(1);
}

if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    console.error('KEEPALIVE_TIMEOUT_MS must be a number >= 1000');
    process.exit(1);
}

let shouldRun = true;

const stop = (signal) => {
    console.log(`${signal} received. Stopping keepalive worker...`);
    shouldRun = false;
};

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

async function pingOnce() {
    const startedAt = Date.now();

    try {
        const response = await fetch(normalizedUrl, {
            method: 'GET',
            headers: {
                'user-agent': 'music-hub-keepalive-worker/1.0',
            },
            signal: AbortSignal.timeout(timeoutMs),
        });

        const elapsedMs = Date.now() - startedAt;
        console.log(
            `[${new Date().toISOString()}] ping ${normalizedUrl} -> ${response.status} (${elapsedMs}ms)`
        );

        if (response.status >= 400) {
            console.error(`Keepalive returned non-success status: ${response.status}`);
        }
    } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        console.error(
            `[${new Date().toISOString()}] ping failed after ${elapsedMs}ms: ${error.message}`
        );
    }
}

async function run() {
    console.log(`Starting keepalive worker for ${normalizedUrl}`);
    console.log(`Interval: ${intervalMs}ms, timeout: ${timeoutMs}ms`);

    while (shouldRun) {
        await pingOnce();

        if (!shouldRun) {
            break;
        }

        await sleep(intervalMs);
    }

    console.log('Keepalive worker stopped.');
}

await run();