FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/claude-tools-kit ./packages/claude-tools-kit

RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8080
ENV STORAGE_PATH=/app/storage
ENV DB_PATH=/app/data/enterprise-kb.db

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public

RUN mkdir -p /app/data /app/storage && chown -R node:node /app/data /app/storage

USER node

EXPOSE 8080
VOLUME ["/app/data", "/app/storage"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
