# acuity — exported from Mill

A standalone bundle. Runs the same compiled program Mill runs. **`run.sh` does everything
required** — it checks for Bun, installs npm dependencies on first run, then executes. You
only need Bun installed (`curl -fsSL https://bun.sh/install | bash`).

## Run (batch — some jobs just run)
```bash
./run.sh create-invoice '{}'      # runs once, prints the result
./run.sh                          # runs the first workflow with {} input
```

## Serve as an HTTP API (others expose a port)
```bash
./run.sh serve 8080
curl -s localhost:8080/health                       # → { ok, workflows: [...] }
curl -s -XPOST localhost:8080/run/create-invoice -d '{}'   # → { status, result }
```
`POST /run/<workflow>` (alias `/hooks/<workflow>`) runs a workflow with the JSON body as
input — the same entrypoint a webhook trigger would hit.

Workflows: create-invoice, crm-upsert, intake, send-confirmation.
Secrets are read from the environment (each node sees only the refs it declares).
