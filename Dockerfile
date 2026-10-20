# Self-hosted chart app: the Vela library sources + the app in app/, built into one
# small runtime image. Build context is the repository root.

# ── Build ──────────────────────────────────────────────────────────────────────
FROM node:24.19.0-slim AS build
WORKDIR /repo

# Library dependencies (the web bundle imports Vela straight from src/).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# App dependencies.
COPY app/package.json app/package-lock.json app/
RUN cd app && npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src src
COPY app app
RUN cd app && npm run build && npm prune --omit=dev --no-audit --no-fund

# ── Runtime ────────────────────────────────────────────────────────────────────
FROM node:24.19.0-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIR=/app/dist/web \
    CONFIG_DIR=/app/config
WORKDIR /app
COPY --from=build --chown=root:root /repo/app/node_modules ./node_modules
COPY --from=build --chown=root:root /repo/app/dist ./dist
COPY --from=build --chown=root:root /repo/app/package.json ./
COPY --chown=root:root app/config ./config
COPY --chown=root:root LICENSE NOTICE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
