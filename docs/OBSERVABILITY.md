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
| `mill_jobs_total` | `status` (succeeded\|failed) | Jobs finished. Success ratio, failure rate. |
| `mill_jobs_by_workflow_total` | `workflow`, `status` | Per-workflow throughput + failures. |
| `mill_triggered_total` | `trigger` (manual\|cron\|webhook\|event) | Jobs enqueued, by how they started. |
| `mill_retries_total` | — | Run-level retries (Re-run / `/jobs/:id/retry`). |
| `mill_reconcile_total` | `result` (applied\|held\|degraded\|nochange) | GitOps reconcile passes by outcome. |
| `mill_ingress_total` | `outcome` (ok\|unauthorized\|disabled) | Tokenized-ingress (`/p`) requests. |
| `mill_ingress_auth_failures_total` | — | Bearer auth failures — **security signal**. |

### Histograms — real quantiles via `histogram_quantile()`
| Metric | Meaning |
|---|---|
| `mill_job_duration_seconds` | Job execution time (`_bucket`/`_sum`/`_count`). |
| `mill_job_wait_seconds` | Schedule→start wait (queue latency). |

### Gauges — current state
| Metric | Meaning |
|---|---|
| `mill_workers` | Workers registered (heartbeating). |
| `mill_workers_inflight` | Jobs executing across the fleet. |
| `mill_queue_depth` | Jobs waiting. |
| `mill_queue_oldest_wait_seconds` | Age of the head-of-line job — **backlog signal**. |
| `mill_reconcile_synced` / `mill_reconcile_healthy` | 1/0 — GitOps state. |
| `mill_reconcile_age_seconds` | Seconds since the last reconcile — **liveness of the loop**. |

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
```

## Dashboard panels

- **Throughput** — `sum(rate(mill_jobs_total[5m]))`, split by `status`.
- **Success ratio** — `sum(rate(mill_jobs_total{status="succeeded"}[5m])) / sum(rate(mill_jobs_total[5m]))`.
- **Latency** — `histogram_quantile(0.5|0.95|0.99, sum(rate(mill_job_duration_seconds_bucket[5m])) by (le))`.
- **Queue** — `mill_queue_depth` and `mill_queue_oldest_wait_seconds`.
- **Fleet** — `mill_workers`, `mill_workers_inflight`.
- **By workflow** — `topk(10, sum by (workflow) (rate(mill_jobs_by_workflow_total{status="failed"}[15m])))`.
- **GitOps** — `mill_reconcile_synced`, `mill_reconcile_healthy`, `mill_reconcile_age_seconds`, and `rate(mill_reconcile_total[15m])` by `result`.
- **Triggers** — `sum by (trigger) (rate(mill_triggered_total[5m]))`.

## Logs & traces

- **Logs** — api + worker emit **structured JSON** (`{ts, level, component, msg, …fields}`,
  token-redacted). Ship with Alloy → Loki; query by `component`, `workflow`, `job`, `level`.
  `MILL_LOG_FORMAT=json` forces JSON in a TTY; `MILL_LOG_LEVEL` sets the floor.
- **Traces** — planned: a run = one trace, each node = a span, exported via OTel → Tempo.
  The metrics + structured logs above are the pieces available today.

## Security note

`/api/metrics` is intentionally left open even when `MILL_ADMIN_TOKEN` is set, so Prometheus
can scrape without credentials on a trusted network. If `/api/metrics` is reachable from an
untrusted network, either put it behind the same authenticating proxy as the rest of `/api/*`
and add a `bearer_token` to the scrape config, or expose metrics on a separate internal-only route.
