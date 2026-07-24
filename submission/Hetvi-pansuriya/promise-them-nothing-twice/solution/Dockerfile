# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile for RelayAPI Express app
#
# Placed in solution/ alongside package.json.
#
# Layer-caching strategy:
#   1. Copy manifests first and run npm ci so the expensive npm install layer is
#      only invalidated when dependencies change, not on every source edit.
#   2. Copy source second so code changes are cheap to rebuild.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine

# Create and switch to a non-root working directory
WORKDIR /app

# --- Dependency layer (invalidated only when package files change) -----------
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Application source ------------------------------------------------------
COPY src/ ./src/

# PORT is read from the environment variable in src/server.js (default 3000).
# EXPOSE is documentation-only; the actual host binding is in docker-compose.yml.
EXPOSE 3000

# Drop to the built-in non-root 'node' user (UID 1000) provided by node:20-alpine.
# Running as root inside a container is a security hazard — if an attacker gains
# control of the process, they would have root privileges over the container.
USER node

# Same start command as local development (`npm start` → `node src/server.js`)
CMD ["npm", "start"]
