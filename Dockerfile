# ============================================================
# Combined Dockerfile: Node.js API + Python ML Service
# Runs both services in a single container using supervisord
# ============================================================

# ── Stage 1: Node.js dependencies ──
FROM node:20-slim AS node-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: Final combined image ──
FROM node:20-slim

# Install Python 3.11, pip, and supervisord
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    supervisor \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js setup ──
WORKDIR /app
COPY --from=node-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY index.js ./
COPY src/ ./src/

# ── Python ML service setup ──
WORKDIR /app/ml-service
COPY music-app-backend/ml-service/requirements.txt ./

# Install Python dependencies in a virtual env (avoids PEP 668 issues)
RUN python3 -m venv /opt/ml-venv && \
    /opt/ml-venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/ml-venv/bin/pip install --no-cache-dir -r requirements.txt

COPY music-app-backend/ml-service/main.py ./
COPY music-app-backend/ml-service/model.py ./
COPY music-app-backend/ml-service/train.py ./

# ── Supervisord config ──
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# ── Environment variables ──
ENV NODE_ENV=production
# Render sets PORT automatically; Node.js will use it.
# ML service runs on an internal port (not exposed externally).
ENV ML_SERVICE_PORT=8001

WORKDIR /app

# Render exposes this port for the main web service
EXPOSE 3000

# Launch both services via supervisord
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
