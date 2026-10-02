FROM node:22-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium SESSION_PATH=/data/whatsapp
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation fonts-noto-core tini gosu && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY admin-dashboard/package.json admin-dashboard/package.json
COPY whatsapp-bot/package.json whatsapp-bot/package.json
RUN npm ci --omit=dev --workspace whatsapp-bot
COPY whatsapp-bot/src whatsapp-bot/src
RUN mkdir -p /data/whatsapp && chown -R node:node /data /app
COPY whatsapp-bot/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
EXPOSE 3001
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["/app/entrypoint.sh"]
