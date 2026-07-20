# Mill — Delivery Roadmap

Phased so the **riskiest thing (the compiler + isolated execution) is proven first**,
before we invest in UI. Each milestone ends in something runnable. Week ranges are
rough and assume a small team.

---

## M0 — Foundations (wk 1–2)
**Goal:** an empty but real, deployable skeleton.
- Bun workspaces monorepo per the layout in ARCHITECTURE §10.
- `packages/core`: domain types + **project/workflow YAML schema** (Zod) + validation.
- `packages/projectfs`: read/write/watch project files + build the in-memory index.
- `examples/billing`: a sample project (YAML + `.js`) used by tests.
- CI: typecheck, lint, test, build on every push.
- **Exit:** `bun install && bun run build` green; `projectfs` loads `examples/billing` and validates it.

## M1 — Compiler + Executor (wk 2–4)  ← de-risks the whole product
**Goal:** a project on disk runs end-to-end from a CLI, isolated.
- `packages/compiler`: workflow YAML + typed nodes → one standalone **main JS program**
  via `bun build`. The five node kinds map directly: **start** → the entry function
  (receives the run input), **jscode** → an imported `.js` module, **if** → a literal
  **multi-conditional** `if/else`, **callScript** → an invocation of another script
  (in-repo import or a fetched remote bundle), **end** → a `return`. **loop** (added) → a
  forEach that runs a body (per-item `jscode` file or per-item `callScript`) once per array
  element, sequentially, collecting results — the graph stays a DAG.
- `packages/executor`: `Executor` interface + **`NsjailProcessExecutor`** (Bun subprocess
  wrapped in **nsjail** — userns/seccomp/cgroups, memory/wall-clock caps, killable), **ON by default**.
  (In-process isolates are impossible on Bun — isolation is OS-level from day one.)
- `packages/telemetry`: pino + OTel bootstrap (logs/metrics/traces).
- CLI: `mill run ./examples/billing/workflows/invoices --input '{...}'` → per-node output.
- **Exit:** the 3-node example runs isolated with limits enforced; logs/traces emitted.

## M2 — Controller + Queue + Worker (wk 4–6)
**Goal:** trigger a job over HTTP, a worker runs it, status streams back.
- `apps/api` (controller): Hono; read/index project files; workflow CRUD (writes YAML+`.js`);
  job trigger endpoint; WS live-log relay; worker-registry view.
- `packages/queue`: BullMQ producer/consumer + worker registry/heartbeats in Redis.
- `apps/worker`: pull → execute bundle-in-payload → stream status/logs to Redis → emit telemetry.
- **Retries/durability** — **DONE**: node-boundary journaling (a requeued job resumes,
  skipping completed nodes) + two tiers — per-node backoff+jitter (`retry:` policy) **and** a
  run-level retry surviving worker death (reaper requeue). (No CRIU checkpointing in v1.)
- Triggers: **manual** + **webhook**.
- **Exit:** `POST /trigger` → live status + logs over WS; result + `recent:{workflow}` in Redis; logs land in Loki; kill a worker mid-job ⇒ job requeues.

## M3 — GitOps reconciliation (wk 6–8)  ← the "keep running state == git" pillar
**Goal:** git is the source of truth; a reconciler drives running state toward it.
- `packages/gitops`: `git` CLI wrapper (clone/fetch/checkout/commit/push) + reconcile loop.
- **Level-triggered + idempotent:** reconcile = pure function of observed-vs-desired;
  diff-and-apply (never blind re-create). **Fetch/apply split** (Flux): compile a
  revision into an immutable SHA-keyed artifact, then reconcile toward it.
- **Desired vs live:** fetch target revision → validate (Zod) + compile all workflows →
  reconcile triggers (cron/webhook/event) + swap active-version map (pointer swap).
- **Status:** two axes — Synced/OutOfSync + Healthy/Progressing/Degraded — with
  worst-of-children rollup to the project, in Redis.
- **Bad-commit safety:** invalid revision ⇒ keep last-known-good running, surface the error.
- **Delivery:** dedup'd work queue keyed by project (webhook+poll coalesce; failures
  backoff, not hot-loop); **poll (~3 min + jitter) is authoritative**, webhook best-effort.
- **Policy:** `autoSync`/`selfHeal`; **`prune` opt-in with an allow-empty guard** (an
  empty repo can't wipe all triggers).
- **Exit:** push a commit changing a node ⇒ next run uses new code; push a broken commit ⇒ project goes Degraded but keeps running the old good version.

## M4 — Web UI (wk 8–11)
**Goal:** build and run a workflow in the browser, backed by git.
- Workspace/project/workflow browser with **sync/health badges** (from M3).
- **Graph editor** (@xyflow): a **palette of the five typed components** (drag onto the
  canvas or click to drop; nodes never overlap), edges wired between handles, a
  **multi-conditional `if` builder**, and per-`jscode` **Monaco** with **JS validation +
  `ctx`-aware autocompletion** and **Save & Apply**. `callScript` targets an in-project or
  standalone/remote script. Input/output schema per node.
- **Save = commit** to the repo (draft → commit; branch/PR optional). **DONE**: the editor
  serializes the live graph → `workflow.yaml` + node `.js`, `POST`s it to the controller
  which validates (Zod, rejects a broken graph with a 400) then commits + pushes + reconciles.
- **Delete = commit**: remove a workflow (Project page) or a whole project (Projects page)
  from the trash icon → the controller commits + pushes the removal to the tracked branch,
  then reconciles. Guarded to a git-backed workspace.
- **Run panel**: trigger, live per-node status, streaming logs, failure inspection, retry.
- **Live read-only feeds** — **DONE**: Run history (`/…/runs` + per-node timeline), the
  reconcile activity feed (`/reconcile-events`), and the Sync diff (`/…/diff`) all render real
  controller/Redis data. **New Project** creates a real project (`POST /api/projects`).
- **Node input/output schemas enforced** at the boundary (JS predicates), a per-node **`retry`**
  policy, an editable **Dependencies** panel, and a **Test this step** runner — all live.
- **Fleet page runs on real data** (`/api/fleet`): live workers (memory, executor tier,
  heartbeat age, jobs running now), fleet-wide throughput/p50/p95/success/wait from a
  rolling completion window, and the pending-queue breakdown.
- **No demo data in the live build** — **DONE**: the frontend mock catalogue (seeded
  Billing/Growth projects, sample fleet workers/queue/stats, the "Acme" workspace) exists
  **only** for the standalone `/prototype` build. In the live build (`VITE_MILL_MODE=live`)
  every page renders controller data or an explicit **connecting / empty** state — the mock
  module is dead-code-eliminated out of the live bundle, so no fabricated project or worker
  can ever appear in a deployment.
- **Exit:** a non-author builds a 3-node workflow, hits Save (⇒ a commit), and watches it run with live logs.

### Deferred UI (mockups pulled from the live build — build as real features later)
These were only ever hand-authored fixtures in the prototype and are **not** shipped live:
- **Seeded demo/sample projects** — an optional, clearly-labelled "load sample project"
  action that actually commits a real example project to the workspace repo (vs. faking it
  in the browser). Until then, a fresh workspace shows the empty state.
- **Workspace switcher / multi-workspace** — the named-tenant switcher in the top bar is
  prototype-only; live shows a neutral "Workspace" until multi-repo/app-of-apps lands.
- **Historical fleet analytics** — the mock throughput sparkline/percentiles beyond the
  live rolling window; a durable metrics-backed history view (Prometheus/Tempo) later.

## M5 — Export (wk 12–13)
**Goal:** download a project as a standalone, runnable bundle.
- Tar the project (YAML + `.js`) + compiler-generated `index.js` + `package.json` +
  `bun.lockb` + `run.sh` + README (§7); streamed as a `.tar.gz` download (no S3).
- Browser-target variant.
- **Exit:** exported bundle runs on a clean machine with `bun install && bun run index.js` and matches in-Mill output.

## M6 — Deploy on EKS (wk 13–15)
**Goal:** production-shaped deployment with autoscaling — ~4 containers, one namespace.
- Dockerfiles (api, worker, web); k8s manifests: **controller Deployment (1 replica)
  with a PVC** for the git working copy, **worker Deployment (N)**, **redis**, web/Ingress.
- **HPA on memory/CPU** (no KEDA) + the **Cluster Autoscaler** for nodes. Workers scale on resource
  pressure; each worker runs a **dynamic `min`/`max` concurrency band** (ARCHITECTURE §3.5)
  that pauses pulling when its accepted jobs turn heavy.
- Wire logs/metrics/traces into the existing **Alloy → Loki/Prometheus/Tempo** stack.
- **GitHub auth** (token/deploy key stored as a **k8s Secret**) + webhook wired to the
  reconciler. **v1 = a single repo, folder per project** (multi-repo soon after).
- **User auth = SSO terminated at the Ingress** (flat access, no roles); **internal comms
  via key pair** (controller signs bundles/jobs, workers verify). UI Save **writes directly
  to GitHub** (PR/approval flows later).
- Runs in a **single namespace of an existing cluster** — Mill owns Deployments + HPA;
  the **cluster's own Cluster Autoscaler** handles nodes.
- Secrets via k8s (external-secrets optional); **cron triggers** + orphan-job recovery.
- **Exit:** load-test a backlog ⇒ workers scale on **memory/CPU pressure (HPA)**, back down when idle; runs visible in Grafana.

> Upgrade path (only if/when needed): files→Postgres index, tar→S3, single-controller→HA.
> Each is behind an interface, so none blocks v1.

## M7 — Hardening toward untrusted (later)
**Goal:** safely run code Mill doesn't trust.
- **`GvisorExecutor`** (semi-trusted) then **`FirecrackerExecutor`** via firecracker-containerd
  (untrusted) behind the same `Executor` seam. Optional **`K8sJobExecutor`** (pod-per-run,
  gVisor/Kata RuntimeClass) as an opt-in per-workflow choice — never the default hot path.
- Per-tenant quotas + rate limits; secrets vault; RBAC; egress controls.
- Epoch/fencing tokens on retries (exactly-once, no zombie-attempt split-brain).
- **Exit:** untrusted workflow cannot exceed CPU/mem/network/time budget or reach another tenant.

---

## Risk register
| Risk | Mitigation |
|------|-----------|
| Compiler is the hardest part | Built first (M1), proven via CLI before any UI |
| Bun ecosystem gaps | Hono/BullMQ verified on Bun; `Executor` seam allows Node/Deno fallback per-job |
| Untrusted-code isolation | `Executor` interface designed in M1 so microVM is a swap, not a rewrite |
| Memory-heavy jobs OOM pods | Per-job memory caps kill the child, not the pod; HPA as safety net |
| Live logs at scale | Redis pub/sub for the live tail; durable history in Loki |
| File store scaling (many workflows) | In-memory index is a rebuildable cache; promote to a Postgres index later if needed |
| Reconcile races / partial applies | Validate+compile the whole revision *before* applying; atomic active-version swap; last-known-good on failure |
| UI-edit vs git drift | All writes go through git commits — no out-of-band live writes, so no drift by construction |

## Decisions locked
- **License: MIT.** All bundled deps are MIT/Apache/BSD-compatible; AGPL/SSPL/GPL pieces
  (Grafana/Loki, Redis-server, git CLI, nsjail) are separate services or invoked
  subprocesses — no linking, no contamination. See `DEPENDENCIES.md`.
- **Git is the source of truth**; UI edits are commits; a reconciler keeps running state == git (ArgoCD-style).
- **Auth (v1): user SSO terminated at the Ingress, flat access** (everyone the same, no
  roles). **Internal comms authenticated by key pair** (controller signs bundles/jobs;
  workers verify). OIDC + RBAC + **approval flows are later**. UI Save **writes directly to
  GitHub** — a **single repo, folder per project** for v1; **multi-repo soon after**. Git
  creds as k8s Secrets. Mill runs in a **single namespace of an existing cluster**; the
  cluster's Cluster Autoscaler handles nodes.
- **Project = a git repo**; controller keeps a working copy (PVC cache) + in-memory index.
- **No SQL DB**; live state in Redis; history in Loki/Prometheus/Tempo.
- **Control plane in TypeScript/Bun**: I/O-bound; keeps shared `core` + `bun build` +
  BullMQ. Go is a *future carve-out for the git reconciler only*, behind a queue seam,
  and only if Mill goes deep on k8s CRDs.
- **Isolation is OS-level and ON by default** (nsjail → gVisor → Firecracker):
  in-process isolates impossible on Bun; never vm2/`node:vm`.
- **Git access = shell out to `git` CLI** (`es-git` optional hot path).
- **Execution model: warm worker pool** (nsjail'd subprocess, ~ms) is the default;
  **`K8sJobExecutor` pod-per-run is opt-in** behind the `Executor` seam for heavy/untrusted jobs.
- **K8s strategy: reuse primitives, not the engine** — Deployments (API/UI/workers),
  Ingress (UI + webhooks + TLS), HPA + Cluster Autoscaler (no KEDA), native secrets/RBAC. **Run state
  never in etcd/CRDs.** Did *not* adopt Argo Workflows as the engine (latency + etcd + export).
- **Scheduling: app-level cron** (BullMQ repeatable jobs) by default; native **CronJob**
  backend selectable behind the trigger interface.

## Open questions to revisit

### Must resolve before/at M0–M1 (shape the schema + compiler)
- **Repo registry (chicken-and-egg):** where does Mill's list of projects/repos +
  their branch/policy/credentials live? *Recommendation:* a **root config repo**
  (app-of-apps); credentials as **k8s Secrets referenced by name**, never in git.
  Keeps "no DB" true. — decide before M0.
- **DAG fan-in signature:** how does a node with multiple parents receive inputs?
  *Recommendation:* `input` = single upstream output (linear case) + **`ctx.inputs[nodeKey]`**
  for multi-parent. Coupled to the edge-model decision. — decide in M0 (`core` schema).
- **Edge model depth:** ~~Argo-style `depends` status expressions, or plain predecessor
  edges~~ — **Resolved:** plain edges carry `output → input`; **branching is a
  first-class multi-conditional `if` node** (compiles to a literal `if/else`), not edge
  conditions. **Iteration is a first-class `loop` node** (forEach over an array; body is a
  per-item `jscode` file or `callScript`; sequential, DAG preserved). Sub-workflow calls are
  a **`callScript` node** (in-project; standalone/remote deferred).
- **`ctx` / SDK surface:** `ctx.log`, `ctx.secrets`, `ctx.inputs`, and what else
  (`ctx.state`? `ctx.http`?). First cut needed for M1.
- **Typed workflow `inputs`** (Kestra borrow): add validated `inputs:` to `workflow.yaml`? — M0 schema.

### Must resolve by M2–M3 (execution + triggers)
- **Bundle distribution:** *Recommendation:* content-addressed — payload carries a
  **bundle hash + input**; workers fetch by hash (controller/shared PVC) and cache
  locally. Avoids MB-per-run in Redis. — decide in M2.
- **Secrets at runtime:** store (k8s Secrets vs external vault), reference (`secrets: [NAME]`
  in YAML), and injection into the isolated process without leaking to logs. — before M3 webhooks.
- **Cron concurrency policy:** per-workflow **`concurrencyPolicy: Allow|Forbid|Replace`**
  (borrow k8s CronJob; default `Allow`). — M3.
- **Commit target for UI saves:** ~~direct-to-branch vs branch+PR~~ — **Resolved: direct
  writes to GitHub (the tracked branch) in v1; branch/PR + approval flows later.**

### Plan-for, don't-block (design the seam now)
- **Controller HA:** 1 replica for v1, but note a **leader-election** path + a
  **git-working-copy lock** (UI commit vs reconciler pull must not corrupt the tree). — later.
- **AuthN/AuthZ depth:** ~~sessions + API keys~~ — **Resolved: user SSO at the Ingress +
  flat access (no roles) in v1; internal comms by key pair; OIDC + RBAC later.**
- **App-of-apps granularity:** ~~one repo per project vs one workspace repo with folders~~
  — **Resolved: single repo, folder per project for v1; multi-repo soon after.**
- Secrets model (per-workspace vault vs k8s external secrets) — **partly shipped**: a UI-managed
  **runtime secret store** (Redis, AES-256-GCM at rest via `MILL_SECRETS_KEY`, write-only in the
  UI, injected into `ctx.secrets` per job) plus k8s Secrets / `MILL_SECRETS`. **Deferred:**
  per-project secret scoping (today the store is workspace-global) and an external-vault backend.
- Header-less webhook auth — **shipped**: **capability URLs** (an unguessable webhook `path` ≥24
  chars authenticates by itself, no bearer) so providers like Acuity/Twilio that can't send an
  `Authorization` header can deliver. **Deferred:** per-provider HMAC verification helpers.
- ~~AuthN/AuthZ depth for v1~~ — resolved: SSO at Ingress + flat access; internal key-pair comms; OIDC/RBAC later.
- Large node outputs: kept small / in Redis TTL for v1 (Windmill offloads >2 MB) — add an object store only if needed.
- ~~App-of-apps granularity~~ — resolved: single repo + folder-per-project for v1; multi-repo capability soon after.
