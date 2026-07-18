# Running Mill locally

Two things live in this repo: the **runtime stack** (controller + queue + worker — the real
backend) and the **web prototype** (UI on mock data). This covers the runtime stack.

> **Deploying to EKS?** See **[DEPLOYMENT.md](DEPLOYMENT.md)** — components, every env var +
> secret, how to feed secrets from k8s, and copy-paste manifests. Metrics/alerts:
> **[OBSERVABILITY.md](OBSERVABILITY.md)**.

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

## Frontend tests (Playwright)

Two tiers. The **mock suite** builds the prototype and runs against it — no backend needed:

```bash
docker compose build e2e && docker compose run --rm e2e     # all specs (mock mode)
# or locally:  cd apps/web && npm install && npx playwright test
```

A handful of specs are **live/deployed** (file names prefixed `deployed-`) — they exercise the
real backend the same way a browser hits it (the api serves the SPA same-origin at `:8787`).
They **skip** in the mock run and are gated on `DEPLOYED_BASE`. Run them against the up stack
on the compose network:

```bash
docker compose up -d redis api worker             # stack must be running
docker run --rm --network the-mill_default -e DEPLOYED_BASE=http://api:8080 \
  mill-web-e2e npx playwright test deployed-fleet.spec.ts deployed-editor.spec.ts
```

These cover the dynamic isolation ladder (live executor highlighting), the exclusive-execution
toggle, and a real **single-step run** (the step-tester executing one node against the backend).

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

### Security posture (deployment)

- **Control plane (`/api/*`) auth**: terminated at the Ingress (SSO/OIDC) per ARCHITECTURE.
  As defense-in-depth, set **`MILL_ADMIN_TOKEN`** — then every `/api/*` route requires
  `Authorization: Bearer <token>` **except** `/api/health` (liveness) and `/api/metrics`
  (scrape). Note: enabling it also locks the browser UI's API calls, so use it for
  headless/API deployments, or leave it unset and rely on Ingress SSO. **Never expose
  `/api/*` unauthenticated on an untrusted network.**
- **CORS** is same-origin only by default (the UI is served by the controller). Allow specific
  cross-origin browsers via `MILL_CORS_ORIGINS` (comma-separated). Webhook/REST callers are
  server-to-server and unaffected.
- **Ingress (`/p/*`) is bearer-authenticated** (global `MILL_INGRESS_TOKEN` or per-project
  `ingress.tokenEnv`), constant-time compared, closed by default (503 until configured).
- Save/Delete write to git; secrets are k8s Secret refs (never in git); `node_modules` are
  git-excluded. Path traversal in Save is rejected.

### Telemetry

- **Metrics**: `GET /api/metrics` — Prometheus counters + histograms + gauges. Full catalog,
  recommended **alerts** (PromQL) and **dashboard** panels are in **[OBSERVABILITY.md](OBSERVABILITY.md)**.
  The editor's **Observability** panel renders a live subset.
- **Logs**: api + worker emit **structured JSON** (`{ts, level, component, msg, …fields}`,
  token-redacted) — Loki-ready via Alloy. `MILL_LOG_FORMAT=json` forces JSON in a TTY;
  `MILL_LOG_LEVEL` sets the floor. (`packages/telemetry`.)
- Traces (run = trace, node = span) via OpenTelemetry/Tempo are the next increment behind
  the same surface; the metrics endpoint + structured logs are the production-ready pieces today.

### Tokenized ingress (webhook / REST URLs)

Every project and workflow gets a stable URL on the same host, secured by a **bearer token**
(`MILL_INGRESS_TOKEN`). REST/HTTP works today; WebSocket is designed-for (same routing) but
not yet implemented.

```
POST  https://the-mill.example.com/p/w/<workflow>/<project>     # trigger a workflow
GET   https://the-mill.example.com/p/<project>                  # list a project's endpoints
```

```bash
export TOK=…              # = MILL_INGRESS_TOKEN
curl -XPOST localhost:8787/p/w/math/demos          -H "Authorization: Bearer $TOK" -d '{"input":{"a":[1,2,3]}}'   # → { jobId } (async)
curl -XPOST "localhost:8787/p/w/math/demos?wait=1" -H "Authorization: Bearer $TOK" -d '{"input":{}}'             # → { status, result } (sync, bounded)
curl        localhost:8787/p/demos                 -H "Authorization: Bearer $TOK"                                # → project + workflow URLs
```

- **Auth**: `Authorization: Bearer <MILL_INGRESS_TOKEN>` (constant-time compared). If the token
  isn't configured the `/p` routes return `503` (disabled) — code-triggering endpoints are never
  open by default. Wrong/missing token → `401`.
- **Any payload format**: the ingress accepts **anything** (JSON, `x-www-form-urlencoded`,
  multipart, XML, raw) — it best-effort parses the body into `input` **and** hands the workflow
  the raw request on **`ctx.request`** = `{ method, contentType, headers, query, raw }`. So a
  node can parse any format itself and **verify the provider's HMAC signature** over `raw`:
  ```js
  export default function verify(input, ctx) {
    const { raw, headers } = ctx.request;
    const mac = crypto.createHmac("sha256", ctx.secrets.WEBHOOK_SECRET).update(raw).digest("hex");
    if (headers["x-signature"] !== mac) throw new Error("bad signature");
    return input;   // JSON/form already parsed; for XML/etc parse `raw` here
  }
  ```
  This is how you onboard many different webhook sources behind one entrypoint. See
  `examples/acuity` (Acuity appointment → enrich → route to 1–N downstream workloads).
- **Input**: `GET` → query params; other methods → best-effort parsed body (raw always on `ctx.request.raw`).
- **Custom path**: a workflow's `triggers: [{ type: webhook, path: <token> }]` also exposes
  `/p/w/<workflow>/<token>` (an unguessable capability URL).
- The **Endpoints** card on each project page shows + copies these URLs; the editor's webhook
  trigger shows the workflow's URL.

### Remote / standalone callScript

A Call Script node can target a **remote Mill export bundle** instead of an in-project
workflow — the export format *is* the remote-package format:

```yaml
- key: notify
  kind: callScript
  call: { ref: "std://acme/notify@v2", workflow: send }   # or an https://…/bundle.tgz URL
```

The executor fetches the bundle, caches it, and runs it (its `run.sh` installs the bundle's
own deps), passing the node's input and returning the result. `std://<path>@<ver>` resolves
against `MILL_STD_REGISTRY`; `http(s)://` URLs are used directly. (Remote code runs at the
same trust level as a local node — untrusted remote execution belongs on the microVM
isolation tier.) Set the ref + workflow in the Call Script inspector's *standalone* option.

### Retries, durability & schemas

Per-node knobs in `workflow.yaml`:

```yaml
- key: flaky
  kind: jscode
  file: nodes/flaky.js
  retry: { maxAttempts: 3, backoffMs: 30 }              # linear backoff + jitter
  inputSchema: "Array.isArray(input.items)"             # JS predicate, enforced before the node runs
  outputSchema: "typeof output.total === 'number'"      # enforced after — violation fails the node
```

- **Retry**: a transiently-failing node retries up to `maxAttempts`; a run-level retry
  (`POST /api/jobs/:id/retry`, or the **Re-run** button in Run history) re-runs the whole job.
- **Durability**: completed nodes are journaled to Redis, so a job requeued after a worker
  crash **resumes** instead of re-doing finished work (the reaper requeues on a missed heartbeat).
- **Schemas**: `inputSchema`/`outputSchema` are JS boolean expressions enforced at the node
  boundary in real runs and in the step-tester. See `examples/pipelines/{retry,validated}`.

### Exclusive execution (dedicate a whole worker/pod to a run)

A **workflow-level** flag in `workflow.yaml`:

```yaml
apiVersion: mill/v1
kind: Workflow
metadata: { name: heavy-report }
exclusive: true            # run alone on a worker/pod until done — no co-tenant jobs
triggers: [ { type: manual } ]
nodes: [ ... ]
```

- When a worker pulls an `exclusive` job it **dedicates itself**: it takes no other jobs until
  that run finishes, so the whole worker (on EKS, the whole **pod** — all its CPU/memory) is
  reserved for that one run. Use it for heavy / CPU- or memory-hungry / noisy workloads.
- If a *busy* worker pulls it, the job is atomically returned to the queue for an idle worker
  (or a freshly autoscaled pod) to claim — so it never runs alongside other work.
- Also settable from the editor's **Triggers** panel (the *Run exclusively* toggle).
- **Ops impact:** an exclusive run drops that pod's effective concurrency to 1. It pairs with
  queue-depth autoscaling — the queued exclusive job raises `mill_queue_depth`, KEDA/HPA adds
  a pod, and that pod dedicates itself. See
  **[DEPLOYMENT.md → Autoscale on queue depth](DEPLOYMENT.md#autoscale-on-queue-depth-custom-metrics--recommended)**.

### Concurrency policy (cron overlap)

A **workflow-level** (or per-trigger) knob that controls what happens when a **cron** run would
overlap a still-in-progress one — k8s CronJob semantics:

```yaml
apiVersion: mill/v1
kind: Workflow
metadata: { name: nightly-rollup }
concurrencyPolicy: Forbid        # Allow (default) | Forbid | Replace
triggers: [ { type: cron, schedule: "*/5 * * * *" } ]
nodes: [ ... ]
```

- **Allow** (default) — overlapping runs are fine.
- **Forbid** — if a run is already queued or executing, **skip** the new one.
- **Replace** — best-effort: **drop a still-queued** prior run so the newest wins; if a run is
  already **executing**, let it finish and skip the new one (no mid-run kill).
- **Enforced for `cron` triggers only.** Webhook / manual / event runs always fire (they're
  intentional). A per-trigger `concurrencyPolicy` overrides the workflow-level one.
- Metrics: `mill_concurrency_skipped_total{policy}`, `mill_concurrency_replaced_total{policy}`.

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
| GET | `/api/jobs/:id/timeline` | per-node spans for a finished run (powers Run detail) |
| POST | `/api/jobs/:id/retry` | re-run a job with the same input → `{ jobId }` |
| GET | `/api/projects/:id/workflows/:wf/runs` | recent runs for a workflow (Run history) |
| POST | `/api/projects` | **create a project**: writes `<id>/project.yaml`, commits, reconciles |
| GET | `/api/reconcile-events` | recent reconcile activity (project-page feed) |
| GET | `/api/projects/:id/diff` | what a Sync would apply (live-vs-target name-status diff) |
| GET | `/api/workers` | worker registry + queue depth |
| GET | `/api/metrics` | **Prometheus metrics** — counters (`mill_jobs_total{status}`, `mill_jobs_by_workflow_total{workflow,status}`, `mill_triggered_total{trigger}`, `mill_reconcile_total{result}`, `mill_ingress_total{outcome}`, retries, auth-failures), histograms (`mill_job_duration_seconds`, `mill_job_wait_seconds`), and gauges (workers, queue depth + oldest-wait, reconcile synced/healthy/age). See **[OBSERVABILITY.md](OBSERVABILITY.md)**. |
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

**Sync policy.** `MILL_AUTOSYNC` (default `true`) gates auto-apply: when `false`, the
reconciler still *fetches + validates* new revisions but **holds** them (`OutOfSync`, with
"validated but held") until a manual **Sync** — `POST /api/reconcile` always applies (force).
A **prune allow-empty guard** never lets a suddenly-empty tree (broken clone / bad revision)
deregister every trigger. `selfHeal` is inherent — running state is derived from the git
checkout, so there's no out-of-band drift to correct. (v1 is single-repo, so autoSync is a
workspace-level gate; per-project sync policy in `project.yaml` is declarative for the coming
multi-repo model.)

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
