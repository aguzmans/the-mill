# Mill — Competitive Landscape & Prior-Art Brief

> Research brief on the open-source workflow-automation / job-orchestration landscape,
> synthesized to inform Mill's design. Mill = a project is a git repo of YAML + JS;
> each workflow is a DAG of JS "code nodes"; workflows compile to standalone JS;
> execution runs server-side in isolated processes; controller + Redis queue +
> stateless Bun workers; ArgoCD-style GitOps reconciliation keeps running state in
> sync with git.
>
> Compiled 2026-07-16. Claims about non-obvious internals are cited inline.

---

## 0. TL;DR

The projects in this space cluster into three families, and Mill deliberately picks one primitive from each:

1. **Node/flow automation** (Windmill, n8n, Node-RED) — DAG-of-code-nodes, visual editors, the "items/`msg` between nodes" data contract. Mill's product surface lives here. **Windmill is the closest competitor** and its architecture is the single most important thing to study — especially its Postgres-everything storage, which is its documented Achilles' heel.
2. **Durable execution** (Temporal/Cadence, Restate, Inngest, Trigger.dev) — the retry/replay/checkpoint machinery that makes long-running steps survive crashes. Mill borrows *patterns* (step journaling, retry taxonomy, "server never runs user code," continue-as-new) without adopting a full event-sourced replay engine.
3. **DAG orchestration** (Argo Workflows/ArgoCD, Airflow, Prefect, Dagster) — dependency-expression models, worker-pull-from-queue, controller reconciliation, and the "hybrid" control-plane/execution-plane split. **ArgoCD's continuous reconcile-toward-git loop is the literal model Mill names in its own architecture.**

**The single biggest validated bet in Mill's design:** *don't put high-frequency mutable state (streaming logs, large results) and the job queue in the same hot SQL tables.* This is exactly what caused Windmill's worst production pain (dead-tuple bloat, 10 GB TOAST tables, DB CPU spikes). Mill's git-for-definitions + Redis-for-ephemeral-queue + Loki/Prom/Tempo-for-history split structurally avoids the failure mode Windmill had to retrofit fixes for.

---

## 1. Comparison table

| Project | Lang (server / core) | Workflow definition | User-code isolation & execution | State / storage model | License | Commercial restriction |
|---|---|---|---|---|---|---|
| **Windmill** | **Rust** (Axum); SvelteKit UI | Visual builder · "OpenFlow" JSON/YAML DAG · workflow-as-code (TS/Py) | Deno & Bun (V8 isolates) for TS; native execs for Py/Go; **nsjail + PID-ns sandbox OFF by default** | **Postgres for everything** — queue (`FOR UPDATE SKIP LOCKED`), results, logs; >2 MB results & big logs → S3 | **AGPLv3** + `enterprise` flag (open-core) | No resell / managed service / white-label |
| **n8n** | TypeScript / Node | Visual editor; workflow = JSON in DB | Code node runs JS/Py in **`@n8n/vm2`** (discontinued upstream; moving to `isolated-vm`) | SQLite/**Postgres**/MySQL; workflows & executions as rows; **queue mode = Redis + Bull + workers** | **Sustainable Use License** (fair-code) + Enterprise | No hosting-as-a-service, no white-label, no embedding in paid SaaS |
| **Node-RED** | Node.js / JS | Visual node+wire editor; flows = JSON on disk (`flows.json`) | Function node runs JS in Node **`vm` module** (context isolation, *not* a security sandbox) | `flows.json` file + encrypted `flows_cred.json`; **Projects = git repo** | **Apache 2.0** | None |
| **Kestra** | **Java** (Micronaut); Vue UI | **YAML flows** (`id`/`namespace`/`tasks`); DAG opt-in via `Dag`/flowable tasks | Script tasks (Py/Node/Shell…) via **Task Runners**: Docker-per-task (default) or in-process | JDBC profile: single **H2/PG/MySQL** = queue + repository; EE: **Kafka + Elasticsearch**; outputs → object storage | **Apache 2.0** core + EE | EE gates multi-tenancy, RBAC, some git sync |
| **Temporal** (ex-Cadence) | **Go** server; SDKs Go/Java/TS/Py/… | **Workflow-as-code** (deterministic) + Activities | **Server runs NO user code**; user workers **poll a task queue**, execute, report back | **Event history** (append-only log) in **Cassandra/PG/MySQL** (+ ES for search) | **MIT** (server) | None (Temporal Cloud is hosted) |
| **Restate** | **Rust** single binary | Handlers-as-code; `ctx.run()` side-effects; Virtual Objects | Server = durable broker; **pushes** invocations to your services over HTTP (FaaS/long-running) | **Self-contained**: embedded **RocksDB** cache derived from a replicated log (**Bifrost**); no external DB; optional S3 snapshots | **BSL 1.1 → Apache 2.0** (4 yr) | No offering it as a managed service |
| **Inngest** | **Go** core; TS/Py/Go SDKs | Event-triggered functions; `step.run()` steps | **Server runs NO user code**; **re-invokes your HTTP endpoint** and replays memoized steps | Redis (embedded or external) + **Postgres** (prod); event/queue/state store | **SSPL → Apache 2.0** (3 yr, DOSP); SDKs Apache 2.0 | SSPL: no competing managed service |
| **Trigger.dev** | TypeScript / Node | Tasks-as-code (`task({ run })`); `wait`, `retry` | **Runs your code on workers**; **per-run container**; durability via **CRIU/Firecracker checkpoint-restore** | **Postgres + Redis** | **Apache 2.0** | Cloud-only: warm starts, autoscaling, **checkpoints** |
| **Argo Workflows** | **Go**, k8s-native | **YAML CRD**; Steps or **DAG** templates | **Every task = a k8s pod** (strong isolation); controller reconciles | Live state = `Workflow` CRD in **etcd**; optional archive → PG/MySQL | **Apache 2.0** | None |
| **ArgoCD** | **Go**, k8s-native | Git repo = desired state (manifests) | (CD tool, not a code runner) | Continuous **desired-vs-live reconcile + self-heal** loop | **Apache 2.0** | None |
| **Airflow** | **Python** | DAGs as Python (`>>`, TaskFlow infers edges) | **Swappable executors**: Local / **Celery (workers pull from Redis/RabbitMQ)** / **Kubernetes (pod-per-task)** | **Metadata DB (Postgres) = single source of truth** (scaling ceiling; needs PGBouncer) | **Apache 2.0** | None |
| **Prefect** | **Python** | `@flow`/`@task`; DAG emerges at runtime | **Hybrid: server runs NO user code**; **outbound-polling workers** pull from typed work pools | Cloud/Server holds metadata+state **only**; code & data stay in your infra | **Apache 2.0** | Prefect Cloud is hosted control plane |
| **Dagster** | **Python** | Software-defined **assets** (declare outputs + deps) | User code in **separate gRPC "code location" processes**; run workers spawned per run | Webserver + single **daemon** + code servers; metadata DB | **Apache 2.0** | Dagster+ is hosted |

---

## 2. The projects that matter most to Mill

### 2.1 Windmill — the direct competitor (study its DB pain hardest)

**Architecture.** Rust backend (Axum) split into `windmill-api`, `windmill-queue`, `windmill-worker`, `windmill-common` crates. Server and worker are the **same binary in different modes**; workers are stateless and pull from a Postgres queue. SvelteKit + Monaco + Yjs frontend. ([DeepWiki](https://deepwiki.com/windmill-labs/windmill))

**Model.** *Script* = one function in one language; *Flow* = a state-machine DAG composing scripts, with for/while loops, branch-one/branch-all, retries, error handlers, and approval/suspend steps. Flows are authored three ways — visual builder, "OpenFlow" JSON/YAML spec, or workflow-as-code (Py/TS). ([Flows quickstart](https://www.windmill.dev/docs/getting_started/flows_quickstart))

**JS isolation.** Runs TS on **Deno and Bun**; Deno preferred for multi-tenant safety because V8 isolates come "for free." Heavier sandboxing (nsjail filesystem/network/resource limits; PID-namespace isolation; agent workers with no DB access) exists but is **OFF by default** — a production foot-gun Windmill's own docs warn about. ([security isolation](https://www.windmill.dev/docs/advanced/security_isolation), [Deno blog](https://deno.com/blog/immutable-scripts-windmill-production-grade-ops))

**Storage — and why it hurts.** A single Postgres DB holds *all* state including the queue. Queue = `SELECT … FOR UPDATE SKIP LOCKED`, workers poll every 50 ms; on completion the row moves from `queue`/`v2_job` to `completed_job`/`v2_job_completed`. Documented pain:
- **Log-streaming dead-tuple bloat.** Appending log lines to a big row every ~500 ms — every Postgres UPDATE leaves a dead tuple until vacuum. Fixed in **v1.295.0** by moving logs to a separate table, adaptive flush frequency (2.5 s / 5 s for longer jobs), and a ~5 KB DB cap with overflow to S3/disk. ([changelog](https://www.windmill.dev/changelog/log-disk-distributed-storage-compaction))
- **TOAST blowup from large results.** [Issue #6855](https://github.com/windmill-labs/windmill/issues/6855) (Oct 2025): base64 payloads (e.g. AI images) pushed `v2_job` to **10 GB**, nearly all TOAST, filling disk and hanging the app.
- **DB CPU spikes** from constant SKIP-LOCKED polling + high-frequency row churn ([#4911](https://github.com/windmill-labs/windmill/issues/4911)); makes autovacuum tuning the practical scaling bottleneck.

**Git-sync.** `wmill` CLI (`sync pull`/`sync push`), config in `wmill.yaml` (defaultTs, include/exclude globs, per-item-type skips, multi-workspace map). Exports **YAML by default**; scripts as code files + metadata sidecar, flows/apps as folders (`__flow/`, `__app/`), secrets skipped. EE adds **bidirectional git-as-source-of-truth**: every UI deploy auto-commits+pushes; conflict rule is **"Git always wins"** (reset the branch to roll back). ([CLI sync](https://www.windmill.dev/docs/advanced/cli/sync), [git-sync blog](https://www.windmill.dev/blog/launch-week-git-sync))

**License.** AGPLv3 core + `enterprise` compile-flag (open-core); no resell/managed-service/white-label without a commercial license. HN pushback that AGPL positioning reads closer to "source-available." ([LICENSE](https://github.com/windmill-labs/windmill/blob/main/LICENSE), [HN](https://news.ycombinator.com/item?id=38389973))

> **Borrow:** stateless-workers-pull-from-queue; the OpenFlow idea of *one DAG spec editable as visual + file + code*; a clean git-sync export layout; V8 isolates as the cheap default JS sandbox; the hard-won lesson of offloading logs/results out of the hot store early.
> **Do differently:** Mill's core structural win — **no SQL DB at all**; definitions live in git, the queue/registry live in Redis (ephemeral), and history/logs/metrics go to Loki/Prom/Tempo. This sidesteps *every* Windmill DB-bloat issue above by construction rather than by retrofit. Ship **isolation ON by default** (process → microVM), not opt-in. Give Mill an **unambiguous** open/commercial boundary from day one.

### 2.2 Kestra — the other "workflows as YAML in git" system

**Model.** Java/Micronaut backend, Vue UI. A flow is one YAML doc (`id`/`namespace`/`tasks` required; typed `inputs` validated at start; `pluginDefaults` for DRY defaults). **Crucial nuance: top-level `tasks:` run *sequentially in listed order*** — Kestra does **not** infer a DAG from data references. True parallelism/dependencies require opting into *flowable tasks* (`Dag` with per-task `dependsOn`, `Parallel`, `ForEach`, `Switch`, …). Subflows (synchronous call) and flow triggers (event-driven activation) are distinct primitives. ([flow docs](https://kestra.io/docs/workflow-components/flow), [flowable-tasks](https://kestra.io/docs/workflow-components/tasks/flowable-tasks))

**Isolation.** Every task type is a Java-JAR plugin loaded on the classpath at startup. Arbitrary scripts (Py/Node/Shell/R) run via **Task Runners** — a layer orthogonal to task logic deciding *where* code runs: **Docker-per-task (default, fresh container each run)** or in-process. ([task-runners](https://kestra.io/docs/task-runners), [scripts](https://kestra.io/docs/scripts))

**Git / GitOps — the important comparison.** Kestra's OSS "GitOps" is **not a real reconciler**: it's a `SyncFlows`/`SyncNamespaceFiles` **plugin task run inside a scheduled (cron) flow** that re-applies git state (with `delete: true` to enforce git-as-truth). So there's a polling window, no continuous drift detection, and reconciliation competes for the same execution machinery. `PushFlows` does the reverse (UI edits → git). The UI-integrated, RBAC-gated git experience is **EE-only**. ([git](https://kestra.io/docs/version-control-cicd/git), [SyncFlows](https://kestra.io/plugins/plugin-git/io.kestra.plugin.git.syncflows))

**Storage.** Queue + Repository abstraction with two profiles: **single JDBC DB (H2/PG/MySQL)** for small, **Kafka + Elasticsearch** for scale; task outputs/large files → object storage (only pointers in the DB). ([architecture](https://kestra.io/docs/architecture))

> **Borrow:** YAML-flow-as-typed-schema with validated `inputs`; `pluginDefaults`; **Task Runners as a layer orthogonal to task logic** (Docker-per-task is the right default isolation seam); subflow-vs-trigger as distinct concepts; outputs-to-object-storage with only pointers in the control plane.
> **Do differently:** This is Mill's clearest chance to *beat* prior art. Kestra's "GitOps" is a **polled sync task**; Mill's is a **genuine continuous reconciler** (ArgoCD-style desired-vs-live loop with sync/health status + auto-sync + self-heal) — a real differentiator. Also: Kestra's default **sequential** ordering surprises data-flow users — Mill makes control flow **explicit and visible in the graph** (edges wired by hand; branching via an `if` node), so what runs is exactly what you see. And avoid Kestra's JVM-JAR-on-classpath extensibility (restart-to-load); Mill's `.js` code nodes are the lighter, language-native extension surface.

### 2.3 The durable-execution family — patterns to steal (three distinct mechanisms)

There are **three ways** the field achieves crash-durable steps. Mill should understand the taxonomy and borrow the retry/journaling *patterns* without necessarily adopting a full replay engine:

1. **Deterministic replay (Temporal/Cadence, Inngest).** Persist each step's result to a log; on crash, re-run the orchestrator code but **short-circuit completed steps** by feeding back recorded results. Cheap state (few KB), but demands **step-boundary determinism** (no clock/random/IO in the orchestrator body) and loses live connections/closures across a wait.
   - *Temporal:* server **runs no user code**; user **workers poll a task queue**, execute, report back — "the Temporal Service doesn't execute any of your code." ([workers](https://docs.temporal.io/workers)) Requires external DB (Cassandra/PG/MySQL).
   - *Inngest:* server **runs no user code either**; it **re-invokes your HTTP endpoint** N times, injecting cached results for completed steps (stable hashed step IDs). Infra-light, language-agnostic, but pays N HTTP round-trips. ([how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed))
2. **Process checkpoint/restore (Trigger.dev v3).** **Runs your code on workers**, then **freezes the whole process** (CRIU / Firecracker snapshot) at a `wait`, thaws it later (possibly elsewhere), continuing from the exact instruction. Best ergonomics (plain async, closures/connections survive), but **infra-heavy** (checkpoint images hundreds of MB; needs CRIU/microVM plumbing) — which is why it's **cloud-only** even in Trigger.dev's own OSS. ([how-it-works](https://trigger.dev/docs/how-it-works))
3. **Log-journaling broker (Restate).** Single Rust binary; **pushes** invocations to your HTTP handlers, journals each step to a replicated log, rebuilds a RocksDB cache from the log. **No external DB.** Adds **epoch fencing** on retries (reject events from superseded attempts → exactly-once, no split-brain). ([architecture](https://docs.restate.dev/references/architecture))

**Retry primitives worth adopting (converged best-practice across the field):**
- Declarative **per-step**: `maxAttempts` + backoff (exponential, `factor`, `maxInterval`, `cap`) + **jitter** (Prefect/Dagster) + a programmable **retry condition** (Prefect `retry_condition_fn`, Argo `expression`).
- A **coarse run-level retry that survives the worker process dying** — distinct from step retries, which can't recover from the runner crashing (Dagster's two-tier model). ([Dagster run-retries](https://docs.dagster.io/deployment/execution/run-retries))
- **Temporal's four timeouts** (schedule-to-close, start-to-close, schedule-to-start, heartbeat) + **heartbeats** for fast crash detection independent of long step durations. ([activity-timeouts](https://temporal.io/blog/activity-timeouts))
- **Continue-as-new** to bound unbounded history for long/looping workflows.

> **Borrow:** step-result **journaling so retries skip completed work**; the layered retry taxonomy (per-step backoff+jitter+condition **plus** run-level); heartbeats for long steps; epoch/fencing tokens on retries for exactly-once. Because Mill **compiles a workflow to one standalone JS program** and runs it in an isolated process, the **Trigger.dev shape (run user code on our own workers, isolated per run)** is the closest fit — but Mill can start with **journaled-step re-run** (replay-style) durability and treat CRIU/microVM checkpointing as a later optimization, exactly as Trigger.dev gates it.
> **Do differently:** Don't adopt Temporal/Inngest's strict orchestrator-determinism constraint as a user-facing rule — it's a documented footgun. Mill's compiled-DAG-walk can journal at node boundaries (each node = a natural step) without asking users to write "deterministic" code. Keep Mill's **pull-based workers** (like Temporal/Airflow-Celery/Prefect) rather than Restate/Inngest's push-over-HTTP, since Mill owns the worker fleet.

### 2.4 The DAG-orchestrator family — reconciliation, workers, dependency expression

- **ArgoCD** is the literal template for Mill's control loop: **git = desired state**, a controller **continuously compares live vs. desired**, marks `OutOfSync`, and **auto-heals** drift. Mill's reconciler (compile · register triggers · sync/health badges · auto-sync) is this pattern applied to workflows. ([argo-cd docs](https://argo-cd.readthedocs.io/en/stable/))
- **Argo Workflows' `depends`** is the best dependency-expression syntax found: boolean logic over per-upstream **status tags** — `depends: "(task-2.Succeeded || task-2.Skipped) && !task-3.Failed"`. **Mill does *not* adopt it:** branching is a first-class **multi-conditional `if` node** (compiling to a literal `if/else`) rather than conditions on edges — simpler to author visually and to compile. ([enhanced-depends-logic](https://argo-workflows.readthedocs.io/en/latest/enhanced-depends-logic/))
- **Prefect** is the **cleanest "server orchestrates, workers run code"** realization: control plane holds *metadata/state only* ("never your data"); **workers poll outbound-only** (no inbound connections into customer infra); **typed work pools** with priority/concurrency queues route deployments to matching workers. Great model if Mill workers ever run in customer-controlled infra. ([Prefect how-it-works](https://www.prefect.io/how-it-works), [workers](https://docs.prefect.io/v3/concepts/workers))
- **Dagster** runs user code **out-of-process behind a stable gRPC boundary** (code locations), crash-isolated and independently redeployable; splits **webserver (UI/API) vs. daemon (scheduling)** as separate services. ([architecture](https://docs.dagster.io/deployment/oss/oss-deployment-architecture))
- **Airflow** is the **cautionary tale**: metadata DB as the *sole* source of truth buys free HA coordination (schedulers coordinate via `SELECT … FOR UPDATE` row locks) but becomes the throughput ceiling and hardest operational dependency (lock contention, connection exhaustion → PGBouncer). Its **swappable executor** abstraction (Local / Celery-queue / K8s-pod) is the good idea to keep. ([scheduler](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html), [executor](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/executor/index.html))

> **Borrow:** ArgoCD reconcile+self-heal loop (Mill already names it); Prefect's metadata-only control plane + outbound-pull workers + typed pools; Dagster's out-of-process code boundary + webserver/daemon split + two-tier retries. *(Not borrowed: Argo's `depends` edge syntax — Mill branches via a multi-conditional `if` node instead.)*
> **Do differently:** Avoid Airflow's DB-as-sole-truth ceiling (Mill's git+Redis+monitoring split does). If Mill keeps a **single-replica controller/reconciler** (like Dagster's single daemon, Argo's one-workflow-at-a-time), design HA around it early rather than late.

### 2.5 n8n & Node-RED — the node/flow UX primitives

- **n8n:** TypeScript/Node monorepo, Vue 3 UI. The reusable idea is the **items-array data contract** — every node receives and emits an array of `{ json, binary }` items, making nodes composable; and **queue mode** (Redis + Bull + worker processes, Postgres required) as a proven horizontal-scaling shape. Code node runs JS/Py in **`@n8n/vm2`** — but **vm2 is discontinued upstream after sandbox-escape CVEs** (e.g. CVE-2025-68613); the direction is `isolated-vm`. Git sync (Source Control & Environments) is **EE-only**, push/pull per branch, secrets deliberately not synced. **Fair-code (Sustainable Use License)**: internal use is free, but no hosting-as-a-service, no white-label, no embedding in a paid SaaS. ([Code node](https://docs.n8n.io/code/code-node/), [queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/), [Sustainable Use License](https://docs.n8n.io/privacy-and-security/sustainable-use-license))
- **Node-RED:** Node.js, Apache 2.0. The `msg`-object-per-wire model is dead-simple for event/IoT pipelines but doesn't express batch/array processing as well as n8n's items-array. **First-class git-backed Projects** (version-control sidebar, push/pull, committer identity, `package.json` deps, encrypted-credentials-separate-from-flow-JSON) is a strong, *free* git story. The Function node runs JS in Node's **`vm` module — explicitly *not* a security sandbox** (assumes trusted authors). ([writing functions](https://nodered.org/docs/user-guide/writing-functions), [projects](https://nodered.org/docs/user-guide/projects/))

> **Borrow:** n8n's **`{json, binary}` items-array** as the inter-node data contract for data-transformation workflows; Node-RED's **encrypted-credentials-file-separate-from-flow-definition** split; Node-RED's free, editor-integrated **git Projects** UX (Mill can match/exceed it since git *is* Mill's model).
> **Do differently:** **Never** base isolation on `vm2` (discontinued, repeatedly escaped) or Node's `vm` module (not a security boundary) — Mill's process→microVM isolation is the right call, ON by default. Avoid n8n-style **fair-code** licensing friction if Mill wants adoption; a clean OSI license (or clearly-scoped commercial split) is less ambiguous than fair-code / AGPL / SSPL / BSL.

---

## 3. Prioritized BORROW list (highest value first)

1. **ArgoCD-style continuous reconcile + self-heal** (git = desired state, controller drives live → git, sync/health status, auto-sync). *Mill already names this — it's the core differentiator vs. Kestra's polled sync-task and Windmill's "Git always wins" one-shot.* — from **ArgoCD**.
2. **Keep the hot, high-churn state OUT of any SQL store.** Definitions → git; queue/registry/live-status → Redis (ephemeral); logs/results/history → object storage + Loki/Prom/Tempo. *This structurally prevents Windmill's #1 documented failure mode.* — the anti-pattern from **Windmill/Airflow**.
3. **Server never runs user code; stateless workers pull from the queue, execute an isolated process, stream status back.** — from **Temporal / Prefect / Dagster / Windmill**.
4. **Isolation ON by default, per-run, process → microVM** (Docker/Firecracker-per-run for blast-radius containment). — from **Kestra (Docker-per-task) / Trigger.dev (per-run container) / Argo (pod-per-task)**; explicitly *fixing* Windmill's opt-in default.
5. **Step-boundary journaling so retries skip completed nodes**, plus a **layered retry model**: per-node backoff + jitter + condition **and** a run-level retry that survives worker death. — from **Inngest/Temporal (journaling) + Dagster (two-tier) + Prefect (jitter/condition)**.
6. **Multi-conditional `if` node** for branching (a literal `if/else`; `true`/`false` edges) — chosen *instead of* Argo's `depends` edge syntax. Sub-workflow calls use a **`callScript`** node (in-project or standalone/remote); loops are deferred (loop inside a `jscode` node).
7. **One DAG definition that is simultaneously the visual graph, the git file, and the compiled program** — Mill's "one compiler" thesis, validated by Windmill's OpenFlow (spec + builder + code) but taken further (real `.js` files, not YAML strings). — from **Windmill (OpenFlow)**.
8. **Typed inputs validated at start + `pluginDefaults`-style DRY defaults.** — from **Kestra**.
9. **`{json, binary}` items-array inter-node data contract** for data-transformation nodes. — from **n8n**.
10. **Credentials/secrets stored separately from (and never committed with) the workflow definition**; git-sync skips secrets. — from **Node-RED / n8n / Windmill**.
11. **Heartbeats + explicit timeout taxonomy** for long-running nodes (fast crash detection independent of step duration); **continue-as-new** to bound long/looping runs. — from **Temporal**.
12. **Epoch/fencing tokens on retries** for exactly-once and no split-brain from a zombie prior attempt. — from **Restate**.

## 4. Prioritized AVOID list

1. **Do NOT co-locate streaming logs + large results + the job queue in the same SQL tables.** Windmill's dead-tuple bloat, **10 GB TOAST tables** ([#6855](https://github.com/windmill-labs/windmill/issues/6855)), and DB CPU spikes all trace to UPDATE-heavy log/result rows next to the queue. — **Windmill**.
2. **Do NOT make a single SQL DB the sole source of truth.** It becomes the throughput ceiling and your hardest ops dependency (lock contention, connection exhaustion, PGBouncer). — **Airflow**.
3. **Do NOT ship user-code isolation as opt-in.** — **Windmill** (nsjail/PID-ns OFF by default).
4. **Do NOT base JS isolation on `vm2` or Node's `vm` module** — vm2 is discontinued with repeated sandbox-escape CVEs; `vm` is explicitly not a security boundary. Use V8 isolates and/or process/microVM isolation. — **n8n / Node-RED**.
5. **Do NOT ship "GitOps" as a polled cron sync-task** — that's a weaker imitation with a drift window. Mill's continuous reconciler must be genuinely continuous. — **Kestra**.
6. **Do NOT impose orchestrator-determinism as a user-facing rule** (no clock/random/IO in workflow code, version-gating to change it). It's a documented footgun; journal at node boundaries instead. — **Temporal/Inngest**.
7. **Do NOT adopt CRIU/Firecracker checkpoint-restore as a v1 durability requirement** — it's infra-heavy, kernel-sensitive, and large-image-costly (Trigger.dev keeps it cloud-only). Start with journaled re-run; treat checkpointing as a later optimization. — **Trigger.dev**.
8. **Do NOT adopt a "Git always wins / delete anything not in source" destructive default** without strong guardrails and clear conflict semantics for UI editors. — **Windmill git-sync**.
9. **Do NOT choose a restrictive/ambiguous license** (fair-code / AGPL-open-core / SSPL / BSL) if broad adoption matters — each created real friction/confusion. Decide the open vs. commercial boundary unambiguously up front. — **n8n / Windmill / Inngest / Restate**.
10. **Do NOT couple extensibility to a heavyweight, restart-to-load plugin model** (JVM JARs on the classpath). Mill's `.js` code nodes are the lighter, language-native surface. — **Kestra**.
11. **If the controller/reconciler is single-replica** (a reasonable v1 choice, mirroring Dagster's single daemon / Argo's per-workflow serialization), **plan HA and the wide-fan-out bottleneck early**, not after it bites. — **Dagster / Argo**.

---

## 5. Direct implications for Mill's stated design

- **"No SQL database" is the right, validated call.** Every DB-centric system here (Windmill, Airflow, n8n, Temporal, Kestra-JDBC) either hit or designs around DB-as-bottleneck. Mill's git + Redis-ephemeral + external-monitoring split is the structural answer — *provided* Redis is treated as genuinely ephemeral (queue/registry/live-status only) and never as durable history.
- **The Redis queue mirrors n8n queue-mode and Windmill's worker model** — proven. Watch the same things they do: bundle payload size (Windmill offloads >2 MB results; do the same to object storage), and worker poll/concurrency tuning.
- **The compile-to-standalone-JS thesis is Mill's moat.** No competitor makes the editor artifact == server artifact == export artifact. OpenFlow gets closest but keeps code as YAML strings; Mill's real `.js` files + one compiler is cleaner. De-risk the compiler first (as ARCHITECTURE.md already flags).
- **The reconciler is Mill's product differentiator** over both Windmill (one-shot "Git always wins") and Kestra (polled sync-task). Lean into ArgoCD's *continuous* semantics: sync status, health, auto-sync, self-heal, drift detection.
- **Isolation:** start with process isolation ON by default; the Mill roadmap's "process → microVM" progression matches how Kestra/Trigger.dev/Argo do it and fixes Windmill's opt-in mistake.

---

## Appendix — key source URLs

- Windmill: [DeepWiki architecture](https://deepwiki.com/windmill-labs/windmill) · [security isolation](https://www.windmill.dev/docs/advanced/security_isolation) · [log/DB changelog](https://www.windmill.dev/changelog/log-disk-distributed-storage-compaction) · [TOAST bloat #6855](https://github.com/windmill-labs/windmill/issues/6855) · [CLI sync](https://www.windmill.dev/docs/advanced/cli/sync) · [git-sync blog](https://www.windmill.dev/blog/launch-week-git-sync)
- Kestra: [architecture](https://kestra.io/docs/architecture) · [flowable-tasks](https://kestra.io/docs/workflow-components/tasks/flowable-tasks) · [task-runners](https://kestra.io/docs/task-runners) · [git](https://kestra.io/docs/version-control-cicd/git)
- Temporal: [workers](https://docs.temporal.io/workers) · [workflows/determinism](https://docs.temporal.io/workflows) · [activity-timeouts](https://temporal.io/blog/activity-timeouts)
- Restate: [architecture](https://docs.restate.dev/references/architecture) · [first-principles](https://www.restate.dev/blog/building-a-modern-durable-execution-engine-from-first-principles)
- Inngest: [how-functions-are-executed](https://www.inngest.com/docs/learn/how-functions-are-executed) · [self-hosting](https://www.inngest.com/docs/self-hosting)
- Trigger.dev: [how-it-works](https://trigger.dev/docs/how-it-works) · [self-hosting](https://trigger.dev/docs/self-hosting/overview)
- Argo: [enhanced-depends-logic](https://argo-workflows.readthedocs.io/en/latest/enhanced-depends-logic/) · [architecture](https://argo-workflows.readthedocs.io/en/latest/architecture/) · [ArgoCD](https://argo-cd.readthedocs.io/en/stable/)
- Airflow: [executor](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/executor/index.html) · [scheduler](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html)
- Prefect: [how-it-works](https://www.prefect.io/how-it-works) · [workers](https://docs.prefect.io/v3/concepts/workers)
- Dagster: [oss-deployment-architecture](https://docs.dagster.io/deployment/oss/oss-deployment-architecture) · [run-retries](https://docs.dagster.io/deployment/execution/run-retries)
- n8n: [Code node](https://docs.n8n.io/code/code-node/) · [queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/) · [Sustainable Use License](https://docs.n8n.io/privacy-and-security/sustainable-use-license)
- Node-RED: [writing functions](https://nodered.org/docs/user-guide/writing-functions) · [projects](https://nodered.org/docs/user-guide/projects/)
