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
| `MILL_ADMIN_TOKEN` | | — | 🔒 | If set, all `/api/*` require this bearer (except `/api/health`, `/api/metrics`). Defense-in-depth; also locks the UI — usually leave unset and auth at the Ingress. |
| `MILL_CORS_ORIGINS` | | — | | Comma-separated allowlist for cross-origin browsers (default: same-origin only). |
| `MILL_STD_REGISTRY` | | — | | Base URL for `std://…@ver` remote callScript bundles. |
| `MILL_SECRETS` | | `{}` | 🔒 | Node secrets available to the controller's step-tester (same bag as the worker). |
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
| `MILL_LOG_LEVEL` / `MILL_LOG_FORMAT` | | | | As above. |

> **Isolation on k8s:** run the worker **in-process** (omit `MILL_EXECUTOR`). Pod-level
> isolation + resource limits are the boundary; a per-workflow `K8sJobExecutor`
> (pod-per-run, gVisor/Kata RuntimeClass) is the future opt-in for untrusted code. The
> `MILL_EXECUTOR=docker` mode needs a Docker socket and is **not** for k8s.

---

## 3. Secrets — how to feed them from EKS

There are **three kinds** of secret; all come from k8s `Secret`s (or External Secrets /
IRSA), never from git.

**a) Git credential** — `GIT_TOKEN` on the controller.

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
  # MILL_ADMIN_TOKEN: "REPLACE"        # optional; also locks the UI
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
