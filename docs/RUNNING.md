# Running Mill locally

Two things live in this repo: the **runtime stack** (controller + queue + worker — the real
backend) and the **web prototype** (UI on mock data). This covers the runtime stack.

## The local stack (Gate 2)

```
docker compose up --build redis api worker
```

Everything is served on **http://localhost:8787** by the controller:

| URL | What |
|---|---|
| **`/`** | **Live UI** — the polished editor **wired to the real backend**. Open `billing / invoices`, press **▶ Run**, watch it execute for real. |
| **`/prototype`** | the **mock** design prototype (same UI, simulated) — for side-by-side comparison. |
| `/console` | a bare-bones live console (no framework) |
| `/api/*` | the JSON API (below) |

- **Worker**: pulls jobs from Redis, runs them, streams logs back
- **Redis**: queue + worker registry + live event bus

Projects come from `examples/` (baked into the image). Secrets are injected flat via
`MILL_SECRETS` on the worker (as k8s Secrets would be on EKS); each node still only sees
its declared refs.

### Try it

```bash
# list projects
curl -s localhost:8787/api/projects | jq

# trigger a run → { "jobId": "job_xxxx" }
curl -s -XPOST localhost:8787/api/projects/billing/workflows/invoices/trigger \
  -H 'content-type: application/json' -d '{"input":{}}'

# job status + result
curl -s localhost:8787/api/jobs/<jobId> | jq        # → result: { "loaded": 2 }

# live per-node status + logs (Server-Sent Events)
curl -s localhost:8787/api/jobs/<jobId>/events

# the worker fleet (heartbeat registry)
curl -s localhost:8787/api/workers | jq
```

`dunning` demonstrates a failing node:
```bash
curl -s -XPOST localhost:8787/api/projects/billing/workflows/dunning/trigger -d '{}'
# → status "failed", error mentions SMTP, offending node = send
```

### End-to-end smoke test

With the stack up:
```bash
bun scripts/e2e-smoke.ts        # triggers invoices + dunning over HTTP, checks results & events
```

### Crash-recovery test (kill a worker mid-job)

```bash
docker compose up -d --build --scale worker=2 redis api worker
bash scripts/durability-test.sh    # triggers a slow job, kills its worker, verifies requeue + completion
```
Jobs are pulled into a per-worker *processing* list; a reaper in the controller requeues
the in-flight jobs of any worker whose heartbeat expires, so a surviving worker finishes
them. (BullMQ is the production swap — same seam, adds backoff/cron/priorities.)

## Backend unit + integration tests (no docker needed)

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test packages apps/cli apps/api           # unit + integration suite
npm run typecheck:backend
bun apps/cli/src/mill.ts run      examples/billing   invoices                 # run a whole workflow
bun apps/cli/src/mill.ts run-node examples/pipelines map-numbers each --input '{"nums":[2,3]}'  # test ONE step
```

The **`pipelines`** example project (`examples/pipelines`) is a suite of self-asserting
testing jobs that validate **step input→output continuity** while processing and iterating
over every data type (numbers, strings, objects, mixed arrays), plus `if`-branch and
`callScript` continuity — each node throws if its input arrived wrong, so a green run *is*
the proof.

### External dependencies (npm libraries)

A JS Code / loop-body node can declare npm packages under its `deps` (in `workflow.yaml`,
or via the **Dependencies** panel in the editor):

```yaml
- key: enrich
  kind: jscode
  file: nodes/enrich.js
  deps: { ms: "^2.1.3", nanoid: "^5.0.9" }   # node can `import ms from "ms"`
```

On reconcile the controller runs `bun install` for the union of a project's node deps into
its working copy, so the library resolves in **both** in-process and **isolated-container**
runs (the container mounts the installed `node_modules` read-only). `node_modules` and the
generated `package.json` are kept out of git (`.git/info/exclude`), never committed. The
**export** bundle lists the deps in its `package.json`, so `bun install && bun run index.js`
downloads them and runs anywhere. See `examples/deps-demo`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/projects` | indexed projects + their workflows |
| GET | `/api/projects/:id/workflows/:wf` | a workflow's graph (nodes/edges/order) |
| POST | `/api/projects/:id/workflows/:wf/trigger` | enqueue a run → `{ jobId }` |
| POST | `/api/projects/:id/workflows/:wf/nodes/:key/test` | **test one step** in isolation with a supplied `{ input }` → `{ status, output, logs }` (no upstream nodes run) |
| GET | `/api/jobs/:id` | status + result |
| GET | `/api/jobs/:id/events` | live per-node status + logs (SSE) |
| GET | `/api/workers` | worker registry + queue depth |
| GET | `/api/fleet` | Fleet view: enriched workers (mem, executor, running jobs) + rolling execution stats (throughput, p50/p95, success rate, wait) + queue breakdown |
| GET | `/api/status` | GitOps sync/health + per-workflow validation |
| POST | `/api/reconcile` | reconcile now (fetch → validate → apply) |
| POST | `/api/projects/:id/workflows/:wf` | **Save = commit**: author/edit a workflow — validates (Zod) then writes `workflow.yaml` + node `.js`, commits + pushes, and reconciles. `400` with `issues` on an invalid graph. |
| DELETE | `/api/projects/:id/workflows/:wf` | delete a workflow (commits + pushes the removal to git, then reconciles) |
| DELETE | `/api/projects/:id` | delete a whole project (same git-backed removal) |

> **Delete is a git write.** Both DELETE routes commit the removal to your tracked branch
> and push, so the repo stays the source of truth. They require a git-backed workspace
> (`PROJECT_REPO` set) and return `400` on a mounted-dir workspace. In the UI, the trash
> icon on a project card (Projects page) or a workflow row (Project page) does the same.

The **Fleet** page (`/fleet`) renders `/api/fleet` live when the UI is built with
`VITE_MILL_MODE=live`: real workers with live memory/heartbeat-age, the jobs each is
running right now, and fleet-wide throughput/latency/success computed from a rolling
window of completions. Without a live worker it shows the mock catalogue for design.

### Point Mill at your own GitHub repo

By default the stack uses a demo repo baked into the image. To use your own:

1. Create an **empty** GitHub repo (no README — truly empty).
2. Create a **Personal Access Token** (fine-grained: *Contents = Read*; or classic: `repo`).
3. Seed it with the demo project (or push your own projects, folder-per-project):
   ```bash
   scripts/push-example.sh https://github.com/you/your-repo.git <TOKEN> main
   ```
4. Create `.env` from `.env.example` with your HTTPS URL + token, then:
   ```bash
   docker compose up -d --build api worker redis
   curl -s localhost:8787/api/status      # → Synced / Healthy once it reconciles
   ```

`.env`:
```
PROJECT_REPO=https://github.com/you/your-repo.git
PROJECT_BRANCH=main
GIT_TOKEN=ghp_xxxxxxxx
```
Use the **HTTPS** URL (not `git@github.com:…`). The token is used only to clone/fetch and
is redacted from logs. Now edits pushed to that repo are picked up by the reconcile loop.

## Working example jobs (that succeed)

The `demos` project has real jobs to schedule/modify/test (`billing/dunning` fails **by
design** — it's the "bad node" demo):

| Workflow | What it does |
|---|---|
| `demos/scrape-novi` | scrapes novi-health.com → title, headings, link/image counts |
| `demos/github-zen` | fetches a random GitHub "zen" line |
| `demos/math` | pure compute — try `--input '{"numbers":[10,20,30]}'` |
| `demos/site-check` | **scheduled every 30s** (cron) uptime probe of the site |

```bash
curl -s -XPOST localhost:8787/api/projects/demos/workflows/scrape-novi/trigger -d '{}'
```

## Triggers

- **Cron:** workflows with a `cron` trigger are scheduled by the controller (croner;
  5- or 6-field). Registered/refreshed on every reconcile. See `GET /api/triggers`.
- **Webhook:** `POST /hooks/:project/:workflow` starts a run (body = input). e.g.
  `curl -XPOST localhost:8787/hooks/demos/scrape-novi -d '{"input":{"url":"https://example.com"}}'`.

## Export (M5)

`GET /api/projects/:id/export` streams a standalone `.tar.gz` (a `Bun.build`-bundled
`index.js` + `package.json` + `run.sh` + `README`). It runs the **same** program with no
Mill, in **two modes**:

```bash
tar -xzf pipelines.tar.gz
bun run index.js map-numbers '{}'        # batch: run once, print the result
bun run index.js serve 8080              # server: expose an HTTP API port
curl -s -XPOST localhost:8080/run/types -d '{}'     # → { status, result }
```

`serve` exposes `GET /health` (+ workflow list) and `POST /run/<workflow>` (alias
`/hooks/<workflow>`) — the same entrypoint a webhook trigger hits. Some workflows are
batch jobs you just run; others (webhook-triggered) are meant to run as this long-lived
API server. The live UI's Export button downloads the bundle.

## GitOps (M3)

The controller **clones `PROJECT_REPO`** into a working copy and a reconcile loop drives
it toward the tracked branch: `fetch → validate the candidate revision in a throwaway
worktree → apply (checkout) only if every workflow compiles, else keep last-known-good`.
Status is exposed at `/api/status` (and shown on `/console`). Locally the repo is a bare
repo seeded into the image (`file:///app/project-repo.git`); the working copy is a shared
named volume so workers run the reconciled code.

Try the last-known-good safety (push a broken commit → it's rejected, the good version
keeps running; push a fix → it recovers):
```bash
# break a workflow, push, reconcile
docker compose exec api sh -c 'cd /tmp && git clone -q /app/project-repo.git e && cd e \
  && printf "apiVersion: mill/v1\nkind: Workflow\nmetadata: {name: invoices}\nnodes:\n  - {key: a, kind: jscode, name: A, file: nodes/a.js}\nedges: []\n" > billing/workflows/invoices/workflow.yaml \
  && git -c user.email=x@y -c user.name=x commit -aqm break && git push -q origin main'
curl -s -XPOST localhost:8787/api/reconcile     # → OutOfSync / Degraded, syncedRevision unchanged
curl -s -XPOST localhost:8787/api/projects/billing/workflows/invoices/trigger -d '{}'  # still runs (last-known-good)
```

## What's real vs. stand-in (this gate)

- **Real:** compiler, runtime interpreter, executor, the pull-based queue/registry/event
  model, controller API, worker with dynamic min–max concurrency + memory pause.
- **Stand-in (swapped later):** the queue is a minimal Redis implementation (→ **BullMQ**
  for retries/backoff/cron/stalled-recovery, M2); execution is in-process in the worker
  (→ **nsjail** subprocess on a Linux host, M1 hardening); the project comes from a mounted
  dir (→ **git clone + reconcile loop**, M3); no image build tuning / EKS yet (M6).
