FROM node:22-slim AS node-deps
WORKDIR /app

# Build tools needed for native modules (better-sqlite3 uses node-gyp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim

WORKDIR /app

COPY --from=node-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY index.js ./
COPY src/ ./src/

# Ensure the data directory for SQLite catalog DB exists
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV MALLOC_ARENA_MAX=2

EXPOSE 3000

CMD ["node", "--max-old-space-size=300", "index.js"]
