FROM node:20-slim AS node-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim

WORKDIR /app

COPY --from=node-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY index.js ./
COPY src/ ./src/

ENV NODE_ENV=production
ENV MALLOC_ARENA_MAX=2

EXPOSE 3000

CMD ["node", "--max-old-space-size=300", "index.js"]
