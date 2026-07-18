# Mill

A GitOps-native workflow-automation platform (a self-hostable Windmill / n8n replacement).
Workflows live in git; a controller reconciles them into a running fleet of workers that
execute each node with pod-level isolation.

## Documentation map

| I want to… | Read |
|---|---|
| **Deploy Mill on EKS** (components, config, secrets, manifests, **autoscaling**) | **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** |
| Run the stack locally (docker-compose) + author & trigger workflows | [docs/RUNNING.md](docs/RUNNING.md) |
| Monitor it (Prometheus metrics, alerts, dashboards) | [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) |
| Understand the design (controller, queue, executors, isolation) | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| See what's built vs. planned | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Third-party dependencies & licenses | [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) |

## For deployment engineers — start here

- **Topology & isolation.** `api` (controller) and `worker` are **separate** Deployments;
  workers never colocate with the api. Each worker runs nodes **in-process inside its own
  hardened pod** — the pod is the isolation boundary. → [DEPLOYMENT.md § Components / Isolation](docs/DEPLOYMENT.md#1-components)
- **Configuration & secrets.** Env-var reference and how to feed Secrets from EKS.
  → [DEPLOYMENT.md §2–§3](docs/DEPLOYMENT.md#2-configuration-reference)
- **Manifests.** Copy-paste Deployments / Service / HPA / Ingress / ServiceMonitor to template
  into the Helm chart. → [DEPLOYMENT.md §4](docs/DEPLOYMENT.md#4-manifests-template-these-into-the-helm-chart)
- **Autoscaling on queue depth** (KEDA / prometheus-adapter, not just CPU/memory).
  → [DEPLOYMENT.md § Autoscale on queue depth](docs/DEPLOYMENT.md#autoscale-on-queue-depth-custom-metrics--recommended)
- **Dedicated-pod (`exclusive`) workloads** and their capacity-planning impact.
  → [DEPLOYMENT.md § Dedicated-pod workloads](docs/DEPLOYMENT.md#dedicated-pod-exclusive-workloads)
- **Observability points** (metrics catalog + alerts). → [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)

## The local stack (one command)

```bash
docker compose up -d redis api worker web    # control plane + a 2-pod worker fleet + UI
# api  → http://localhost:8787   (also serves the UI at /fleet, /workspace, …)
```

See [docs/RUNNING.md](docs/RUNNING.md) for triggering runs, tests, and the end-to-end smoke test.
