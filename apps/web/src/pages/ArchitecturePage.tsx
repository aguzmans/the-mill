import { motion } from "framer-motion";
import { Boxes, Database, Server, Cpu, GitBranch, Radio, LineChart, Lightbulb } from "lucide-react";
import { InfoTip } from "../components/InfoTip";
import { Spec } from "../components/Kit";

const theses = [
  { t: "A workflow compiles to one JS program", d: "The generated entrypoint topologically walks the DAG. The same artifact runs in the editor, ships to a worker, and exports standalone. Editor engine = server engine = export format — one compiler." },
  { t: "Definitions are files in git, not DB rows", d: "The repo is the source of truth and the export simultaneously. There is no SQL database." },
  { t: "Running state is reconciled toward git", d: "Like ArgoCD, a control loop compares desired (git) with live (triggers + active versions) and drives them together, with sync/health status and auto-sync." },
];

const noDb = [
  { give: "Cross-cutting queries (list/search)", verdict: "Controller's in-memory index, rebuilt from the working tree. Thousands index in ms." },
  { give: "Concurrent-write transactions", verdict: "Not needed: single controller; writes are git commits with optimistic revision checks." },
  { give: "Referential integrity (FKs)", verdict: "The compiler validates the DAG (every edge → a real node) — stronger than FKs." },
  { give: "Version history", verdict: "Git does it better: diff, blame, rollback, branch, PRs — also the GitOps substrate." },
];

const k8s = [
  { concern: "API · UI · worker pool", approach: "Deployments", why: "Long-running — what Deployments are for" },
  { concern: "UI routing · webhooks · TLS · SSO", approach: "Ingress (+ cert-manager)", why: "SSO terminated at the ingress; flat access (no roles) in v1" },
  { concern: "Worker autoscaling", approach: "HPA (memory/CPU) + Cluster Autoscaler", why: "Scale on resource pressure; no KEDA. Dynamic per-worker min–max concurrency" },
  { concern: "Secrets · quotas", approach: "Native K8s", why: "Program + GitHub-cred secrets as k8s Secrets; flat access, RBAC later" },
  { concern: "Scheduling (cron)", approach: "App-level BullMQ (CronJob optional)", why: "Fine-grained, no API-server pressure" },
  { concern: "Per-node execution", approach: "Warm worker pool (nsjail)", why: "ms not seconds; live logs" },
  { concern: "Run state / history", approach: "Redis + Loki/Prom/Tempo — never etcd/CRDs", why: "Avoids the etcd-bloat trap" },
];

const decisions = [
  { c: "Runtime (workers)", choice: "Bun", why: "Fast; built-in bundler + package manager (ideal for export)" },
  { c: "Control plane", choice: "TypeScript/Bun", why: "I/O-bound; shares core schema + bun build compiler + BullMQ" },
  { c: "API framework", choice: "Hono on Bun", why: "Portable, mature, tiny" },
  { c: "Definitions store", choice: "Git repo (YAML + .js)", why: "Source of truth, export, GitOps substrate in one" },
  { c: "GitOps", choice: "Custom reconcile loop + git CLI", why: "ArgoCD-style; git CLI covers SSH/shallow/partial/sparse" },
  { c: "Live state", choice: "Redis (BullMQ + pub/sub)", why: "Queue, registry, sync state, recent results — ephemeral" },
  { c: "History / telemetry", choice: "Loki / Prometheus / Tempo via Alloy", why: "Everything historical is logged" },
  { c: "Isolation (now)", choice: "Bun subprocess + nsjail", why: "OS-level (in-process isolates impossible on Bun)" },
];

export function ArchitecturePage() {
  return (
    <div className="space-y-6" data-testid="architecture-page">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
          Architecture
          <InfoTip text="An in-app reference for design review. Every screen in this prototype traces back to these decisions (see the §-chips)." />
        </h1>
        <p className="mt-1 text-sm text-slate-400">A GitOps-native workflow platform: a project is a git repo of YAML + JS; a reconciler drives running state toward git.</p>
      </div>

      {/* three theses */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {theses.map((x, i) => (
          <motion.div key={x.t} className="card p-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <div className="mb-1 flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-500/20 text-xs font-semibold text-brand-200">{i + 1}</span>
              <Spec doc="ARCH §1" />
            </div>
            <div className="text-sm font-medium text-white">{x.t}</div>
            <p className="mt-1 text-xs text-slate-400">{x.d}</p>
          </motion.div>
        ))}
      </div>

      {/* topology */}
      <div className="card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Boxes className="h-4 w-4 text-slate-400" /> Topology
          <InfoTip text="One namespace, ~4 Mill containers, reusing your existing Grafana stack. The controller owns the git working copy + reconcile loop; workers are stateless." />
          <Spec doc="ARCH §2" />
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-5">
          <TopoBox icon={<GitBranch className="h-4 w-4" />} title="Git remote" sub="desired state (YAML + JS)" tone="brand" />
          <TopoBox icon={<Server className="h-4 w-4" />} title="Controller (API)" sub="1 replica · git working copy · index · reconciler · compile · export" tone="brand" wide />
          <TopoBox icon={<Radio className="h-4 w-4" />} title="Redis" sub="queue · registry · sync state (ephemeral)" tone="slate" />
          <TopoBox icon={<Cpu className="h-4 w-4" />} title="Worker fleet" sub="N replicas · stateless · isolated Executor" tone="slate" />
          <TopoBox icon={<LineChart className="h-4 w-4" />} title="Alloy → Loki/Prom/Tempo" sub="logs · metrics · traces · Grafana" tone="slate" />
        </div>
        <p className="mt-3 text-xs text-slate-500">Browser talks REST + WS to the controller (renders from git). Enqueued jobs carry the compiled bundle; workers stream status/logs back via Redis and emit telemetry to Alloy.</p>
      </div>

      {/* no DB + k8s */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Database className="h-4 w-4 text-slate-400" /> Why no database
            <InfoTip text="A relational DB for definitions would buy four things; none survive here. Net: zero SQL databases, fewer containers, no migrations." />
            <Spec doc="ARCH §4" />
          </h2>
          <div className="mt-3 space-y-2">
            {noDb.map((r) => (
              <div key={r.give} className="rounded-lg border border-white/5 bg-ink-950/40 p-2.5 text-xs">
                <div className="font-medium text-slate-300">{r.give}</div>
                <div className="text-slate-500">{r.verdict}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Boxes className="h-4 w-4 text-slate-400" /> K8s strategy
            <InfoTip text="Reuse K8s primitives for infra; keep orchestration app-level for the hot path. We did NOT adopt Argo Workflows as the engine (pod-per-step latency, etcd limits, breaks standalone export)." />
            <Spec doc="ARCH §9" />
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <tbody>
                {k8s.map((r) => (
                  <tr key={r.concern} className="border-b border-white/5 last:border-0">
                    <td className="py-1.5 pr-3 text-slate-300">{r.concern}</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-400">{r.approach}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* tech decisions */}
      <div className="card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Lightbulb className="h-4 w-4 text-slate-400" /> Tech decisions
          <Spec doc="ARCH §11" />
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-white/5">
                <th className="py-2 pr-3 font-medium">Concern</th>
                <th className="py-2 pr-3 font-medium">Choice</th>
                <th className="py-2 pr-3 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((r) => (
                <tr key={r.c} className="border-b border-white/5 last:border-0">
                  <td className="py-2 pr-3 text-slate-300">{r.c}</td>
                  <td className="py-2 pr-3 font-mono text-brand-200">{r.choice}</td>
                  <td className="py-2 pr-3 text-slate-400">{r.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TopoBox({ icon, title, sub, tone, wide }: { icon: React.ReactNode; title: string; sub: string; tone: "brand" | "slate"; wide?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${wide ? "md:col-span-1" : ""} ${tone === "brand" ? "border-brand-500/30 bg-brand-500/10" : "border-white/10 bg-ink-950/40"}`}>
      <div className={`flex items-center gap-1.5 text-xs font-medium ${tone === "brand" ? "text-brand-200" : "text-slate-200"}`}>{icon}{title}</div>
      <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{sub}</div>
    </div>
  );
}
