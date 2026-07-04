# Archon Autopilot HTTP backend — the service that runs ON ALIBABA CLOUD
# (Function Compute custom container, or ECS / Container Service).
#
# Function Compute listens on the container's CAPort; we expose 9000 (PORT).
# Build for linux/amd64 when pushing from an ARM machine:
#   docker build --platform linux/amd64 -t archon-qwen-autopilot .

FROM node:20-slim

WORKDIR /app

# Install dependencies first for layer caching. tsx is a runtime dependency so
# the container runs the TypeScript entrypoint directly (no separate build step).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
# scripts/apply-schema.ts is the entrypoint for `npm run db:schema`
# (it reads ../src/db/schema.sql, already copied above).
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=9000
EXPOSE 9000

# HTTP server on 0.0.0.0:$PORT (Function Compute CAPort).
CMD ["npx", "tsx", "src/server.ts"]
