# Mill — Observability Runbook

What to scrape, what each signal means, and the alerts + dashboards to build. Mill stores no
history itself — it **exposes** metrics (Prometheus) and **emits** structured logs; your stack
(Prometheus/Alloy → Grafana/Loki/Tempo) does the storing, dashboarding, and alerting.

## Scrape

`GET /api/metrics` — Prometheus text format (`text/plain; version=0.0.4`). Open even when the
admin token is set (see security note). Example scrape config:

```yaml
scrape_configs:
  - job_name: mill-controller
    metrics_path: /api/metrics
    scrape_interval: 15s
    static_configs: [{ targets: ["mill-api:8080"] }]
    # if MILL_ADMIN_TOKEN is set, /api/metrics stays open; to lock it too, add:
    # authorization: { type: Bearer, credentials: "<MILL_ADMIN_TOKEN>" }
```

One controller replica exposes the whole workspace's metrics (it aggregates the queue +
worker registry from Redis), so you scrape the controller, not each worker.

## Metric catalog

### Counters — `rate()`/`increase()` these
| Metric | Labels | Meaning |
|---|---|---|
| `mill_jobs_total` | `status` (succeeded\|failed\|cancelled) | Jobs finished. Success ratio, failure rate. |
| `mill_jobs_failed_total` | `reason` (workflow_not_found\|compile_error\|schema_validation\|timeout\|network\|bundle_missing\|node_error\|unknown) | **Failures bucketed by cause.** `workflow_not_found` = worker can't materialize the bundle (missing `/tmp` / bundle gone); `bundle_missing` = Redis bundle expired; `timeout`/`network` = a node's outbound call. **This is the first thing to look at when jobs fail.** |
| `mill_jobs_by_workflow_total` | `workflow`, `status` | Per-workflow throughput + failures. |
| `mill_triggered_total` | `trigger` (manual\|cron\|webhook\|event) | Jobs enqueued, by how they started. |
| `mill_retries_total` | — | Run-level retries (Re-run / `/jobs/:id/retry`). |
| `mill_jobs_reclaimed_total` | — | Jobs a **restarted worker reclaimed** from its own processing list (same-id restart). Non-zero ⇒ workers are crashing/restarting mid-job. |
| `mill_jobs_reaped_total` | — | Jobs the **reaper requeued** from workers whose heartbeat expired (a worker crashed/was killed). Pairs with the above for crash-recovery visibility. |
| `mill_reconcile_total` | `result` (applied\|held\|degraded\|nochange) | GitOps reconcile passes by outcome. |
| `mill_ingress_total` | `outcome` (ok\|unauthorized\|disabled) | Tokenized-ingress (`/p`) requests. |
| `mill_ingress_auth_failures_total` | — | Bearer auth failures — **security signal**. |
| `mill_concurrency_skipped_total` | `policy` (Forbid\|Replace) | Cron runs skipped because one was already in progress. |
| `mill_concurrency_replaced_total` | `policy` (Replace) | Queued runs superseded so the newest wins. |
| `mill_dispatch_skipped_total` | `reason` (compile_error) | Triggers dropped because the workflow won't compile — **a broken workflow shipped; alert on this**. |

### Histograms — real quantiles via `histogram_quantile()`
| Metric | Meaning |
|---|---|
| `mill_job_duration_seconds` | Job execution time (`_bucket`/`_sum`/`_count`). |
| `mill_job_wait_seconds` | Schedule→start wait (queue latency). |

### Gauges — current state
| Metric | Meaning |
|---|---|
| `mill_workers` | Workers registered (heartbeating). Compare to the desired replica count — fewer ⇒ pods not registering. |
| `mill_worker_info` | **1 per heartbeating pod**, labels `worker_id`, `host`, `executor`. `count(mill_worker_info)` should equal your worker replica count; a table of these = "which pods are live". |
| `mill_workers_inflight` | Jobs executing across the fleet. |
| `mill_worker_capacity` | Total concurrent job slots (Σ per-worker `concMax`) — fleet ceiling. |
| `mill_worker_saturation_ratio` | Busy fraction `inflight / capacity` (0..1). |
| `mill_queue_depth` | Jobs waiting — **primary autoscaling signal** (= `LLEN mill:queue`). |
| `mill_queue_oldest_wait_seconds` | Age of the head-of-line job — **backlog / SLA signal**. |
| `mill_reconcile_synced` / `mill_reconcile_healthy` | 1/0 — GitOps state. |
| `mill_reconcile_age_seconds` | Seconds since the last reconcile — **liveness of the loop**. |

> **Autoscaling the worker fleet:** drive HPA/KEDA off `mill_queue_depth` (and
> `mill_queue_oldest_wait_seconds` as a latency guard) rather than CPU/memory — a pull queue
> only looks busy *after* work is claimed, so resource metrics lag the backlog. See
> **[DEPLOYMENT.md → Autoscale on queue depth](DEPLOYMENT.md#autoscale-on-queue-depth-custom-metrics--recommended)**.

## Recommended alerts (PromQL)

```yaml
groups:
- name: mill
  rules:
  # Elevated job failure rate (>10% over 10m)
  - alert: MillHighJobFailureRate
    expr: sum(rate(mill_jobs_total{status="failed"}[10m])) / clamp_min(sum(rate(mill_jobs_total[10m])), 0.001) > 0.10
    for: 10m
    labels: { severity: warning }
    annotations: { summary: ">10% of Mill jobs failing" }

  # Queue backing up — head-of-line waiting too long
  - alert: MillQueueBacklog
    expr: mill_queue_oldest_wait_seconds > 300
    for: 5m
    labels: { severity: warning }
    annotations: { summary: "Head-of-line job waiting >5m — scale workers" }

  # No workers registered
  - alert: MillNoWorkers
    expr: mill_workers == 0
    for: 2m
    labels: { severity: critical }
    annotations: { summary: "No Mill workers heartbeating" }

  # A broken workflow shipped — triggers are being dropped because it won't compile
  - alert: MillBrokenWorkflow
    expr: increase(mill_dispatch_skipped_total[15m]) > 0
    for: 5m
    labels: { severity: warning }
    annotations: { summary: "A workflow won't compile — its triggers are being dropped (check reconcile health)" }

  # Reconcile loop stalled (no pass in 5m; interval is ~15s)
  - alert: MillReconcileStalled
    expr: mill_reconcile_age_seconds > 300
    for: 1m
    labels: { severity: critical }
    annotations: { summary: "GitOps reconcile loop has stalled" }

  # Drifted from git (Synced=0) for too long
  - alert: MillOutOfSync
    expr: mill_reconcile_synced == 0
    for: 15m
    labels: { severity: warning }
    annotations: { summary: "Running state has been OutOfSync with git >15m" }

  # p95 job latency regression
  - alert: MillSlowJobs
    expr: histogram_quantile(0.95, sum(rate(mill_job_duration_seconds_bucket[10m])) by (le)) > 30
    for: 10m
    labels: { severity: warning }
    annotations: { summary: "p95 job duration >30s" }

  # Possible credential probing on the ingress
  - alert: MillIngressAuthFailures
    expr: rate(mill_ingress_auth_failures_total[5m]) > 1
    for: 5m
    labels: { severity: warning }
    annotations: { summary: "Sustained ingress bearer-auth failures" }

  # Every run fails at bundle-materialization — worker missing a writable /tmp or the bundle
  # cache is gone. This is the single most common "nothing runs" cause; alert loudly.
  - alert: MillWorkersCantMaterialize
    expr: increase(mill_jobs_failed_total{reason=~"workflow_not_found|bundle_missing"}[10m]) > 0
    for: 5m
    labels: { severity: critical }
    annotations: { summary: "Workers can't load workflows (no writable /tmp or missing bundle) — see DEPLOYMENT §6" }

  # Registered workers < desired replicas ⇒ pods not registering (colliding ids, can't reach Redis).
  - alert: MillWorkersUnderReplicas
    expr: count(mill_worker_info) < <desired_worker_replicas>
    for: 10m
    labels: { severity: warning }
    annotations: { summary: "Fewer workers registered than replicas" }

  # Crash-recovery is firing — workers are dying mid-job and their work is being requeued.
  - alert: MillWorkerCrashRecovery
    expr: increase(mill_jobs_reclaimed_total[15m]) + increase(mill_jobs_reaped_total[15m]) > 0
    for: 5m
    labels: { severity: warning }
    annotations: { summary: "Workers crashing/restarting mid-job (jobs reclaimed/reaped)" }
```

## Dashboard panels

Suggested Grafana rows (all from `/api/metrics` via Prometheus):

**Overview**
- **Throughput** — `sum(rate(mill_jobs_total[5m]))`, split by `status` (incl. `cancelled`).
- **Success ratio** — `sum(rate(mill_jobs_total{status="succeeded"}[5m])) / sum(rate(mill_jobs_total[5m]))`.
- **Latency** — `histogram_quantile(0.5|0.95|0.99, sum(rate(mill_job_duration_seconds_bucket[5m])) by (le))`.
- **Queue latency** — `histogram_quantile(0.95, sum(rate(mill_job_wait_seconds_bucket[5m])) by (le))`.

**Failures (start here when something's red)**
- **Failures by reason** — `sum by (reason) (rate(mill_jobs_failed_total[15m]))` (stacked bars + a table). Instantly separates infra (`workflow_not_found`/`bundle_missing`), egress (`timeout`/`network`), and workflow bugs (`compile_error`/`schema_validation`/`node_error`).
- **Top failing workflows** — `topk(10, sum by (workflow) (rate(mill_jobs_by_workflow_total{status="failed"}[15m])))`.

**Fleet & reliability**
- **Workers** — stat `count(mill_worker_info)` vs desired replicas; table of `mill_worker_info` (`worker_id`, `host`, `executor`).
- **Saturation** — `mill_worker_saturation_ratio`, `mill_workers_inflight` / `mill_worker_capacity`.
- **Crash recovery** — `increase(mill_jobs_reclaimed_total[$__range])` + `increase(mill_jobs_reaped_total[$__range])` (should be flat at 0).

**Queue / autoscaling**
- **Queue** — `mill_queue_depth` and `mill_queue_oldest_wait_seconds` (the KEDA/HPA signals).

**GitOps & triggers**
- **GitOps** — `mill_reconcile_synced`, `mill_reconcile_healthy`, `mill_reconcile_age_seconds`, and `rate(mill_reconcile_total[15m])` by `result`.
- **Triggers** — `sum by (trigger) (rate(mill_triggered_total[5m]))`; **security**: `rate(mill_ingress_auth_failures_total[5m])`, `rate(mill_dispatch_skipped_total[15m])`.

## Logs & traces

Mill **exposes** metrics (above) and **emits** structured logs. It does **not** emit OTel spans
today, so Tempo has nothing to store yet — plan the dashboard around **Prometheus + Loki**.

- **Logs (Loki)** — api + worker emit **structured JSON** (`{ts, level, component, msg, …fields}`,
  token-redacted). Ship with Alloy → Loki. Useful fields to index/query: `component` (`api`|`worker`),
  `workflow`, `job` (the job id), `workerId`, `level`, `error`, `ms`. `MILL_LOG_FORMAT=json` forces
  JSON in a TTY; `MILL_LOG_LEVEL` sets the floor.
- **Correlation without Tempo** — a run's story lives across metrics + logs + the app's own event
  stream. To trace one run end-to-end, pivot on the **job id**: `{app="mill"} | json | job="job_xxxx"`
  in Loki shows every node's `[<node>] running/succeeded/failed (…ms)` line + errors, in order —
  the same per-node events the UI streams over SSE (`GET /api/jobs/:id/events`). A Grafana Explore
  split (Prometheus latency panel ↔ Loki job logs) covers what a trace would, keyed on the job id.
- **Traces (Tempo) — roadmap.** The intended shape: one run = one trace, each node = a span, via
  OTel. The telemetry layer is a thin wrapper (`packages/telemetry`) designed for a drop-in
  pino + OpenTelemetry swap; wiring OTel exporters there + emitting a span per node is the future
  work to light up Tempo. Until then, use the job-id correlation above.

## Security note

`/api/metrics` is intentionally left open even when `MILL_ADMIN_TOKEN` is set, so Prometheus
can scrape without credentials on a trusted network. If `/api/metrics` is reachable from an
untrusted network, either put it behind the same authenticating proxy as the rest of `/api/*`
and add a `bearer_token` to the scrape config, or expose metrics on a separate internal-only route.
