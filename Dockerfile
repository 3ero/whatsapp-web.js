# Root Dockerfile lets Railway detect Docker builds for new services.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=true \
    SYNC_DATA_DIR=/data/state \
    SYNC_OUTPUT_DIR=/data/Messags \
    PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ca-certificates fonts-liberation dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY index.js ./
COPY src ./src
COPY tools/conversation-sync ./tools/conversation-sync
RUN npm ci --prefix tools/conversation-sync --omit=dev --ignore-scripts

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "tools/conversation-sync/server.js"]
