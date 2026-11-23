# Build from the app root:  docker build -f deploy/Dockerfile -t board .      (or: docker compose -f deploy/docker-compose.yml up -d --build)
# Add LibreOffice (DOCX/ODT/RTF previews, ~600 MB):  --build-arg WITH_LIBREOFFICE=1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
COPY web/package.json web/package-lock.json web/
COPY server/package.json server/package-lock.json server/.npmrc server/
RUN npm --prefix web ci && npm --prefix server ci
COPY web web
COPY server server
RUN npm --prefix web run build && npm --prefix server run build && npm --prefix server prune --omit=dev

FROM node:22-bookworm-slim
ARG WITH_LIBREOFFICE=0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini fontconfig \
 && if [ "$WITH_LIBREOFFICE" = "1" ]; then apt-get install -y --no-install-recommends libreoffice-writer; fi \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/package.json server/
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5180 DATA_DIR=/data
VOLUME /data
EXPOSE 5180
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
