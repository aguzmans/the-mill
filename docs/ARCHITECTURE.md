# Mill — Architecture

> A self-hostable workflow-automation platform. Replaces Windmill / n8n with a
> simpler, GitOps-native model: **a project is a git repo of YAML + `.js`, git is
> the source of truth, and a reconciler continuously drives running state toward
> git — the way ArgoCD drives a cluster toward its manifests.** You build workflows
> visually as a graph of code nodes; the same definition renders in the UI, runs on
> a worker, and exports as a standalone JS program.

---

## 1. Product model

```
Workspace  (tenant / org boundary)
  └── Project        (a git repo — the source of truth)
        └── Workflow (a "workload" — a flow graph that compiles to one JS program)
              └── Node   (one of five typed components: start · jscode · if · callScript · end)
```

- A **Workflow is a real program drawn as a flow graph** that compiles to a single main
  JS file. Nodes come in **five kinds** (more — loops etc. — later):
  - **start** — the program entry point; the run's input arrives here.
  - **jscode** — a step backed by its own `.js` file, loaded by the main program:
    `async (input, ctx) => output`, plus declared deps. `ctx` is the Mill SDK (logging,
    secrets, IO helpers).
  - **if** — a **literal `if`** in the main file; **multi-conditional** (`x && y || z`),
    routing the flow down a `true` or `false` branch.
  - **callScript** — invokes **another script as a step**; the target may be another
    workflow **in this project** or a **standalone/remote** script referenced by version.
  - **end** — the exit clause; the program returns when no more work remains.
- **Edges carry one node's output to the next; branching is expressed by `if` nodes**,
  not by conditions on edges. **Iteration is a `loop` node** — a forEach that runs a body
  (a per-item `jscode` file or a per-item `callScript`) once per array element, sequentially,
  collecting results. The graph stays a DAG (the loop repeats its body internally).
- A **Project** is a **git repo**. Git is the source of truth; the UI renders from
  it, and a **reconciler** keeps running state in sync with it (§5).

### Three theses that shape everything

1. **A workflow compiles to one valid JS program.** The generated entrypoint
   topologically walks the DAG. That same artifact is what we (a) run in the editor,
   (b) ship to a worker, (c) export standalone. Editor engine = server engine =
   export format — **one** compiler, the biggest thing to de-risk.

2. **Definitions are files in git, not database rows.** The repo is the source of
   truth *and* the export, simultaneously. There is **no SQL database** (see §4).

3. **GitOps: running state is reconciled toward git.** Like ArgoCD, a control loop
   compares desired state (git) with live state (registered triggers + active
   versions) and drives them together, with sync/health status and auto-sync (§5).

---

## 2. High-level topology

One namespace, ~4 Mill containers, reusing your existing Grafana stack. The
**controller** owns the git working copy and the reconcile loop; **workers are
stateless**. Mill runs in a **single namespace of an existing shared cluster** — every
manifest is namespace-scoped and we assume no cluster-admin; **node autoscaling is the
cluster's own concern** (its Cluster Autoscaler), so Mill only owns its Deployments + HPA.

```
   git remote (GitHub/GitLab)  ──webhook──┐        Browser
     desired state (YAML+JS)              │           │ REST + WS (renders from git)
            ▲  commit on UI "Save"        ▼           ▼
            │                    ┌────────────────────────────────┐
            └───── push ─────────│  Controller (API)  · 1 replica  │  Bun + Hono
                    fetch/poll   │  ┌──────────────────────────┐  │
                                 │  │ git working copy + index │  │  desired state
                                 │  ├──────────────────────────┤  │
                                 │  │ Reconciler (sync loop):  │  │  git → running
                                 │  │  compile · triggers ·    │  │
                                 │  │  sync/health status      │  │
                                 │  └──────────────────────────┘  │
                                 │  CRUD · compile · export · WS   │
                                 └───────┬─────────────────┬───────┘
                        enqueue jobs     │                 │ emit logs/metrics/traces
                    (bundle in payload)  │                 ▼
                                 ┌───────▼──────┐   ┌─────────────┐   ┌───────────────┐
                                 │    Redis     │   │   Alloy     │──▶│ Loki / Prom /  │
                                 │ queue · reg. │   │ (collector) │   │ Tempo · Grafana│
                                 │ sync state   │   └─────────────┘   └───────────────┘
                                 │ (ephemeral)  │          ▲
                                 └───────┬──────┘          │ logs/metrics/traces
                                pull jobs / stream  ┌──────┴────────┐
                                status back         │  Worker fleet │  Bun · N replicas
                                         └─────────▶│  (stateless)  │  isolated child/job
                                                    │  ┌──────────┐ │  (process → microVM)
                                                    │  │ Executor │ │
                                                    │  └──────────┘ │
                                                    └───────────────┘
                          scaled by HPA on memory/CPU (no KEDA) · Cluster Autoscaler for nodes
```

---

## 3. Components

### 3.1 Web UI (`apps/web`)
- **React + Vite**, **@xyflow/react** for the node graph, **Monaco** for node code,
  **TanStack Query**, **Tailwind**.
- **Build by drag-and-drop:** a **component palette** of the five node kinds — drag onto
  the canvas or click to drop (new nodes are nudged so they never render on top of one
  another) — and wire edges by dragging between handles. `if` nodes get a
  **multi-conditional builder**; `jscode` nodes open a **Monaco** editor with **JS
  validation + `ctx`-aware autocompletion** and a **Save & Apply** button.
- **Renders from git**: the graph is drawn from `workflow.yaml` (typed nodes/edges/triggers)
  + node `.js` at the current revision. Shows per-project **sync status**
  (Synced/OutOfSync) and **health** (Healthy/Progressing/Degraded) badges (§5).
- Editing uses an in-memory **draft**; **Save = commit** back to the repo (**direct to
  the branch in v1**; branch/PR + approval flows later). "Run" triggers a job. Live
  status/logs stream over WS; deep history is queried from **Loki/Grafana**.

### 3.2 Controller / API (`apps/api`)
- **Bun + Hono**. REST + WS. Owns the **git working copy**, the **in-memory index**,
  and the **reconcile loop**. Run **one replica** for v1 (single writer / singleton
  reconciler); throughput is trivial — the workers scale.
- Responsibilities: **auth** — user identity via **SSO terminated at the Ingress**, with
  **flat access in v1** (everyone the same; roles later); git clone/fetch/checkout/commit/push;
  index the working tree for listing/search; **reconcile** git → running state (§5);
  **compile** a workflow to a bundle; **enqueue jobs** (bundle in payload); **relay**
  live status/logs from Redis to the UI; generate **exports**; own the worker registry.
- **Internal trust is by key pair, not user identity:** the controller **signs** each
  compiled bundle / job payload with a private key and workers **verify** with the public
  key (a worker only runs artifacts the controller actually produced), alongside
  authenticated Redis. This is separate from user SSO and needs no roles for v1.
- Holds no historical records — past runs, logs, metrics go to the monitoring stack.

### 3.3 Definitions — a git repo (no database)
- Each project is a git repo; git provides history, diff, blame, rollback, branches,
  and PR review for free. Layout:
  ```
  billing/                       # a project = a git repo
    project.yaml                 # metadata + sync policy (auto-sync, self-heal)
    workflows/
      invoices/
        workflow.yaml            # DAG: nodes + edges + triggers, references .js files
        nodes/{fetch,transform,load}.js
    package.json                 # union of node deps → `bun install`
  ```
- **Code stays as real `.js`** (not YAML strings) so Monaco, linting, git diffs, and
  `bun build` work directly. YAML holds only the graph/config.
- The controller keeps a **git working copy** (on a PVC, just a cache) and an
  **in-memory index** (rebuildable) for fast UI listing/search.
- Git access = the **`git` CLI** shelled out from the controller; auth via an SSH
  deploy key or a provider token. (See §4 for why files beat a DB here.)

### 3.4 Redis — live state only (ephemeral)
- **Job queue** (BullMQ): pull-based; workers self-select — placement is automatic.
- **Pub/sub**: live node status + log lines during a run, relayed to the UI (low
  latency; Loki is for durable/historical logs).
- **Worker registry + heartbeats**: register on startup with a TTL; expiry ⇒ dead
  worker ⇒ in-flight jobs requeue.
- **Reconcile/sync state**: per project `synced_revision`, `sync_status`, `health`,
  active version hashes, registered triggers — the reconciler's live view (all
  derivable from git, so Redis staying ephemeral is fine).
- **Recent results**: last-run output/status per workflow (TTL) for the UI.

### 3.5 Worker fleet (`apps/worker`)
- **Bun**, **stateless** — no files, no DB, no git. Loop: pull job → compiled bundle
  arrives in the payload → **execute isolated** → stream status/logs to Redis + emit
  telemetry → return result via the queue.
- Each job's isolated child has its own memory/time caps so one job can't take down
  the pod. Stateless ⇒ trivially scalable and isolatable.

**Dynamic per-worker concurrency.** A worker does **not** run a fixed number of jobs —
jobs vary wildly (a pool might carry 100 light jobs or only 1–2 heavy ones), so
concurrency is a **configured `min`/`max` band** that the worker fills *dynamically*
from live load:
- **`min`** — the worker always accepts at least this many; guarantees forward progress,
  so it never deadlocks under pressure.
- **`max`** — a hard ceiling on simultaneous jobs (caps blast radius, fd/proc counts).
- **Between `min` and `max`**, admission is governed by two gates working together:
  1. **Admission accounting (predictive).** Each job declares a memory budget
     (`limits.memMB`); on admission the worker *reserves* it and won't pull a job that
     wouldn't fit its remaining budget (down to keeping `min`). So concurrency sizes
     itself to job weight — many light jobs **or** a few heavy ones, automatically.
  2. **Live resource feedback (reactive).** The worker samples its own real memory/CPU
     (cgroup usage + loadavg). If usage crosses `pauseAbove` (e.g. 85%) it **stops
     pulling new jobs — even mid-run, even below `max`** — because jobs it already
     accepted grew heavier over time. It **resumes** when usage falls below
     `resumeBelow` (hysteresis avoids flapping).
- **In-flight jobs are never killed for load** — only for breaching their own hard cap.
  Pausing affects only *new* pulls; the backlog waits safely in Redis.
- The worker heartbeats its live band + usage (`inFlight`, `min`, `max`, `mem`,
  `paused`, plus `executor` tier and the set of jobs running right now) to the registry
  for the Fleet view and the scaling signal below. Each terminal job also appends a compact
  record (workflow, ok, duration, wait) to a capped rolling window, from which the
  controller computes fleet-wide throughput, p50/p95 duration, success rate, and
  schedule→start wait (`GET /api/fleet`). No metrics backend is required for the local
  stack; Prometheus is the production swap behind the same shape.

**Fleet scaling: HPA on memory/CPU (no KEDA).** The number of worker pods is scaled by
the Kubernetes **HPA on memory** (and/or CPU) plus the **Cluster Autoscaler** for nodes. We do **not**
use KEDA. Consequence — the scaling signal is **resource pressure, not queue depth**:
when workers fill and pause (above), fleet memory stays high and HPA adds pods; as load
drains, HPA removes them. Trade-off we accept: no native queue-depth trigger and no
scale-to-zero (HPA holds `minReplicas ≥ 1`). This pairs cleanly with dynamic per-worker
concurrency — self-limiting workers surface real memory pressure, which is exactly what
HPA scales on.

### 3.6 Observability — your existing Grafana stack (no Mill storage)
- **Logs** → structured JSON to stdout (pino) → **Alloy** → **Loki**, labeled
  `project`, `workflow`, `job_id`, `node`, `status`, `worker`, `revision`. UI tails
  live via Redis pub/sub; history via LogQL.
- **Metrics** → controller & workers expose `/metrics`; **Prometheus** scrapes
  (queue depth, job/sync rates, durations, worker count, per-job mem/cpu).
- **Traces** → OpenTelemetry → **Tempo**. A job is a trace; each node is a span.
- Mill stores no run history itself — "everything historical is logged."

### 3.7 Export (part of the controller)
- Definitions are already files, so export = the repo tree + a compiler-generated
  `index.js` entrypoint + `package.json` + `bun.lockb` + `run.sh` + README, **tarred
  and streamed back as a `.tar.gz`** (no object store). A **browser-target** variant
  is emitted for nodes free of server-only APIs. Production runs the *same* compiled
  program, so "works exported" == "works in Mill."

---

## 4. Why no database (the specific reasoning)

A relational DB for *definitions* would buy exactly four things; none survive here:

| What a DB gives | Verdict for Mill |
|---|---|
| **Cross-cutting queries** (list/search workflows) | Replaced by the controller's **in-memory index**, rebuilt from the working tree. Thousands index in ms. |
| **Concurrent-write transactions** | Not needed: single controller; writes are **git commits** with optimistic revision checks. |
| **Referential integrity** (FKs) | The **compiler** validates the DAG (every edge → a real node) — stronger than FKs. |
| **Version history** | **Git does it better**: diff, blame, rollback, branch, PRs — which is also the GitOps substrate. |

A DB would also fight the product: with files, **the repo *is* the export and the
GitOps desired state**. The only thing wanting durable structured storage is **live
operational state** → **Redis** (ephemeral). History → monitoring stack. Net: zero
SQL databases, fewer containers, no migrations.

> A DB may return only for multi-tenant SaaS with thousands of concurrent editors or
> heavy cross-tenant RBAC/audit queries — index files into Postgres *then* without
> changing the source of truth. YAGNI now.

---

## 5. GitOps reconciliation (ArgoCD-style)

The heart of "keep what's running in sync with git." A **reconcile loop** in the
controller continuously drives **live state** toward **desired state**.

- **Desired state** = the project repo at a target revision (tracked branch, or a
  pinned tag/commit).
- **Live state** = registered triggers (cron entries, webhook routes, event subs) +
  the **active compiled version** per workflow. Almost entirely *derived* from git,
  so self-heal is nearly free — there's no separate mutable config to drift.

### Engine principles (from ArgoCD / Flux / controller-runtime)
- **Level-triggered, not edge-triggered.** Reconcile is a pure function of *observed
  vs. desired* — never a reaction to the specific event that woke it. Any wake-up
  (webhook *or* poll) re-derives the full delta from scratch, so a missed webhook,
  restart, or dropped poll is self-correcting.
- **Idempotent + diff-and-apply.** N calls on the same revision converge to the same
  running state as one. Register missing triggers, deregister removed ones, activate
  the target version — never blindly re-create.
- **Fetch/apply split (Flux's model).** Phase A fetches + validates + compiles a
  revision into an **immutable artifact keyed by git SHA**; phase B reconciles running
  state toward it. This is what makes activation a pointer-swap, rollback a re-point,
  and "last-known-good on a bad commit" clean.

### The loop
1. **Enqueue a reconcile** (keyed by project) on a git-provider **webhook** (instant)
   or a periodic **poll** (~3 min + **jitter**, the *authoritative* backstop). A
   webhook + poll landing together **coalesce into one run** via a dedup'd work queue;
   failures **requeue with exponential backoff** rather than hot-looping a bad commit.
2. **Fetch** the target revision; **validate** every `workflow.yaml` (Zod) and
   **compile** every workflow into the SHA-keyed artifact.
3. **If all valid:** atomically swap the active-version map and **reconcile triggers**
   to exactly match git. Mark `Synced` / `Healthy`, record `synced_revision`.
4. **If anything invalid:** mark `OutOfSync` / `Degraded` and **keep the last-known-good
   version running** — a bad commit never takes down what already works. Surface the
   error in the UI and logs.

### Status model (borrowed from ArgoCD)
- **Two orthogonal axes.** *Sync:* `Synced` (applied == git) · `OutOfSync` (git ahead).
  *Health:* `Healthy` · `Progressing` (sync in flight) · `Degraded` (invalid YAML,
  compile error, or a trigger failing to fire). A workflow can be Synced-but-Degraded.
- **Worst-of-children rollup:** project health = the worst of its workflows/triggers,
  so one Degraded workflow surfaces at the project level.
- **Policy per project** (in `project.yaml`): `autoSync` (apply automatically vs a
  manual "Sync" click); `selfHeal` (trivially satisfied — live is derived from git);
  and **`prune` is opt-in, guarded by an allow-empty check** so an accidentally-empty
  repo can't wipe every running trigger.

### Semantics that matter
- **In-flight jobs are never killed** by a reconcile; they finish on their pinned
  version. Only *future* dispatch uses the new revision (like ArgoCD not disrupting
  running pods needlessly).
- **UI writes go through git**: edits accumulate in an in-memory draft; **Save
  commits** to the repo (**direct to the tracked branch in v1**; branch/PR + approval
  flows later). There is no out-of-band live write, so "what you see == what runs ==
  what's in git."
- **Repos & projects:** **v1 = a single GitHub repo with a folder per project** (each
  project's config lives inside its folder); a **multi-repo** workspace (binding several
  repos) ships **soon after v1**. Either way each project reconciles independently.
  GitHub credentials live as **k8s Secrets**, never in git.

---

## 6. Isolation strategy (OS-level from day one)

Start internal-trusted, grow to untrusted. One seam now so the upgrade is a swap:

```ts
interface Executor {
  execute(bundle: Bundle, input: Json, limits: Limits): Promise<ExecResult>
  //  Limits = { memMB, cpuMs, wallMs, network, env }
  //  ExecResult = { output, nodeRuns, status }   // logs/metrics emitted, not returned
}
```

**Key constraint (research-confirmed): in-process isolation is impossible on Bun.**
`isolated-vm` links V8's Isolate C++ API; Bun is JavaScriptCore and has no V8 isolate
to hand out — it cannot be made to work. `node:vm` is explicitly "not a security
mechanism"; `vm2` is abandoned with repeated CVSS-9.8 escapes. So isolation must be
**OS-level from the start**, and it is **ON by default** (inverting Windmill's opt-in
foot-gun). The ladder:

- **Phase 1 — `NsjailProcessExecutor` (now):** each job in a separate **Bun
  subprocess wrapped in nsjail** (user namespace + seccomp-bpf + cgroups), killable,
  with wall-clock + memory caps and a scrubbed env. ~ms overhead, near-native. **This
  is exactly what Windmill ships** for hardened workers — we make it the default.
- **Phase 2 — `GvisorExecutor` (semi-trusted):** runsc intercepts syscalls in a
  user-space kernel — near-VM isolation at container density and sub-VM latency.
- **Phase 3 — `FirecrackerExecutor` (untrusted):** microVM via firecracker-containerd
  — ~125 ms boot, <5 MiB/VM, hardware (KVM) boundary. The hardest multi-tenant tier.
- **Opt-in — `K8sJobExecutor`:** run a single run as a k8s **Job/pod** (optionally with
  a gVisor/Kata **RuntimeClass**) behind the same seam, for heavy/long/strongly-isolated
  jobs. **Not the default** — pod cold start is seconds; it's a per-workflow choice.

> Default execution is the **warm worker pool** (below): long-running workers run nodes
> in nsjail'd subprocesses in ~ms. In-process isolates are impossible on Bun; pod-per-run
> is available but opt-in, never the hot path. The compiler emits pure per-node
> functions, so swapping rungs is a drop-in.

See `LANDSCAPE.md` §Isolation for the full ladder table (cold-start / density /
security / maturity) and citations.

---

## 7. On-disk project format (the "data model")

No tables — the schema is the file format, validated by Zod in `packages/core`:

```yaml
# project.yaml
apiVersion: mill/v1
kind: Project
metadata: { name: billing }
sync: { autoSync: true, selfHeal: true }      # GitOps policy

# workflows/invoices/workflow.yaml
apiVersion: mill/v1
kind: Workflow
metadata: { name: invoices }
triggers:
  - { type: cron,    schedule: "0 2 * * *" }
  - { type: webhook, path: /hooks/invoices }
  - { type: manual }
nodes:
  - { key: start,     kind: start }
  - { key: fetch,     kind: jscode, file: nodes/fetch.js, deps: { "node-fetch": "^3" } }
  - { key: gate,      kind: if, conditions: [ { expr: "invoices.length > 0" },
                                              { connector: or, expr: "input.force === true" } ] }
  - { key: transform, kind: jscode, file: nodes/transform.js }
  - { key: load,      kind: jscode, file: nodes/load.js }
  - { key: notify,    kind: callScript, call: { ref: "std://acme/notify-slack@v2", standalone: true } }
  - { key: end,       kind: end }
edges:
  - { from: start,     to: fetch }
  - { from: fetch,     to: gate }
  - { from: gate,      to: transform, branch: true }   # then-branch
  - { from: gate,      to: end,       branch: false }  # else-branch
  - { from: transform, to: load }
  - { from: load,      to: notify }
  - { from: notify,    to: end }
```

```js
// workflows/invoices/nodes/fetch.js
export default async function fetch(input, ctx) {
  ctx.log.info("fetching", { url: input.url })
  const res = await globalThis.fetch(input.url)
  return await res.json()               // becomes the input of `transform`
}
```

**Live state (Redis, ephemeral):** `queue`, `job:{id}`, `worker:{id}`,
`sync:{project}` (revision/status/health/triggers), `recent:{workflow}` (TTL).
**Historical state (monitoring):** everything else, as logs/metrics/traces.

---

## 8. Job lifecycle

1. **Trigger** (manual / cron / webhook / event) fires against the **active
   reconciled version** → controller compiles (cache by content hash) → enqueues a
   job in Redis with the bundle + input.
2. **Worker** pulls → marks `running` → `Executor.execute(...)`.
3. Each node emits status + logs to Redis pub/sub (relayed to the UI → live progress,
   per-node status, streaming logs, failures) *and* structured logs/metrics/traces to
   Alloy → Loki/Prometheus/Tempo.
4. Worker returns the result via the queue; controller updates `job:{id}` and
   `recent:{workflow}` (TTL). No DB record — the durable trail is in the monitoring stack.
5. Node failure → policy-driven **retry with backoff**; terminal failure marks the job
   `failed` with the error + offending node (logged with labels).
6. Worker dies mid-job → heartbeat TTL expires → job requeues.

---

## 9. Scaling & Kubernetes strategy (EKS)

**Reuse K8s for the infrastructure layer; keep orchestration app-level for the hot
path.** Being "Argo-like" is good for infra and coarse concerns, but modeling every
run/node as a native object is not: pod-per-node adds *seconds* of cold start (vs ~ms
warm), and per-run state as CRDs bloats **etcd** (Argo hit the ~1.5 MB object limit and
had to offload state to a DB) — the same failure mode as Windmill's Postgres, which we
designed away. So:

| Concern | Approach | Why |
|---|---|---|
| API · UI · **worker pool** | **Deployments** | Long-running — what Deployments are for |
| UI routing · **webhook ingestion** · TLS · **SSO** | **Ingress** (+ cert-manager); **SSO terminated here** | Reuse; don't build our own auth. Flat access in v1 |
| Worker autoscaling | **HPA on memory/CPU** (Mill-owned) + the cluster's **Cluster Autoscaler** for nodes (not Mill's). **No KEDA** — scale on *resource pressure*, not queue depth. Per-worker **dynamic `min`/`max` concurrency** (§3.5) absorbs job-weight variance. | Fewer moving parts; memory is the honest signal |
| Secrets · quotas · NetworkPolicy | **Native K8s** (program + GitHub-cred Secrets). **Flat access in v1 — no RBAC yet** | Reuse |
| **Scheduling (cron)** | **App-level** (BullMQ repeatable jobs) by default; native **CronJob** backend selectable behind the trigger interface | Fine-grained, no API-server pressure, works in local dev + export |
| **Per-node execution** | **Warm worker pool** (nsjail'd subprocess) | ms not seconds; in-process data-passing + live logs |
| **Run state / history** | **Redis (ephemeral) + Loki/Prom/Tempo** — *never etcd/CRDs* | Avoids the etcd-bloat trap |
| **Heavy / untrusted isolation** | opt-in **`K8sJobExecutor`** / gVisor / Kata RuntimeClass (§6) | Pod-level isolation *when chosen*, not as a default tax |

- **Pull-based queue = no placement brain.** Workers self-select; load balances. The
  controller tracks health/capacity (Redis registry), emits autoscaling signals,
  recovers orphaned jobs.
- **Per-job memory caps** kill a hungry job's child, not the pod.
- **New workers** register in Redis and start pulling immediately.

> We deliberately did **not** adopt Argo Workflows as the engine (pod-per-step latency,
> etcd state limits, and it breaks the standalone-JS export — an Argo CRD isn't
> `bun run`-able). We reuse k8s *primitives*, not its workflow-execution model.

---

## 10. Prior art & borrowed primitives

Concrete ideas adopted from the landscape survey (`LANDSCAPE.md`), with the source:

- **Branching → a first-class `if` node (not edge conditions).** Rather than adopting
  Argo-style `depends` status expressions on edges, Mill models a branch as a
  **multi-conditional `if` node** that compiles to a literal `if (…) { } else { }` in the
  main program, with `true`/`false` edges. Plain edges otherwise carry `output → input`.
- **Iteration → a first-class `loop` node.** A forEach that resolves an array (a JS
  `each` expression over the upstream output) and runs a body — a per-item `jscode` file
  or a per-item `callScript` — once per element, sequentially (`ctx.state` carries across
  iterations), collecting the results. The graph stays acyclic; the loop repeats internally.
- **Sub-workflows → a `callScript` node.** A step can invoke another script — a workflow
  in the **same project** or a **standalone/remote** script referenced by version (as
  Kestra composes subflows). Its output becomes the step's output.
- **Durability → node-boundary journaling + layered retries** (Inngest/Temporal +
  Dagster + Prefect). Each node is a natural step: journal its result so a retry
  **skips completed nodes**. Two retry tiers — **per-node** (backoff + jitter +
  condition) *and* a **run-level retry that survives the worker dying**. Add
  **heartbeats + a timeout taxonomy** (schedule-to-start / start-to-close / heartbeat)
  for fast crash detection on long nodes. **Defer** CRIU/microVM checkpoint-restore
  (Trigger.dev keeps it cloud-only — infra-heavy); journaled re-run is enough for v1.
- **Server never runs user code** (Temporal/Prefect/Dagster/Windmill): the controller
  compiles and enqueues; only isolated workers execute — already our model.
- **Secrets stored separately, never committed** (Node-RED/n8n/Windmill): git-sync
  skips secrets; the repo holds only refs. Decide the secrets backend before webhooks.
- **Beat the incumbents where they're weak:** Windmill's git-sync is a one-shot "Git
  always wins"; Kestra's "GitOps" is a *polled cron sync task*. Mill's **continuous
  reconciler** (level-triggered, self-healing, sync/health status) is the real
  differentiator — lean into it.
- **License:** pick an **unambiguous** open/commercial boundary up front. Fair-code
  (n8n), AGPL open-core (Windmill), SSPL (Inngest), and BSL (Restate) each created
  real adoption friction; clean Apache-2.0 (Argo/Prefect/Dagster) / MIT (Temporal)
  did not. *(Decision owner: you — flagged in ROADMAP open questions.)*

## 11. Tech decisions (summary)

| Concern            | Choice                              | Why |
|--------------------|-------------------------------------|-----|
| Runtime (workers)  | **Bun**                             | Fast; built-in bundler + package manager (ideal for export); native TS |
| Control plane lang | **TypeScript/Bun** (v1)             | Control plane is I/O-bound; keeps the shared `core` schema + `bun build` compiler in-process; keeps BullMQ (no Go client); Trigger.dev proves all-TS orchestration works |
| API framework      | **Hono** on Bun                     | Portable, mature, tiny |
| Definitions store  | **Git repo (YAML + `.js`)**         | Source of truth, export, and GitOps substrate in one; no DB/migrations |
| GitOps             | **Custom reconcile loop** + `git` CLI (shell out) | ArgoCD-style level-triggered sync; git CLI is the only option covering shallow+partial+sparse+SSH (isomorphic-git lacks SSH); `es-git` optional for the hot path |
| Live state         | **Redis** (BullMQ + pub/sub)        | Queue, registry, sync state, recent results — ephemeral |
| History / telemetry| **Loki / Prometheus / Tempo via Alloy** | "Everything historical is logged"; nothing stored in Mill |
| Exports            | **Tar the repo + generated entry**, streamed | Repo files *are* the export; no object store |
| Frontend           | React + Vite + **@xyflow/react** + Monaco + TanStack Query + Tailwind/shadcn | Strong graph + code editing; renders from git |
| Isolation (now)    | **Bun subprocess + nsjail** (userns/seccomp/cgroups), **ON by default** | OS-level (in-process isolates impossible on Bun); matches Windmill's hardened mode |
| Isolation (later)  | **gVisor → Firecracker** (firecracker-containerd) | Swap behind `Executor`; skip pod-per-job (seconds of cold start) |
| Future Go carve-out| **git reconciler**, behind a queue seam | *Only if* Mill goes deep on k8s CRDs — where go-git + controller-runtime + client-go genuinely beat TS |
| Autoscaling        | **HPA on memory/CPU + Cluster Autoscaler** (no KEDA) | Scales on worker resource pressure; per-worker dynamic `min`/`max` concurrency (§3.5) handles job-weight variance |

---

## 12. Monorepo layout (Bun workspaces)

```
the-mill/
  apps/
    web/         # React UI (Vite) — renders from git, sync/health badges
    api/         # Bun + Hono controller: git working copy, index, reconciler, queue, export
    worker/      # Bun worker + executor host (stateless)
  packages/
    core/        # domain types, project/workflow YAML schema (Zod) + validation (shared)
    compiler/    # workflow YAML + .js → standalone JS bundle   ← de-risk first
    executor/    # Executor interface + NsjailProcessExecutor (gVisor/Firecracker/K8sJob later)
    queue/        # BullMQ + worker registry wrappers
    gitops/      # git CLI wrapper + reconcile loop + sync/health status
    projectfs/   # read/watch the working tree; build the in-memory index
    sdk/         # runtime lib nodes import: ctx, log, io, secrets
    telemetry/   # pino + OpenTelemetry setup (logs/metrics/traces → Alloy)
  deploy/
    docker/      # Dockerfiles (api, worker, web)
    k8s/         # Deployments, Services, Ingress, HPA (memory/CPU), PVC (working copy)
  examples/
    billing/     # a sample project repo (YAML + .js) used by tests + demos
  docs/
    ARCHITECTURE.md · ROADMAP.md · LANDSCAPE.md · DEPENDENCIES.md
```

`packages/core` = one shared definition of what a workflow *is* (UI + controller).
`packages/gitops` is the ArgoCD-style engine; `packages/projectfs` is the working-tree
reader + in-memory index it feeds.
