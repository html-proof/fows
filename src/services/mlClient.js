import { Agent, request } from 'undici';

/**
 * Client for the Python ML service (`music-app-backend/ml-service`).
 *
 * The service holds the trained collaborative-filtering model; this gateway
 * keeps the ranking policy. We ask it for one thing only -- a learned score per
 * song -- and fold that into the local ranker as an extra feature.
 *
 * Everything here is written so that the ML service being slow, asleep, or
 * absent is a non-event: the gateway degrades to its own heuristics instead of
 * making the user wait. On Render's free tier the ML instance *will* cold-start
 * (30s+), so a circuit breaker keeps us from paying that timeout on every
 * request while it wakes up.
 */

const DEFAULT_TIMEOUT_MS = 800;
const DEFAULT_RECOMMENDATION_TIMEOUT_MS = 2000;

// Trip after this many consecutive failures, then stay open for the cooldown
// before letting a single probe through.
const FAILURE_THRESHOLD = 3;
const OPEN_CIRCUIT_COOLDOWN_MS = 30_000;

const SCORE_CACHE_TTL_MS = 60_000;
const SCORE_CACHE_MAX_ENTRIES = 200;
const MAX_SONGS_PER_REQUEST = 200;

const baseUrl = (process.env.ML_SERVICE_URL || '').trim().replace(/\/+$/, '');
const apiKey = (process.env.ML_SERVICE_API_KEY || '').trim();
const timeoutMs = Number(process.env.ML_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
const recommendationTimeoutMs = Number(
    process.env.ML_RECOMMENDATION_TIMEOUT_MS || DEFAULT_RECOMMENDATION_TIMEOUT_MS
);

// ML_ENABLED lets you kill the integration without redeploying the gateway.
const explicitlyDisabled = String(process.env.ML_ENABLED || '').toLowerCase() === 'false';
const enabled = Boolean(baseUrl) && !explicitlyDisabled;

const breaker = {
    consecutiveFailures: 0,
    openUntil: 0,
    lastError: null,
};

const stats = {
    calls: 0,
    hits: 0,
    misses: 0,
    failures: 0,
    cacheHits: 0,
};

const scoreCache = new Map();

export function isMlEnabled() {
    return enabled;
}

/**
 * Learned scores in [0, 1] keyed by song id.
 *
 * Returns null whenever the model has nothing to say -- disabled, circuit open,
 * timed out, unknown user. Callers must treat null as "rank without me".
 */
export async function getModelScores({ uid, songIds, mode = 'search' }) {
    if (!enabled || !uid) return null;

    const ids = dedupeIds(songIds);
    if (ids.length === 0) return null;

    const cacheKey = `${uid}:${mode}:${ids.length}:${ids[0]}:${ids[ids.length - 1]}`;
    const cached = readCache(cacheKey);
    if (cached) {
        stats.cacheHits += 1;
        return cached;
    }

    if (isCircuitOpen()) return null;

    const budget = mode === 'recommendation' ? recommendationTimeoutMs : timeoutMs;
    stats.calls += 1;

    try {
        const body = await postJson('/score', { userId: String(uid), songIds: ids }, budget);
        const scores = body?.scores;
        if (!scores || typeof scores !== 'object') {
            recordSuccess();
            stats.misses += 1;
            return null;
        }

        const parsed = new Map();
        for (const [songId, value] of Object.entries(scores)) {
            const score = Number(value);
            if (Number.isFinite(score)) parsed.set(songId, score);
        }

        recordSuccess();

        // A cold-start user scores nothing; that is a success, not a failure,
        // but there is no signal to blend in.
        if (parsed.size === 0) {
            stats.misses += 1;
            return null;
        }

        stats.hits += 1;
        writeCache(cacheKey, parsed);
        return parsed;
    } catch (error) {
        recordFailure(error);
        return null;
    }
}

/**
 * Liveness + model state, for the gateway's own health endpoint.
 */
export async function getMlStatus() {
    if (!enabled) {
        return {
            enabled: false,
            reason: explicitlyDisabled ? 'ML_ENABLED=false' : 'ML_SERVICE_URL not set',
        };
    }

    const base = {
        enabled: true,
        url: baseUrl,
        circuit: isCircuitOpen() ? 'open' : 'closed',
        lastError: breaker.lastError,
        stats: { ...stats },
    };

    try {
        const body = await postJson('/health', null, recommendationTimeoutMs, 'GET');
        return { ...base, reachable: true, model: body?.model ?? null };
    } catch (error) {
        return { ...base, reachable: false, error: error.message };
    }
}

// One dispatcher per distinct budget. `connect.timeout` is the important one:
// neither AbortSignal.timeout nor headersTimeout/bodyTimeout bounds the TCP
// connect phase, so a service that accepts connections slowly -- exactly what a
// spun-down Render instance does -- would otherwise hang for undici's 10s
// default and blow the budget by an order of magnitude.
const agents = new Map();

function getAgent(budgetMs) {
    let agent = agents.get(budgetMs);
    if (!agent) {
        agent = new Agent({
            connect: { timeout: budgetMs },
            headersTimeout: budgetMs,
            bodyTimeout: budgetMs,
            keepAliveTimeout: 30_000,
            connections: 8,
        });
        agents.set(budgetMs, agent);
    }
    return agent;
}

async function postJson(path, payload, budgetMs, method = 'POST') {
    const headers = { accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    if (payload !== null) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const attempt = (async () => {
        const response = await request(`${baseUrl}${path}`, {
            method,
            headers,
            body: payload === null ? undefined : JSON.stringify(payload),
            dispatcher: getAgent(budgetMs),
            headersTimeout: budgetMs,
            bodyTimeout: budgetMs,
            signal: controller.signal,
        });

        if (response.statusCode >= 400) {
            // Drain so the connection can be reused instead of being torn down.
            await response.body.dump();
            throw new Error(`ml-service responded ${response.statusCode}`);
        }

        return response.body.json();
    })();

    return withDeadline(attempt, controller, budgetMs, path);
}

/**
 * Enforce a real wall-clock budget on a request.
 *
 * undici's own timeouts run on a coarse ~1s tick, so a sub-second budget silently
 * becomes a one-second one. Racing against a plain Node timer is what actually
 * keeps a search inside its budget; the abort still fires so the socket is torn
 * down rather than leaked, and the losing promise is drained so its rejection
 * never surfaces as an unhandled rejection.
 */
function withDeadline(attempt, controller, budgetMs, path) {
    let timer;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`ml-service ${path} exceeded ${budgetMs}ms`));
        }, budgetMs);
    });

    attempt.catch(() => {});

    return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
}

function isCircuitOpen() {
    if (breaker.openUntil === 0) return false;
    if (Date.now() >= breaker.openUntil) {
        // Cooldown elapsed: let one request through as a probe.
        breaker.openUntil = 0;
        breaker.consecutiveFailures = FAILURE_THRESHOLD - 1;
        return false;
    }
    return true;
}

function recordSuccess() {
    breaker.consecutiveFailures = 0;
    breaker.openUntil = 0;
    breaker.lastError = null;
}

function recordFailure(error) {
    stats.failures += 1;
    breaker.consecutiveFailures += 1;
    breaker.lastError = error?.message ?? String(error);

    if (breaker.consecutiveFailures >= FAILURE_THRESHOLD && breaker.openUntil === 0) {
        breaker.openUntil = Date.now() + OPEN_CIRCUIT_COOLDOWN_MS;
        console.warn(
            `[ml] circuit opened for ${OPEN_CIRCUIT_COOLDOWN_MS}ms after ` +
            `${breaker.consecutiveFailures} failures: ${breaker.lastError}`
        );
    }
}

function dedupeIds(songIds) {
    const seen = new Set();
    const ids = [];
    for (const raw of Array.isArray(songIds) ? songIds : []) {
        const id = String(raw ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= MAX_SONGS_PER_REQUEST) break;
    }
    return ids;
}

function readCache(key) {
    const entry = scoreCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        scoreCache.delete(key);
        return null;
    }
    return entry.scores;
}

function writeCache(key, scores) {
    scoreCache.set(key, { scores, expiresAt: Date.now() + SCORE_CACHE_TTL_MS });
    if (scoreCache.size > SCORE_CACHE_MAX_ENTRIES) {
        // Map preserves insertion order, so the first key is the oldest write.
        const oldest = scoreCache.keys().next().value;
        if (oldest !== undefined) scoreCache.delete(oldest);
    }
}
