# syntax=docker/dockerfile:1
# Backend image for the local Gate-2 stack (api + worker share it; command differs).
# A shipped, layer-optimized image lands at M6 — this is for local docker-compose.
FROM oven/bun:1.3.14
WORKDIR /app

# git: the reconciler shells out to it (ARCHITECTURE §3.3).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Workspace manifests + sources (apps/web is intentionally excluded — backend only).
COPY package.json ./
COPY tsconfig.backend.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY apps/cli ./apps/cli
COPY examples ./examples

RUN bun install

# Pre-built web UIs (built on the host): live variant at /, mock prototype at /prototype.
COPY apps/web/dist-live ./web-live
COPY apps/web/dist-prototype ./web-prototype

# Seed a bare git repo (folder-per-project) the controller clones + reconciles at runtime.
RUN git config --global user.email "ci@mill.dev" \
 && git config --global user.name "Mill CI" \
 && git config --global init.defaultBranch main \
 && git init -q -b main /tmp/seed \
 && cp -r /app/examples/billing /tmp/seed/billing \
 && git -C /tmp/seed add -A \
 && git -C /tmp/seed commit -q -m "seed billing project" \
 && git clone -q --bare /tmp/seed /app/project-repo.git \
 && rm -rf /tmp/seed

# Overridden per-service in docker-compose.
CMD ["bun", "/app/apps/api/src/server.ts"]
