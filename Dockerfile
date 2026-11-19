# syntax=docker/dockerfile:1
# ---- build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install exactly what the lockfile pins; dev dependencies are needed to build.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json tsconfig.client.json vite.client.config.ts ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we copy forward.
RUN npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S openaccess && adduser -S -G openaccess openaccess

COPY --from=build --chown=openaccess:openaccess /app/package.json ./package.json
COPY --from=build --chown=openaccess:openaccess /app/node_modules ./node_modules
COPY --from=build --chown=openaccess:openaccess /app/dist ./dist

USER openaccess
EXPOSE 3000

# Busybox wget ships with Alpine; PORT can be overridden by the platform.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" | grep -q ok

CMD ["node", "dist/server/server/index.js"]
