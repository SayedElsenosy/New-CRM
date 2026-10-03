FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git cmake build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch v1.9.4 https://github.com/ggml-org/whisper.cpp.git
WORKDIR /src/whisper.cpp
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_OPENMP=OFF -DBUILD_SHARED_LIBS=OFF \
 && cmake --build build --config Release -j2 \
 && ./models/download-ggml-model.sh medium-q5_0

FROM node:22-bookworm-slim AS build
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
WORKDIR /app
COPY package.json package-lock.json ./
COPY admin-dashboard/package.json admin-dashboard/package.json
COPY whatsapp-bot/package.json whatsapp-bot/package.json
RUN npm install
COPY admin-dashboard admin-dashboard
COPY whatsapp-bot whatsapp-bot
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production SESSION_PATH=/data/whatsapp DASHBOARD_DIST=/app/admin-dashboard/dist \
    WHISPER_BIN=/opt/whisper/whisper-cli WHISPER_MODEL=/opt/whisper/models/ggml-medium-q5_0.bin \
    WHISPER_LANGUAGE=ar WHISPER_THREADS=2 WHISPER_MAX_SECONDS=180
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini gosu curl ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY admin-dashboard/package.json admin-dashboard/package.json
COPY whatsapp-bot/package.json whatsapp-bot/package.json
RUN npm install --omit=dev --workspace whatsapp-bot
COPY whatsapp-bot/src whatsapp-bot/src
COPY --from=whisper /src/whisper.cpp/build/bin/whisper-cli /opt/whisper/whisper-cli
COPY --from=whisper /src/whisper.cpp/models/ggml-medium-q5_0.bin /opt/whisper/models/ggml-medium-q5_0.bin
COPY whatsapp-bot/entrypoint.sh /app/entrypoint.sh
COPY --from=build /app/admin-dashboard/dist /app/admin-dashboard/dist
RUN mkdir -p /data/whatsapp && chown -R node:node /data /app && chmod +x /app/entrypoint.sh
EXPOSE 3001
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["/app/entrypoint.sh"]
