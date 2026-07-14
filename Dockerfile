# Reproducible production image: compile TypeScript once, then run only emitted
# JavaScript and production dependencies as an unprivileged user.
FROM node:24.18.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts/apply-schema.ts ./scripts/apply-schema.ts
RUN npm run build

FROM node:24.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=9000
WORKDIR /app

# pdftoppm rasterizes uploaded PDFs for Qwen-VL. The pinned base image fixes the
# Debian release; apt supplies security-patched bookworm packages at build time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --from=build --chown=node:node /app/dist/scripts/apply-schema.js ./dist/scripts/apply-schema.js
# Runtime assets deliberately live beside their compiled consumers.
COPY --chown=node:node src/ui.html ./dist/src/ui.html
COPY --chown=node:node src/db/schema.sql ./dist/src/db/schema.sql
COPY --chown=node:node demo/sample-invoice.png ./dist/demo/sample-invoice.png
COPY --chown=node:node package.json ./dist/package.json

EXPOSE 9000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
