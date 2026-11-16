# One image for both processes (web app and launch worker). Built on the server itself (Arm64).
FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates sqlite3 curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
# Compilers for better-sqlite3 when no prebuilt binary matches this Node version.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN cd mcp && npm ci
COPY . .
RUN cd mcp && node build.mjs
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
RUN npm prune --omit=dev && rm -rf mcp/node_modules

FROM base AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATA_DIR=/data PORT=3000
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=10s --retries=3 CMD curl -fsS http://127.0.0.1:3000/api/health -o /dev/null -w '' || exit 1
CMD ["npx", "next", "start", "-p", "3000"]
