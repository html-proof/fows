# Section 5.1 Backend Architecture

- `ml-service/`: FastAPI ranking/recommendation service holding the trained model

This directory contains **only** the ML service. The API gateway is `src/` at
the repository root — that is what Render deploys and what the app talks to.
(An early `node-api/` scaffold used to sit here duplicating it; it was never
deployed and has been removed.)

## Why there is no TensorFlow here

The original `train.py` built a Keras NCF model. TensorFlow needs well over
512 MB of RAM just to import and pulls a ~1 GB image, so it could never run on
the Render instance that serves traffic — which is why ML was effectively
switched off in the app.

It is now a logistic matrix factorization trained directly in numpy: the same
model family (learned user/song embeddings scored against each other), minus the
dense MLP head that was the expensive part. Serving needs `numpy` and nothing
else, and the running service sits around 100 MB resident.

## 1. ML service setup

```bash
cd music-app-backend/ml-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Run:

```bash
uvicorn main:app --reload --port 8000
```

The service boots with or without a trained model. With no artifacts present it
serves heuristic scores and reports why on `/health` — an untrained deployment
still answers every request.

## 2. Training

Training deps are kept out of the serving image:

```bash
pip install -r requirements-train.txt
```

Expected CSV schema (`data/interactions.csv`):

- `user_id`
- `song_id`
- `label` (0 or 1)

```bash
cd music-app-backend/ml-service
python train.py
```

Writes to `MODEL_DIR` (default `artifacts/`):

- `mf_model.npz` — embeddings and biases, float32
- `metadata.json` — id→index maps, metrics, schema version

Each epoch prints train loss plus held-out validation loss and AUC. Validation
AUC is the number to watch; if it stops improving, cut `EPOCHS`.

Tunables: `EPOCHS`, `BATCH_SIZE`, `EMBEDDING_DIM`, `LEARNING_RATE`,
`REGULARIZATION`, `TRAIN_DATA_PATH`, `MODEL_DIR`.

**Artifact size scales with catalogue size:** roughly
`(users + songs) × EMBEDDING_DIM × 4 bytes`. At 50k users and 200k songs with
dim 32 that is ~32 MB in memory. Lower `EMBEDDING_DIM` if it grows past the
instance budget.

After training, either redeploy or hot-swap without a restart:

```bash
curl -X POST -H "X-API-Key: $ML_SERVICE_API_KEY" https://your-ml-service.onrender.com/model/reload
```

## 3. Endpoints

- `POST /score` — **what the live gateway calls.** Takes `{userId, songIds}`,
  returns the learned score per song. No heuristics, no song metadata.
- `POST /rank` — heuristic + model ranking over full song objects
- `POST /recommend` — recommendation list for a user
- `POST /model/reload` — reload artifacts from disk
- `GET /health` — liveness plus model state (loaded, trained_at, metrics, RSS)

All POST routes require the `X-API-Key` header when `ML_SERVICE_API_KEY` is set;
without it only localhost callers are accepted.

## 4. How the gateway uses it

The gateway asks for scores, not for an ordering. Ranking policy — lexical
guardrails, language boosts, result partitioning — stays in
`src/services/personalizationModel.js`, and the trained score is folded in as
one more feature: **15%** of the final score for search, **40%** for
recommendations, radio and next-song.

That split is deliberate. A collaborative model that outranks an exact title
match is a regression, not personalization, so on search it can reorder within a
relevance tier but cannot lift an off-topic song above a genuine match.

The model contributes nothing in three cases, each falling back cleanly to the
previous heuristic behaviour:

- the user is unknown to the model (cold start)
- the song is unknown to the model (scored a neutral 0.5, which is discarded)
- the service is disabled, unreachable, or over its latency budget

See the root `README.md` for gateway configuration.
