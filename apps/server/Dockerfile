# Build from the repo root: docker build -f apps/server/Dockerfile .
FROM node:24-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@12.15.0
COPY . .
RUN pnpm install --frozen-lockfile --filter "@provenance/server..." && pnpm --filter @provenance/server build

FROM node:24-slim
LABEL org.opencontainers.image.source="https://github.com/yy4382/ob-provenance-sync"
LABEL org.opencontainers.image.description="Provenance sync server: Yjs sync, vault ops API and remote MCP for the Obsidian plugin"
WORKDIR /app
COPY --from=build /repo/apps/server/dist/server.js ./server.js
ENV PROVENANCE_CONFIG=/data/config.json
VOLUME /data
EXPOSE 8787
CMD ["node", "server.js"]
