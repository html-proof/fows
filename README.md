# music-hub-backend

## Render sleep mode: what is possible

A sleeping Render web service cannot wake itself from code running inside that same service.
If the process is asleep, timers and in-process jobs are also asleep.

Working automatic options:
1. Keep the service always-on by using a paid Render instance.
2. Ping it from an external scheduler (GitHub Actions, Render Cron Job, UptimeRobot, etc.).
3. Run a separate worker/cron process that pings your web service.

## Health endpoint

This API exposes a lightweight health endpoint for keepalive probes:
- `GET /healthz`
- `GET /health` (redirects to `/healthz`)

Use this endpoint for all keepalive traffic.

## GitHub Actions keepalive

Workflow file: `.github/workflows/render-keepalive.yml`

Setup:
1. Open `Settings -> Secrets and variables -> Actions` in GitHub.
2. Add secret `RENDER_BACKEND_URL`.
3. Set it to either:
   - `https://your-service-name.onrender.com`
   - or `https://your-service-name.onrender.com/healthz`

The workflow runs every 5 minutes and pings `/healthz`.

## Backend keepalive worker (for Render Cron/Worker)

A keepalive worker script is available at `scripts/keepalive-worker.js`.

Run locally:
```bash
KEEPALIVE_URL=https://your-service-name.onrender.com npm run keepalive:worker
```

Environment variables:
- `KEEPALIVE_URL` (required)
- `KEEPALIVE_INTERVAL_MS` (optional, default `240000`)
- `KEEPALIVE_TIMEOUT_MS` (optional, default `10000`)

Recommended on Render:
1. Create a separate **Background Worker** or **Cron Job** service.
2. Point it to this same repo.
3. Start command: `npm run keepalive:worker`
4. Set env `KEEPALIVE_URL=https://your-service-name.onrender.com`

This keeps the web service warm more reliably than in-process timers.
## ML personalization

The trained ranking model runs in a **separate Python service**
(`music-app-backend/ml-service`), deployed as its own Render web service. See
`render.yaml` for the blueprint that wires the two together, and
`music-app-backend/README.md` for training and endpoint details.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ML_SERVICE_URL` | *(empty)* | Base URL of the ML service. **Empty disables the integration** — the gateway then ranks with local heuristics only. |
| `ML_SERVICE_API_KEY` | *(empty)* | Shared secret, sent as `X-API-Key`. Must match the ML service. |
| `ML_ENABLED` | `true` | Kill switch. Set `false` to bypass the ML service without clearing the URL. |
| `ML_TIMEOUT_MS` | `800` | Per-request budget for search reranking. |
| `ML_RECOMMENDATION_TIMEOUT_MS` | `2000` | Per-request budget for recommendations, radio and next-song. |

### Failure behaviour

The ML service is treated as strictly optional. If it is disabled, asleep,
unreachable, or slower than its budget, the request is **not** retried and the
user is **not** made to wait — the gateway ranks with its own heuristics, which
is exactly what it did before the integration existed.

A circuit breaker opens after 3 consecutive failures and stays open for 30s, so
a spun-down ML instance costs one timeout rather than one per request. Scores
are cached for 60s per user/result-set.

Because Render free instances spin down, expect the first request after an idle
period to fall back while the ML service wakes. Keep it warm the same way the
gateway is kept warm (see the keepalive section above), pointed at the ML
service's `/health`.

### Checking it

```bash
curl https://your-service.onrender.com/healthz/ml
```

Reports whether the integration is enabled, whether the service is reachable,
circuit state, call/hit/failure counters, and the loaded model's training
metrics. It is deliberately **not** part of `/healthz`, which must stay a local
zero-IO check for keepalive probes.
