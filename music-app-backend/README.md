# Section 5.1 Backend Architecture

This workspace includes two services:

- `node-api/`: API gateway, Firebase reads/writes, route handling
- `ml-service/`: FastAPI ML scoring service for ranking and recommendations

## 1. Node API setup

```bash
cd music-app-backend/node-api
npm install
cp .env.example .env
```

Set in `node-api/.env`:

- `FIREBASE_DATABASE_URL`
- `FIREBASE_SERVICE_ACCOUNT_PATH` (or `FIREBASE_SERVICE_ACCOUNT_JSON`)
- `ML_SERVICE_URL` (for local dev: `http://localhost:8000`)

Run:

```bash
npm run dev
```

## 2. ML service setup

```bash
cd music-app-backend/ml-service
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
```

Run:

```bash
uvicorn main:app --reload --port 8000
```

## 3. Optional NCF training bootstrap

Expected CSV schema:

- `user_id`
- `song_id`
- `label` (0 or 1)

Run:

```bash
cd music-app-backend/ml-service
python train.py
```

## 4. Endpoints

- Node: `POST /search`
- Node: `GET /recommend/:userId`
- ML: `POST /rank`
- ML: `POST /recommend`
- Health checks: `GET /health` on both services
