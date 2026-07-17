# Mill — Third-Party Bill of Materials

Everything Mill takes off the shelf, what it does, and its license. Mill itself is
released **MIT**, so every runtime dependency must be MIT/Apache/BSD-compatible (or
merely *invoked* as a separate process, which doesn't affect our license).

Legend: **Build** = we build core logic on it · **Direct** = used mostly as-is ·
**Reuse** = existing infra we don't own/ship · **Invoke** = separate process (no linking).

---

## Runtime & shared core
| Component | Role in Mill | License | Usage |
|---|---|---|---|
| **Bun** | Worker + controller runtime; `bun build` **is the compiler**; package manager for exports | MIT | Build |
| **TypeScript** | One language across UI, controller, workers, compiler | Apache-2.0 | Build |
| **Zod** | Validate `project.yaml` / `workflow.yaml`; shared schema in `packages/core` | MIT | Build |
| **`yaml`** | Parse/serialize project files | ISC | Direct |

## Controller / API
| Component | Role in Mill | License | Usage |
|---|---|---|---|
| **Hono** | REST + WebSocket server on Bun | MIT | Build |
| **BullMQ** | Redis job queue; **repeatable jobs = app-level cron**; worker registry; flows | MIT | Build |
| **Redis** | Queue + pub/sub (live logs) + sync/registry/recent state — **ephemeral only** | BSD-3 (Redis) / SSPL (server) — *run as a separate service; we depend on the wire protocol/client, not link it* | Reuse |
| **ioredis** (or Bun's redis client) | Redis client | MIT | Direct |
| **git CLI** | GitOps clone/fetch/checkout/commit/push; only option with SSH + partial + sparse | GPL-2.0 — **Invoke** (subprocess, no linking → no contamination) | Invoke |
| **es-git** *(optional)* | In-process libgit2 binding (N-API) for the hot path | MIT | Direct |
| **pino** | Structured JSON logs → stdout → Alloy → Loki | MIT | Direct |
| **OpenTelemetry SDK** | Traces (Tempo) + metrics (Prometheus) | Apache-2.0 | Direct |

## Frontend
| Component | Role in Mill | License | Usage |
|---|---|---|---|
| **React + Vite** | UI app + build | MIT | Build |
| **@xyflow/react** (React Flow) | The visual node-graph editor (drag-and-drop palette, edge wiring) | MIT | Build |
| **Monaco** (via `@monaco-editor/react`) | Per-node `.js` editor: JS validation, `ctx`-aware autocompletion, Save & Apply | MIT | Direct |
| **TanStack Query** | Server-state/data fetching | MIT | Direct |
| **Tailwind CSS** (v4) | Styling — hand-rolled components (no shadcn) | MIT | Direct |
| **framer-motion · lucide-react · @radix-ui/react-tooltip** | Animation, icons, tooltips | MIT | Direct |

## Isolation (worker image)
| Component | Role in Mill | License | Usage |
|---|---|---|---|
| **nsjail** | Phase-1 sandbox (userns + seccomp + cgroups), **ON by default** | Apache-2.0 — **Invoke** (wraps the Bun subprocess) | Invoke |
| **gVisor (runsc)** *(later)* | Phase-2 semi-trusted isolation | Apache-2.0 | Reuse |
| **Firecracker / firecracker-containerd** *(later)* | Phase-3 untrusted microVM | Apache-2.0 | Reuse |
| **Kata Containers** *(optional)* | VM isolation as a k8s RuntimeClass | Apache-2.0 | Reuse |

## Kubernetes / infrastructure (reused, not built — see ARCHITECTURE §9)
| Component | Role in Mill | License | Usage |
|---|---|---|---|
| **Kubernetes / EKS** | Runs all containers; **Deployments** for API/UI/workers | Apache-2.0 | Reuse |
| **Ingress controller** (AWS LB Controller / nginx) | UI routing + **webhook ingestion** + TLS | Apache-2.0 | Reuse |
| **cert-manager** *(optional)* | TLS certs for Ingress | Apache-2.0 | Reuse |
| **HPA + Cluster Autoscaler** | **Sole** worker autoscaler: memory/CPU-based pod scaling + node scaling (no KEDA) | Apache-2.0 | Reuse |
| **External Secrets Operator** *(optional)* | Sync secrets into the cluster | Apache-2.0 | Reuse |
| **Grafana + Alloy + Loki + Prometheus + Tempo** | All logs/metrics/traces/history (your existing stack) | AGPL-3.0/Apache-2.0 — **Reuse** as separate services | Reuse |
| **Git provider** (GitHub/GitLab/…) | Hosts project repos (desired state) | external | Reuse |

---

## License posture for an MIT release
- **No AGPL/SSPL/BSL code is linked into Mill.** Redis (SSPL server) and Grafana/Loki
  (AGPL) run as **separate services** we talk to over the network — that does not affect
  Mill's MIT license. The **git CLI** (GPL-2.0) and **nsjail** are **invoked as
  subprocesses**, not linked — also no contamination.
- Everything compiled/bundled into Mill's own artifacts is MIT/Apache/BSD/ISC.
- If a fully-permissive Redis is ever required, **Valkey** (BSD-3, the Redis fork) is a
  drop-in via the same client.
