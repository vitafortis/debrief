# syntax=docker/dockerfile:1
# The Node images: web (UI + migrations), calendar-sync and mcp. Pick one with --target.
# The transcriber is Python and has its own Dockerfile in transcriber/.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY web/package.json web/
COPY services/calendar-sync/package.json services/calendar-sync/
COPY services/mcp/package.json services/mcp/
RUN pnpm install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build \
 && pnpm --filter calendar-sync build \
 && pnpm --filter mcp build \
 && pnpm --filter calendar-sync exec esbuild ../../packages/core/src/migrate-cli.ts --bundle --platform=node --target=node24 --format=esm \
      --outfile=/repo/dist/migrate.mjs "--banner:js=import{createRequire}from'module';const require=createRequire(import.meta.url);"

FROM node:24-alpine AS runtime
LABEL org.opencontainers.image.source=https://github.com/vitafortis/debrief
ENV NODE_ENV=production
# tzdata for time zones. The recordings volume is writable by any user, so
# compose.nas.yaml can run the services as the NAS share's owner.
RUN apk add --no-cache tzdata && mkdir -p /data/recordings && chmod 777 /data/recordings
WORKDIR /app

FROM runtime AS web
ENV PORT=3000 HOSTNAME=0.0.0.0 MIGRATIONS_DIR=/app/drizzle
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./web/.next/static
COPY --from=build /repo/packages/core/drizzle ./drizzle
COPY --from=build /repo/dist/migrate.mjs ./migrate.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
# Migrations first: the other services wait for the schema.
CMD ["sh", "-c", "node migrate.mjs && exec node web/server.js"]

FROM runtime AS calendar-sync
COPY --from=build /repo/services/calendar-sync/dist/main.mjs ./main.mjs
USER node
CMD ["node", "main.mjs"]

FROM runtime AS mcp
ENV PORT=3001
COPY --from=build /repo/services/mcp/dist/main.mjs ./main.mjs
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3001/health || exit 1
CMD ["node", "main.mjs"]
