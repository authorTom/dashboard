# ---- Runtime dependencies ----------------------------------------------------
# There is no build step: the frontend is plain HTML/CSS/JS served as-is, and
# Express is the only runtime dependency. This stage exists purely so npm's
# cache and the lockfile install stay separate from the source layers.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Runtime stage -----------------------------------------------------------
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY server.js ./
COPY src ./src
COPY public ./public
COPY package.json ./

# links.json and the cached favicons live here. Created before dropping
# privileges so a named volume mounted at this path inherits the right owner;
# bind mounts must be writable by uid 1000.
RUN mkdir -p /data && chown -R node:node /data
USER node

ENV PORT=8080 \
    HOST=0.0.0.0 \
    DASHBOARD_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server.js"]
