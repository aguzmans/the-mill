# Mill — EKS / Helm Deployment Guide

For the engineer wiring Mill into our existing Helm chart. This covers the **components**,
every **config value + secret**, how to **feed secrets from EKS**, and **copy-paste manifests**
to template. Runtime behavior/auth is in [RUNNING.md](RUNNING.md); metrics in [OBSERVABILITY.md](OBSERVABILITY.md).

---

## 1. Components

One container image (`mill-backend`, built from the repo `Dockerfile`) runs both the
controller and the worker — same image, **different command**. Plus Redis and the web UI
(served by the controller).

| Component | What it is | Command | Replicas |
|---|---|---|---|
| **controller** (api) | GitOps reconciler + HTTP control plane + webhook ingress + serves the UI. Talks to git; the only writer of the working copy. | `bun /app/apps/api/src/server.ts` | **1** (single reconciler — see HA note) |
| **worker** | Pulls jobs from Redis, runs each workflow, streams status/logs back. Stateless. | `bun /app/apps/worker/src/worker.ts` | **N** (HPA on CPU/mem) |
| **redis** | Job queue + worker registry + live-log bus + metrics counters. | `redis-server` | 1 (managed Redis / ElastiCache in prod) |
| **web** | The React UI. **Already baked into `mill-backend`** and served by the controller at `/`, so no separate deployment is required. | — | — |

The controller keeps a **git working copy on a PVC** (the source of truth is the git repo;
the PVC is a rebuildable cache). Workers are stateless and horizontally scaled.

---

## 2. Configuration reference

Non-secret config = `ConfigMap` → env. Secret config = `Secret` → env. **Required** values
have no safe default.

### Controller (api)
| Env | Req | Default | Secret? | Purpose |
|---|---|---|---|---|
| `PROJECT_REPO` | ✅ | — | | Git URL of the projects repo (HTTPS). |
| `PROJECT_BRANCH` | | `main` | | Tracked branch. |
| `GIT_TOKEN` | ✅* | — | 🔒 | Git credential (GitHub PAT/deploy token) for a private repo. |
| `REDIS_URL` | ✅ | — | | e.g. `redis://mill-redis:6379`. |
| `WORKDIR` | | `/app/workdir` | | Working-copy path — **mount the PVC here**. |
| `PORT` | | `8080` | | HTTP port. |
| `RECONCILE_INTERVAL_MS` | | `15000` | | Reconcile loop period. |
| `MILL_AUTOSYNC` | | `true` | | `false` → validate but **hold** new revisions (manual Sync applies). |
| `MILL_INGRESS_TOKEN` | | — | 🔒 | Global bearer for `/p` webhook endpoints (or use per-project tokens). |
| `MILL_GIT_WEBHOOK_SECRET` | | — | 🔒 | HMAC secret for the `POST /git/webhook` push hook. When set, the controller verifies `X-Hub-Signature-256` and reconciles instantly on push (instead of waiting for the poll). Set the same secret in the GitHub webhook. |
| `MILL_ADMIN_TOKEN` | | — | 🔒 | If set, all `/api/*` require this bearer (except `/api/health`, `/api/metrics`). Defense-in-depth; also locks the UI — usually leave unset and auth at the Ingress. |
| `MILL_CORS_ORIGINS` | | — | | Comma-separated allowlist for cross-origin browsers (default: same-origin only). |
| `MILL_STD_REGISTRY` | | — | | Base URL for `std://…@ver` remote callScript bundles. |
| `MILL_SECRETS` | | `{}` | 🔒 | Node secrets available to the controller's step-tester (same bag as the worker). |
| `MILL_SECRETS_KEY` | | — | 🔒 | Encrypts the Redis-backed **runtime secret store** (UI-managed) at rest (AES-256-GCM). Set the **same value on the api and every worker**. Unset → values stored plaintext in Redis (dev only). |
| `MILL_LOG_LEVEL` / `MILL_LOG_FORMAT` | | `info` / auto | | `debug…error`; `json` forces JSON logs. |
| _`<project ingress tokens>`_ | | — | 🔒 | Any env named by a project's `ingress.tokenEnv` (e.g. `PAYMENTS_INGRESS_TOKEN`). |

\* `GIT_TOKEN` required only for private repos.

### Worker
| Env | Req | Default | Secret? | Purpose |
|---|---|---|---|---|
| `REDIS_URL` | ✅ | — | | Same Redis as the controller. |
| `MILL_CONC_MIN` / `MILL_CONC_MAX` | | `1` / `8` | | Per-worker concurrency band. |
| `MILL_MEM_MAX_MB` | | `1024` | | Memory ceiling the worker sizes admission against — **set to the pod memory limit**. |
| `MILL_PAUSE_PCT` / `MILL_RESUME_PCT` | | `85` / `70` | | Load-shed thresholds. |
| `MILL_WORKER_ID` | | hostname | | Registry id (default fine — use the pod name). |
| `MILL_SECRETS` **and/or** individual secret env vars | | `{}` | 🔒 | **Node secrets** — see §3. |
| `MILL_SECRETS_KEY` | | — | 🔒 | **Must match the controller's** so the worker can decrypt UI-managed secrets. |
| `MILL_LOG_LEVEL` / `MILL_LOG_FORMAT` | | | | As above. |

> **Isolation on k8s:** run the worker **in-process** (omit `MILL_EXECUTOR`). Pod-level
> isolation + resource limits are the boundary; a per-workflow `K8sJobExecutor`
> (pod-per-run, gVisor/Kata RuntimeClass) is the future opt-in for untrusted code. The
> `MILL_EXECUTOR=docker` mode needs a Docker socket and is **not** for k8s.
>
> The local `docker-compose.yml` **mirrors this**: `api` and `worker` are separate services
> (workers never colocate with the api), the `worker` runs in-process and is hardened like a
> locked-down pod (`read_only`, `cap_drop: [ALL]`, `no-new-privileges`, mem/cpu limits) and
> scaled via `deploy.replicas` to stand in for the HPA-managed pod fleet.

---

## 3. Secrets — how to feed them from EKS

There are **three kinds** of secret; all come from k8s `Secret`s (or External Secrets /
IRSA), never from git.

**a) Git credential** — `GIT_TOKEN` on the controller. It is held in memory and handed to
`git` through a per-call credential helper that reads it from the process env, so the token
is **never** put in the remote URL, argv, `.git/config`, or an error/log line. The token must
be able to **read (and, for UI Save/Delete, write) `PROJECT_REPO`**:
- **Fine-grained PAT / GitHub App**: `Contents: Read and write` on that specific repo.
- **Classic PAT**: the `repo` scope.
- **SAML/SSO orgs**: after creating the token, **authorize it for the org** (Configure SSO),
  or GitHub hides the repo and every clone returns `Repository not found`.

**Verify the repo + token before you deploy** (swap in real values; the token stays in the
env, never in argv):
```bash
GIT_TOKEN=<PAT> git \
  -c credential.helper='!f(){ echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f' \
  ls-remote https://github.com/<org>/<repo>.git
```
Prints refs → good. `Repository not found` → wrong URL, or the token lacks access/SSO. A
brand-new **empty** repo (no commits) is fine — the controller comes up with an empty
workspace and the UI shows a "No projects yet" state until you push or create a project.

**b) Ingress tokens** — `MILL_INGRESS_TOKEN` (global) and/or per-project tokens. A project
declares `ingress: { tokenEnv: PAYMENTS_INGRESS_TOKEN }` in its `project.yaml`; you inject an
env var of that name on the controller.

**c) Node secrets** — the values workflow code reads via `ctx.secrets.<NAME>` (a node
declares `secrets: [STRIPE_KEY, WEBHOOK_SECRET]`; only declared names are exposed). **Two
injection styles, both supported on the worker (and the controller for the step-tester):**

- **Idiomatic (recommended)** — one env var per secret via `envFrom` a k8s Secret:
  ```yaml
  envFrom:
    - secretRef: { name: mill-node-secrets }   # keys: STRIPE_KEY, WEBHOOK_SECRET, …
  ```
  A node declaring `secrets: [WEBHOOK_SECRET]` then reads `ctx.secrets.WEBHOOK_SECRET`.
- **Blob** — a single `MILL_SECRETS` env holding a JSON object `{"STRIPE_KEY":"…"}`.

Prefer **(a)** with **External Secrets Operator** pulling from AWS Secrets Manager, or IRSA
if the value lives in SM and you fetch it in-node. Rotate by updating the Secret + rolling
the deployment.

- **Runtime store (UI-managed)** — the **Secrets** page writes values to **Redis**; the worker
  reads them **per job** (so an edit applies to the next run without a redeploy) and the
  controller uses them for the step-tester. Precedence: env / k8s Secrets **<** Redis store
  (a UI value wins on a name clash). Values are **write-only** in the UI (names listed, values
  never returned). Set **`MILL_SECRETS_KEY`** (same on api + all workers) to encrypt them at
  rest (AES-256-GCM); without it they're plaintext in Redis — fine for dev, not shared prod.
  Guard writes by setting `MILL_ADMIN_TOKEN`. Good for credentials you rotate from the UI
  (e.g. `ACUITY_USER_ID`, `ACUITY_API_KEY`); k8s Secrets remain best for platform-managed ones.

**d) Capability URLs (header-less webhook providers)** — providers like **Acuity**, Twilio, or
legacy Stripe **can't send an `Authorization` header**. Give the workflow's webhook trigger an
**unguessable `path`** (≥24 chars) — `triggers: [{ type: webhook, path: <long-random> }]` — and
Mill authenticates **by the path itself**: `POST /p/w/<workflow>/<long-random>` needs **no
bearer**. The default `/p/w/<workflow>/<project>` path still requires the bearer, and a wrong
path is `404`. Treat the path like a password (rotate by editing the trigger). The editor's
webhook trigger has a "custom path" field for this.

**e) Admin API token (`MILL_ADMIN_TOKEN`)** — locks the controller's `/api/*` behind a bearer
(everything except `/api/health` and `/api/metrics`, which stay open for probes/scrape). Set it
when the API is reachable by anything you don't fully trust — **without it, any caller that can
reach the Service can read/write the runtime secret store and mutate projects.** ⚠️ It also
locks the **browser UI** (the SPA calls `/api/*` with no bearer), so either drive the API
headless (CLI/webhooks) or terminate human auth (SSO / oauth2-proxy) at the Ingress and keep
this as defense-in-depth. Ingress webhook routes (`/p/*`) are unaffected — they authenticate by
the capability path (d) or ingress token (b).

Feed it like the other 🔒 controller secrets. **With External Secrets Operator + AWS Parameter
Store** (the idiomatic path):

```bash
# 1) Store the value (SecureString — ESO decrypts it). Rotate by overwriting + rolling the pod.
aws ssm put-parameter --region <region> \
  --name /mill/<env>/mill-controller/admin-token \
  --type SecureString --value "$(openssl rand -hex 24)" --overwrite
```
```yaml
# 2) Add one entry to the ExternalSecret that builds the controller's Secret (alongside
#    git-token / ingress-token). Do NOT create a second target Secret — reuse this one.
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: { name: mill-controller-secrets, namespace: <ns> }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-parameterstore, kind: ClusterSecretStore }  # your store
  target: { name: mill-controller-secrets, creationPolicy: Owner }
  data:
    # …existing git-token / ingress-token / git-webhook-secret entries…
    - secretKey: admin-token
      remoteRef: { key: /mill/<env>/mill-controller/admin-token }
```
```yaml
# 3) Reference it from the controller container env (same style as the other keys):
          env:
            - name: MILL_ADMIN_TOKEN
              valueFrom:
                secretKeyRef: { name: mill-controller-secrets, key: admin-token }
```

**Ordering:** `secretKeyRef` is required by default, so the key must exist in the k8s Secret
*before* the Deployment rolls, or the new pod is stuck in `CreateContainerConfigError`. Under
Argo CD, put the ExternalSecret in an earlier sync-wave than the Deployment
(`argocd.argoproj.io/sync-wave: "0"` vs `"1"`); otherwise apply the ExternalSecret and confirm
the key landed (`kubectl -n <ns> get secret mill-controller-secrets -o jsonpath='{.data.admin-token}'`)
before rolling. The worker does **not** need this — it talks to Redis, not the HTTP API.

**Verify** after rollout:
```bash
curl -so /dev/null -w '%{http_code}\n' https://<host>/api/projects                       # 401
curl -so /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" .../api/projects # 200
curl -so /dev/null -w '%{http_code}\n' https://<host>/api/health                          # 200 (probes OK)
```

---

## 4. Manifests (template these into the Helm chart)

Namespaced, one namespace. Adjust image, resources, storage class, ingress host/annotations.

### ConfigMap + Secrets
```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: mill-config }
data:
  PROJECT_REPO: "https://github.com/acme/mill-projects.git"
  PROJECT_BRANCH: "main"
  REDIS_URL: "redis://mill-redis:6379"
  WORKDIR: "/app/workdir"
  PORT: "8080"
  MILL_AUTOSYNC: "true"
  MILL_LOG_FORMAT: "json"
  MILL_STD_REGISTRY: "https://mill-registry.internal"
---
apiVersion: v1
kind: Secret
metadata: { name: mill-controller-secrets }
type: Opaque
stringData:
  GIT_TOKEN: "REPLACE"
  MILL_INGRESS_TOKEN: "REPLACE"        # global webhook bearer
  # MILL_ADMIN_TOKEN: "REPLACE"        # optional; locks /api/* AND the UI — see §3(e) for the
                                       # External Secrets + Parameter Store recipe (preferred)
  # PAYMENTS_INGRESS_TOKEN: "REPLACE"  # per-project token(s) referenced by ingress.tokenEnv
---
apiVersion: v1
kind: Secret
metadata: { name: mill-node-secrets }   # values workflow code reads via ctx.secrets.*
type: Opaque
stringData:
  WEBHOOK_SECRET: "REPLACE"
  STRIPE_KEY: "REPLACE"
```

### Controller (Deployment + PVC + Service)
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: mill-workdir }
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: gp3
  resources: { requests: { storage: 5Gi } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: mill-controller }
spec:
  replicas: 1                     # single reconciler (see HA note)
  strategy: { type: Recreate }    # PVC is RWO
  selector: { matchLabels: { app: mill-controller } }
  template:
    metadata: { labels: { app: mill-controller } }
    spec:
      containers:
        - name: controller
          image: <registry>/mill-backend:<tag>
          command: ["bun", "/app/apps/api/src/server.ts"]
          ports: [{ containerPort: 8080 }]
          envFrom:
            - configMapRef: { name: mill-config }
            - secretRef:    { name: mill-controller-secrets }
            - secretRef:    { name: mill-node-secrets }      # for the step-tester
          volumeMounts:
            - { name: workdir, mountPath: /app/workdir }
          readinessProbe: { httpGet: { path: /api/health, port: 8080 }, initialDelaySeconds: 10 }
          livenessProbe:  { httpGet: { path: /api/health, port: 8080 }, periodSeconds: 15 }
          resources:
            requests: { cpu: "250m", memory: "512Mi" }
            limits:   { cpu: "1",    memory: "1Gi" }
      volumes:
        - name: workdir
          persistentVolumeClaim: { claimName: mill-workdir }
---
apiVersion: v1
kind: Service
metadata: { name: mill-controller }
spec:
  selector: { app: mill-controller }
  ports: [{ port: 8080, targetPort: 8080 }]
```

### Worker (Deployment + HPA)
```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: mill-worker }
spec:
  replicas: 2
  selector: { matchLabels: { app: mill-worker } }
  template:
    metadata: { labels: { app: mill-worker } }
    spec:
      containers:
        - name: worker
          image: <registry>/mill-backend:<tag>
          command: ["bun", "/app/apps/worker/src/worker.ts"]
          env:
            - { name: REDIS_URL,       value: "redis://mill-redis:6379" }
            - { name: MILL_CONC_MAX,   value: "8" }
            - { name: MILL_MEM_MAX_MB, value: "1024" }   # = memory limit below
            - { name: MILL_WORKER_ID,  valueFrom: { fieldRef: { fieldPath: metadata.name } } }
          envFrom:
            - secretRef: { name: mill-node-secrets }      # ctx.secrets.*
          resources:
            requests: { cpu: "250m", memory: "512Mi" }
            limits:   { cpu: "1",    memory: "1Gi" }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: mill-worker }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: mill-worker }
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource: { name: memory, target: { type: Utilization, averageUtilization: 70 } }
    - type: Resource
      resource: { name: cpu,    target: { type: Utilization, averageUtilization: 70 } }
```

### Autoscale on queue depth (custom metrics — recommended)

CPU/memory HPA is **lagging** for a queue workload: pods only look busy *after* they pick up
work, so a backlog builds before the fleet scales. Scale on the **queue** instead. The
controller already exports the signals at `GET /api/metrics` (Prometheus text):

| Metric | Use for scaling |
|---|---|
| `mill_queue_depth` | jobs waiting — the primary backlog signal |
| `mill_queue_oldest_wait_seconds` | head-of-line latency — a SLA guard |
| `mill_worker_capacity` / `mill_worker_saturation_ratio` | fleet slots and busy fraction (0..1) |
| `mill_workers`, `mill_workers_inflight` | fleet size and live in-flight |

**Option A — KEDA (best fit; scales straight off the Redis queue).** KEDA creates/manages
the HPA for you and can scale to/from zero:
```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: mill-worker, namespace: mill }
spec:
  scaleTargetRef: { name: mill-worker }        # the worker Deployment
  minReplicaCount: 2
  maxReplicaCount: 20
  cooldownPeriod: 120
  triggers:
    # (a) backlog — target ≤5 pending jobs per replica, read from the Redis list directly
    - type: redis
      metadata: { address: redis.mill.svc:6379, listName: "mill:queue", listLength: "5" }
    # (b) latency guard — add pods if the oldest queued job waits > 30s
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc:9090
        query: max(mill_queue_oldest_wait_seconds)
        threshold: "30"
    # (c) keep CPU/mem as a floor (optional)
    - type: cpu
      metadata: { type: Utilization, value: "70" }
```
`mill:queue` is the Redis list the queue uses (`LLEN mill:queue` = `mill_queue_depth`), so the
`redis` trigger needs no Prometheus at all. **Exclusive jobs compose naturally:** an
`exclusive: true` job sitting in the queue raises `mill_queue_depth`, KEDA adds a pod, and
that fresh pod dedicates itself to the job (takes no co-tenants) until it finishes.

**Option B — prometheus-adapter (plain HPA `External` metric).** If you already run
prometheus-adapter, expose `mill_queue_depth` as an external metric and target it:
```yaml
# HPA (autoscaling/v2) — add alongside the Resource metrics above
- type: External
  external:
    metric: { name: mill_queue_depth }
    target: { type: AverageValue, averageValue: "5" }   # ≈5 pending jobs per replica
```
Either way, scrape the controller with a `ServiceMonitor` on `/api/metrics` (see below).

### Dedicated-pod (exclusive) workloads

A workflow may set **`exclusive: true`** in its `workflow.yaml` (authoring reference:
[RUNNING.md → Exclusive execution](RUNNING.md#exclusive-execution-dedicate-a-whole-workerpod-to-a-run)).
A worker that picks up such a run **takes no other jobs until it finishes** — the whole pod is
dedicated to it. Operational implications for capacity planning:

- An exclusive run reduces that pod's effective concurrency to **1** for its duration, so size
  pod `resources.limits` for a *single* heavy run (not `concMax` concurrent ones). Consider a
  **separate worker Deployment** with a higher-memory profile (and its own `ScaledObject`) if
  exclusive jobs are much larger than normal ones.
- Queue-depth autoscaling handles the elasticity: a queued exclusive job raises
  `mill_queue_depth` → KEDA/HPA adds a pod → that fresh pod dedicates itself. No special
  routing is needed, but ensure `maxReplicaCount` is high enough to absorb bursts of them.
- Exclusive jobs never co-tenant, so they are unaffected by (and do not interfere with) a
  worker's `MILL_CONC_MAX`.

### Redis — persistence, retention & sizing

Redis holds the queue, worker registry, per-job state, live-log events, the resume journal,
and the rolling completed-runs list. Configure it deliberately.

**Persistence (survive restarts).** Run Redis with **AOF** and a real volume:
```
redis-server --appendonly yes --appendfsync everysec \
  --maxmemory <see table> --maxmemory-policy volatile-ttl
# mount a PVC at /data
```
`volatile-ttl` evicts the **nearest-to-expire job keys first** if `maxmemory` is hit; the
queue/registry keys carry no TTL, so they are never evicted (jobs are not silently dropped).
The local `docker-compose.yml` already does this (`redis-data` volume). `everysec` fsync ≈ ≤1s
of loss on a hard crash; use `appendfsync always` only if you can't tolerate any loss.

**Retention (config).**

| Env var | Default | What it controls |
|---|---|---|
| `MILL_JOB_TTL_SECONDS` | `604800` (7 days) | TTL on each job's hash, events (logs), journal, and per-workflow runs index. Set on **both api and worker**. |
| `MILL_COMPLETED_MAX` | `5000` | Rolling cap on the global completed-runs list that feeds the dashboard/run-history. |
| `MILL_REDIS_MAXMEMORY` | `1gb` | Redis `maxmemory` (compose passes it through). Size from the table below. |

**Memory sizing.** Measured footprint (calibrated on a running stack): a job hash ≈ **0.4–2 KB**,
each live-log event ≈ **~90 B**, and the **journal is deleted on success** (only failed/requeued
runs keep it). So per-job memory is dominated by **log-event volume**. Model:

```
bytes/job ≈ hash(~0.5KB + input + result) + events(N × ~0.1KB) + (failed ? nodes × ~0.2KB : 0)
peak_bytes ≈ jobs_per_day × (MILL_JOB_TTL_SECONDS / 86400) × bytes_per_job × 1.4   (1.4 = Redis overhead)
```

At a **7-day** TTL, size `maxmemory` (and the PVC) from your throughput and how chatty jobs are:

| Jobs/day | Jobs retained (7d) | Light ~1 KB/job | Typical ~3 KB/job | Heavy ~20 KB/job |
|---:|---:|---:|---:|---:|
| 1,000 | 7 K | ~10 MB | ~29 MB | ~196 MB |
| 10,000 | 70 K | ~98 MB | ~294 MB | ~1.9 GB |
| 100,000 | 700 K | ~980 MB | ~2.9 GB | ~19 GB |
| 1,000,000 | 7 M | ~9.6 GB | ~29 GB | ~192 GB |

*Light* = few nodes, little logging; *Typical* = ~10 nodes + modest logging; *Heavy* = many nodes,
verbose logs, large payloads. If a cell exceeds your Redis budget: **shorten `MILL_JOB_TTL_SECONDS`**,
reduce per-node logging, or offload history to Postgres/Loki (the documented upgrade path) and keep
Redis for hot state only. Watch `used_memory` and alert well below `maxmemory`.

### Concurrency policy (overlap control)

A cron workflow can set **`concurrencyPolicy: Allow | Forbid | Replace`** (k8s CronJob semantics;
authoring: [RUNNING.md](RUNNING.md#concurrency-policy-cron-overlap)). It is **enforced for cron
triggers only** — webhook/manual/event runs always fire. `Forbid` skips a new run while one is in
progress; `Replace` is **best-effort**: it drops a still-*queued* prior run (newest wins) but lets
an already-*executing* run finish (degrades to Forbid). Observability:
`mill_concurrency_skipped_total{policy}` and `mill_concurrency_replaced_total{policy}`.

### Ingress (UI + webhooks + TLS + SSO)
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mill
  annotations:
    # terminate SSO/OIDC here (e.g. oauth2-proxy / ALB authenticate-oidc) — /api/* has no
    # app auth by default. Leave /p (webhooks) OUT of the SSO auth path (they use bearer tokens).
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/certificate-arn: <acm-arn>
spec:
  rules:
    - host: the-mill.example.com
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: mill-controller, port: { number: 8080 } } } }
```
> Put the **UI + `/api/*` behind SSO**; expose **`/p/*` (webhooks)** as a separate,
> **unauthenticated-at-the-proxy** path (they carry their own bearer token) so external
> providers can POST to them. Both route to the same controller Service.

### Optional: PodDisruptionBudget + ServiceMonitor
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: mill-worker }
spec: { minAvailable: 1, selector: { matchLabels: { app: mill-worker } } }
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: mill }
spec:
  selector: { matchLabels: { app: mill-controller } }
  endpoints: [{ port: http, path: /api/metrics, interval: 15s }]
```

---

## 5. Notes for the chart

- **Image**: one image, two `command`s. Template `image.repository` / `image.tag` once.
- **Config vs Secret**: everything in §2 marked 🔒 → a templated `Secret` (or ExternalSecret);
  the rest → `ConfigMap`. Both attached via `envFrom` so adding a key needs no template change.
- **`MILL_MEM_MAX_MB` must equal the worker memory limit** so admission matches the cgroup.
- **Controller is single-replica** today (the reconciler isn't yet leader-elected). Use
  `Recreate` + a RWO PVC. HA (leader election) is on the roadmap.
- **Redis**: point `REDIS_URL` at ElastiCache in prod; the in-cluster Redis manifest is for
  dev only. Mill keeps no other datastore.
- **Scaling signal is resource pressure** (HPA on CPU/mem), not queue depth (no KEDA) — see
  ARCHITECTURE §9. `mill_queue_oldest_wait_seconds` (OBSERVABILITY.md) is your backlog alert.
- **Health**: `GET /api/health` for probes. **Metrics**: `GET /api/metrics` (stays open even
  with `MILL_ADMIN_TOKEN`; add `bearer_token` to the scrape if you route it through auth).

---

## 6. Troubleshooting

**`repo init failed … git clone … Repository not found`** — the controller cloned
`PROJECT_REPO` but GitHub refused. This is **config, not a bug**; the clone URL in the log is
intentionally scrubbed of the token. GitHub returns the same "not found" for a missing repo
*and* a private repo the token can't see (it never leaks existence). Check, in order:
1. **URL** — is `PROJECT_REPO` your real `https://github.com/<org>/<repo>.git`? (A common
   miss is a leftover placeholder like `acme/mill-projects`.)
2. **Token access** — does `GIT_TOKEN` have `Contents: Read`/`repo` on that repo?
3. **SSO** — SAML org? Authorize the token for the org (§3a).

Reproduce it in one line with the `ls-remote` check in §3a; fix the env; roll the controller.

**Workspace shows a "No projects yet" empty state** — expected when the repo clones but has
no `*/project.yaml` yet. Push a project folder (or click **New Project**) and it appears on
the next reconcile. (The live UI shows **only** real controller data — it never renders the
`/prototype` demo catalogue; see ROADMAP M4.)

**UI shows demo "Billing/Growth" projects** — the pod is serving an **old image** built
before the demo data was removed from the live bundle. Rebuild/republish and roll the
deployment. Confirm the nav badge reads **Live** (not Prototype).

**`… requires a git-backed workspace (PROJECT_REPO)`** on Save/Delete/New Project — the
controller is running in **dir mode** (no `PROJECT_REPO` set), which is read-only from a
mounted folder. Set `PROJECT_REPO` (+ PVC at `WORKDIR`) to enable git-backed writes.
