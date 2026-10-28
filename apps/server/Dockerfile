# Build from the repo root: docker build -f apps/server/Dockerfile .
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @provenance/server build

FROM node:24-slim
WORKDIR /app
COPY --from=build /repo/apps/server/dist/server.js ./server.js
ENV PROVENANCE_CONFIG=/data/config.json
VOLUME /data
EXPOSE 8787
CMD ["node", "server.js"]
