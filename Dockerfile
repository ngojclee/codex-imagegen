FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3456 \
    CODEX_AUTH_PATH=/data/auth.json \
    POOL_ROOT=/data/pool \
    ACCOUNTS_DIR=/data/pool/accounts \
    EVENTS_LOG=/data/pool/events.log \
    OUTPUT_DIR=/data/output

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p /data/pool/accounts /data/output

EXPOSE 3456
VOLUME ["/data"]

CMD ["node", "src/index.mjs"]
