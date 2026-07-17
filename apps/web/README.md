# @mill/web — UI prototype

A **non-functional prototype** of the Mill interface. Interactions are mocked (see
`src/lib/mock.ts`); it is structured like the real app (`docs/ARCHITECTURE.md`) so it
evolves into it. Every page carries small `(i)` explanations and button tooltips.

## Pages
- **Workspace** (`/workspace`) — projects (git repos) as cards, with sync/health badges.
- **Project** (`/projects/:id`) — repo header, Sync + Export actions, workflows list.
- **Workflow editor** (`/projects/:id/workflows/:id`) — the DAG graph (@xyflow), a node
  code inspector, and a **live run** panel that streams per-node status + logs.
- **Fleet** (`/fleet`) — worker capacity/memory + queue depth (KEDA/HPA context).

## Develop
```bash
npm install
npm run dev          # http://localhost:5173
```

## Build + serve the production bundle
```bash
npm run build
npm run preview      # http://localhost:4173
```

## End-to-end tests (Playwright)
The tests encode the intended functionality — they are the spec the app must satisfy
as it becomes functional. The config builds + serves the app automatically.
```bash
npm run test:e2e:install   # one-time: install the Chromium browser
npm run test:e2e
```

## Docker
```bash
# serve the UI
docker build -t mill-web .
docker run --rm -p 8080:80 mill-web            # http://localhost:8080

# run the e2e suite (self-contained)
docker build -f Dockerfile.test -t mill-web-e2e .
docker run --rm mill-web-e2e
```
Or from the repo root: `docker compose up web` / `docker compose run --rm e2e`.

## What "functional" will mean
These specs currently pass against the mock. As real wiring lands (controller API,
git reconcile, isolated workers), the mock is replaced but the specs stay — they
guard that the described features keep working.
