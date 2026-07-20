import { useState, useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft, GitBranch, RefreshCw, Download, Plus, Clock, Webhook, Hand, Zap,
  GitCommitHorizontal, AlertTriangle, ShieldCheck, FileArchive, ArrowRight, CheckCircle2, Trash2,
} from "lucide-react";
import { findProject, exportBundle, nodeKindCounts, type Trigger, type Project, type ReconcileEvent, type DiffEntry, type Workflow } from "../lib/mock";
import { KindIcon, kindAccent } from "../graph/MillNode";
import { SyncBadge, HealthBadge, StatusPill } from "../components/Badges";
import { InfoTip, Tip } from "../components/InfoTip";
import { Modal, Drawer, Toggle, DiffRow, Spec, useToast, Toast } from "../components/Kit";
import { useLiveStatus } from "../lib/useLive";
import { LIVE, reconcileNow, deleteWorkflow, getReconcileEvents, getDiff, getEndpoints, type ReconcileEventLive, type DiffEntryLive, type ProjectEndpoints } from "../lib/api";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function relTime(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function toReconEvent(e: ReconcileEventLive): ReconcileEvent {
  const kind: ReconcileEvent["kind"] = e.error ? "error" : e.sync === "Synced" ? "apply" : "fetch";
  const detail = e.error
    ? e.error
    : e.sync === "Synced"
      ? `applied ${(e.syncedRevision || "").slice(0, 7)} — Synced/${e.health}`
      : `fetched ${(e.targetRevision || "").slice(0, 7)} — ${e.sync}`;
  return { time: relTime(e.at), kind, detail, revision: (e.syncedRevision || e.targetRevision || "").slice(0, 7) };
}
function toDiffEntry(d: DiffEntryLive): DiffEntry {
  const change: DiffEntry["change"] = d.change === "deleted" ? "removed" : d.change === "added" ? "added" : "modified";
  return { path: d.path, change, summary: "" };
}

function TriggerChip({ t }: { t: Trigger }) {
  const icon =
    t.type === "cron" ? <Clock className="h-3 w-3" /> :
    t.type === "webhook" ? <Webhook className="h-3 w-3" /> :
    t.type === "event" ? <Zap className="h-3 w-3" /> :
    <Hand className="h-3 w-3" />;
  return (
    <span className="chip bg-white/5 text-slate-300" title={`${t.type} ${t.detail}`}>
      {icon}
      {t.type === "manual" ? "manual" : t.detail}
    </span>
  );
}

function StepBreakdown({ w }: { w: Workflow }) {
  const counts = nodeKindCounts(w);
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={`steps-${w.id}`} title={`${w.nodes.length} nodes`}>
      <span className="text-[11px] text-slate-500">{w.nodes.length} steps:</span>
      {counts.map((c) => (
        <span key={c.kind} className={`chip px-1.5 py-0 text-[10px] ${kindAccent[c.kind].bg} ${kindAccent[c.kind].text}`} title={c.kind}>
          <KindIcon kind={c.kind} className="h-3 w-3" />
          {c.count}
        </span>
      ))}
    </span>
  );
}

export function ProjectPage() {
  const { projectId } = useParams();
  // Live mode uses ONLY controller data; the mock catalogue is for the /prototype build.
  const mockProject = LIVE ? undefined : findProject(projectId);
  const [showReconcile, setShowReconcile] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showNewWf, setShowNewWf] = useState(false);
  const [policy, setPolicy] = useState({ autoSync: mockProject?.autoSync ?? false, selfHeal: mockProject?.selfHeal ?? false, prune: mockProject?.prune ?? false });
  const { toast, flash } = useToast();
  const { status, reload, ready } = useLiveStatus();

  // Live reconcile activity + sync diff from the controller.
  const [liveRecon, setLiveRecon] = useState<ReconcileEvent[]>([]);
  const [liveDiff, setLiveDiff] = useState<DiffEntry[]>([]);
  const [endpoints, setEndpoints] = useState<ProjectEndpoints | null>(null);
  useEffect(() => {
    if (!LIVE || !projectId) return;
    let on = true;
    const load = () => {
      getReconcileEvents().then((r) => { if (on) setLiveRecon(r.events.map(toReconEvent)); }).catch(() => {});
      getDiff(projectId).then((r) => { if (on) setLiveDiff((r.diff ?? []).map(toDiffEntry)); }).catch(() => {});
    };
    load();
    getEndpoints(projectId).then((e) => { if (on) setEndpoints(e); }).catch(() => {});
    const t = setInterval(load, 5000);
    return () => { on = false; clearInterval(t); };
  }, [projectId]);

  // In Live mode, overlay real GitOps status from the controller onto the header + workflows.
  const liveProject = ready ? status?.projects?.find((p) => p.id === projectId) : undefined;
  const live = !!liveProject;

  // A live-only project (in git but not the mock catalogue, e.g. `demos`) has no mock
  // entry — synthesize a shell from the controller's status so the page renders.
  const project: Project | undefined = mockProject ?? (liveProject
    ? {
        id: liveProject.id,
        name: liveProject.id.charAt(0).toUpperCase() + liveProject.id.slice(1),
        description: "GitOps project — live from the controller.",
        repo: "git-backed workspace",
        branch: "main",
        revision: (status?.targetRevision ?? "").slice(0, 7),
        syncedRevision: (status?.syncedRevision ?? "").slice(0, 7),
        behindBy: 0,
        sync: status?.sync ?? "OutOfSync",
        health: liveProject.health,
        autoSync: true,
        selfHeal: true,
        prune: false,
        credentialRef: "k8s Secret",
        workflows: [],
      }
    : undefined);

  if (!project) {
    // In live mode a missing project usually means the controller status hasn't loaded yet.
    return LIVE && !ready
      ? <div className="flex items-center gap-2 text-sm text-slate-400" data-testid="project-connecting">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/10 border-t-brand-400" /> Connecting to the controller…
        </div>
      : <div className="text-slate-400" data-testid="project-not-found">Project not found.</div>;
  }

  const effSync = live ? (status!.sync ?? "OutOfSync") : project.sync;
  const effHealth = live ? liveProject!.health : project.health;
  const effTarget = live ? (status!.targetRevision ?? "").slice(0, 7) : project.revision;
  const effSynced = live ? (status!.syncedRevision ?? "").slice(0, 7) : project.syncedRevision;
  const effBehind = live ? (effTarget !== effSynced ? 1 : 0) : project.behindBy;
  const badCommit = live ? (status?.error ? { revision: effTarget, error: status.error } : undefined) : project.badCommit;

  async function doSync() {
    if (!LIVE) { setShowReconcile(true); return; }
    flash("Reconciling…");
    try { await reconcileNow(); await reload(); flash("Reconcile complete"); } catch { flash("reconcile failed"); }
  }

  async function onDeleteWorkflow(name: string) {
    if (!window.confirm(`Delete workflow "${name}"? This commits a deletion to your git repo.`)) return;
    flash(`Deleting ${name}…`);
    try { await deleteWorkflow(project!.id, name); await reload(); flash(`Deleted ${name}`); }
    catch (e) { flash(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  return (
    <div className="space-y-6" data-testid="project-page">
      <Link to="/workspace" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200">
        <ArrowLeft className="h-4 w-4" /> Workspace
      </Link>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-white">{project.name}</h1>
            <p className="mt-1 text-sm text-slate-400">{project.description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <GitBranch className="h-3.5 w-3.5" />
              <span className="font-mono">{project.repo}</span>
              <span className="font-mono">· {project.branch}@{project.revision}</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-1.5">
              <SyncBadge status={effSync} />
              <HealthBadge health={effHealth} />
              {live && <span className="chip bg-emerald-500/15 text-[10px] text-emerald-300">live</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-xs text-slate-400" data-testid="autosync-state">
                Auto-sync {policy.autoSync ? "on" : "off"}
                <InfoTip text="When auto-sync is on, new git revisions are applied automatically. Off requires clicking Sync." />
              </span>
              <Tip text="Reconcile now: fetch the target revision, validate + compile, and drive running triggers to match git.">
                <button className="btn-ghost" data-testid="sync-btn" onClick={doSync}>
                  <RefreshCw className="h-4 w-4" /> Sync
                </button>
              </Tip>
              <Tip text="GitOps details: the fetch/apply split, what a Sync would change, and recent reconcile activity.">
                <button className="btn-ghost" data-testid="gitops-btn" onClick={() => setShowReconcile(true)}>
                  <GitBranch className="h-4 w-4" /> GitOps
                </button>
              </Tip>
              <Tip text="Export this project as a standalone .tar.gz (YAML + JS + generated entrypoint) that runs on any JS runtime.">
                <button className="btn-ghost" data-testid="export-btn" onClick={() => { if (LIVE) { window.location.href = `/api/projects/${project.id}/export`; } else setShowExport(true); }}>
                  <Download className="h-4 w-4" /> Export
                </button>
              </Tip>
            </div>
          </div>
        </div>

        {/* desired vs live */}
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-white/5 bg-ink-950/40 px-4 py-3 text-xs">
          <span className="flex items-center gap-1.5 text-slate-400">
            Desired <span className="font-mono text-slate-200">{live ? "main" : project.branch}@{effTarget}</span>
            <InfoTip text="Desired state = the project repo at the tracked revision (branch HEAD, tag, or pinned commit)." />
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-slate-600" />
          <span className="flex items-center gap-1.5 text-slate-400">
            Live <span className="font-mono text-slate-200">@{effSynced}</span>
            <InfoTip text="Live state = registered triggers + the active compiled version actually dispatching runs. Almost entirely derived from git." />
          </span>
          {effBehind > 0 && (
            <span className="chip bg-amber-500/15 text-amber-300" data-testid="behind-by">
              <GitCommitHorizontal className="h-3.5 w-3.5" /> {effBehind} commit{effBehind === 1 ? "" : "s"} behind
            </span>
          )}
          <Spec doc="ARCH §5" />
        </div>
      </div>

      {/* ── Bad-commit / last-known-good ──────────────────────── */}
      {badCommit && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="card border-rose-500/20 bg-rose-500/[0.06] p-4" data-testid="bad-commit-banner">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
            <div className="text-sm">
              <div className="font-medium text-rose-200">
                Bad revision <span className="font-mono">{badCommit.revision}</span> — keeping last-known-good running
                <InfoTip text="A revision that fails to validate/compile/stay-healthy never takes down what works. Mill marks it Degraded and keeps the last-known-good version dispatching." />
              </div>
              <p className="mt-1 text-rose-200/70">{badCommit.error}</p>
            </div>
          </div>
        </motion.div>
      )}

      {/* ── GitOps status + policy ────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            Status model <InfoTip text="Two orthogonal axes (ArgoCD-style). A workflow can be Synced-but-Degraded. Project = worst-of-children rollup." /> <Spec doc="ARCH §5" />
          </h2>
          <div className="mt-3 space-y-3 text-xs text-slate-400">
            <div>
              <div className="font-medium text-slate-300">Sync axis</div>
              <p><span className="text-emerald-300">Synced</span> = applied == git · <span className="text-amber-300">OutOfSync</span> = git ahead</p>
            </div>
            <div>
              <div className="font-medium text-slate-300">Health axis</div>
              <p><span className="text-emerald-300">Healthy</span> · <span className="text-sky-300">Progressing</span> (sync in flight) · <span className="text-rose-300">Degraded</span> (invalid YAML / compile error / trigger not firing)</p>
            </div>
            <p className="text-slate-500">Worst-of-children rollup: one Degraded workflow surfaces at the project level.</p>
          </div>
        </div>

        <div className="card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            Sync policy <InfoTip text="Stored in project.yaml. Governs how the reconcile loop applies revisions." /> <Spec doc="ARCH §5" />
          </h2>
          <div className="mt-3 space-y-1">
            <PolicyRow label="autoSync" desc="Apply new revisions automatically vs a manual Sync click." checked={policy.autoSync} onChange={(v) => { setPolicy((p) => ({ ...p, autoSync: v })); flash(`autoSync ${v ? "enabled" : "disabled"}`); }} testid="policy-autosync" />
            <PolicyRow label="selfHeal" desc="Continuously correct drift back to git (nearly free — live is derived)." checked={policy.selfHeal} onChange={(v) => { setPolicy((p) => ({ ...p, selfHeal: v })); flash(`selfHeal ${v ? "enabled" : "disabled"}`); }} />
            <PolicyRow label="prune" desc="Deregister triggers removed from git — guarded by an allow-empty check." checked={policy.prune} onChange={(v) => { setPolicy((p) => ({ ...p, prune: v })); flash(`prune ${v ? "enabled" : "disabled"}`); }} guard />
          </div>
        </div>
      </div>

      {/* ── Endpoints (tokenized ingress) ─────────────────────── */}
      {LIVE && endpoints && <EndpointsCard endpoints={endpoints} onCopy={(u) => { navigator.clipboard?.writeText(u).catch(() => {}); flash("Endpoint URL copied"); }} />}

      {/* ── Workflows ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          Workflows
          <InfoTip label="workflows" text="A workflow (workload) is a DAG of JS code nodes. Output of one node flows to the next." />
        </h2>
        <Tip text="Create a new workflow. Saving commits a workflow.yaml + node .js files to the repo.">
          <button className="btn-primary" data-testid="new-workflow" onClick={() => setShowNewWf(true)}>
            <Plus className="h-4 w-4" /> New Workflow
          </button>
        </Tip>
      </div>

      <div className="space-y-3" data-testid="workflow-list">
        {live
          ? (liveProject!.workflows ?? []).map((w, i) => {
              const body = (
                <div className="card flex flex-wrap items-center justify-between gap-3 p-4 transition-shadow hover:glow">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">{cap(w.name)}</span>
                      <span className="chip bg-white/5 text-[10px] text-slate-400" title="Runs on the backend — click to open its graph, config & live logs">backend</span>
                    </div>
                    {w.error && <p className="mt-0.5 line-clamp-1 text-xs text-rose-300">{w.error}</p>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <SyncBadge status={effSync} />
                    <HealthBadge health={w.ok ? "Healthy" : "Degraded"} />
                    <button
                      type="button"
                      data-testid={`delete-workflow-${w.name}`}
                      title="Delete workflow (commits to git)"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDeleteWorkflow(w.name); }}
                      className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
              return (
                <motion.div key={w.name} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
                  <Link to={`/projects/${project!.id}/workflows/${w.name}`} data-testid={`workflow-row-${w.name}`} className="block">{body}</Link>
                </motion.div>
              );
            })
          : project.workflows.map((w, i) => (
              <motion.div key={w.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
                <Link
                  to={`/projects/${project.id}/workflows/${w.id}`}
                  data-testid={`workflow-row-${w.id}`}
                  className="card flex flex-wrap items-center justify-between gap-3 p-4 transition-shadow hover:glow"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">{w.name}</span>
                      <StatusPill status={w.lastRun} />
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-sm text-slate-400">{w.description}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {w.triggers.map((t, j) => (
                        <TriggerChip key={j} t={t} />
                      ))}
                      <span className="mx-1 text-slate-700">·</span>
                      <StepBreakdown w={w} />
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <SyncBadge status={w.sync} />
                    <HealthBadge health={w.health} />
                  </div>
                </Link>
              </motion.div>
            ))}
      </div>

      {/* ── Reconcile drawer ──────────────────────────────────── */}
      <Drawer
        open={showReconcile}
        onClose={() => setShowReconcile(false)}
        testid="reconcile-drawer"
        icon={<RefreshCw className="h-4 w-4 text-brand-400" />}
        title={<span className="flex items-center gap-2">Reconcile <Spec doc="ARCH §5" /></span>}
      >
        <ReconcilePanel
          project={project}
          diff={live ? liveDiff : (project.diff ?? [])}
          reconcile={live ? liveRecon : (project.reconcile ?? [])}
          onApply={() => { setShowReconcile(false); flash("Reconcile queued · fetch → validate → compile → atomic swap"); }}
        />
      </Drawer>

      {/* ── Export modal ──────────────────────────────────────── */}
      <Modal
        open={showExport}
        onClose={() => setShowExport(false)}
        testid="export-modal"
        wide
        icon={<FileArchive className="h-4 w-4 text-brand-400" />}
        title={<span className="flex items-center gap-2">Export {project.name} <Spec doc="ARCH §7" /></span>}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setShowExport(false)}>Cancel</button>
            <button className="btn-primary" data-testid="export-download" onClick={() => { setShowExport(false); flash(`Streaming ${project.id}.tar.gz …`); }}>
              <Download className="h-4 w-4" /> Download .tar.gz
            </button>
          </>
        }
      >
        <p className="text-xs text-slate-400">
          Definitions are already files, so export = the repo tree + a compiler-generated entrypoint, tarred and
          streamed (no object store). Production runs the <em>same</em> compiled program, so “works exported” == “works in Mill.”
        </p>
        <div className="mt-3 space-y-1.5" data-testid="export-bundle">
          {exportBundle.map((f) => (
            <div key={f.path} className="flex items-baseline gap-3 rounded-lg border border-white/5 bg-ink-950/50 px-3 py-1.5">
              <span className="font-mono text-xs text-slate-200">{f.path}</span>
              <span className="text-xs text-slate-500">{f.note}</span>
            </div>
          ))}
        </div>
      </Modal>

      {/* ── New workflow modal ────────────────────────────────── */}
      <Modal
        open={showNewWf}
        onClose={() => setShowNewWf(false)}
        testid="new-workflow-modal"
        icon={<Plus className="h-4 w-4 text-brand-400" />}
        title="New workflow"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setShowNewWf(false)}>Cancel</button>
            <button className="btn-primary" data-testid="new-workflow-create" onClick={() => { setShowNewWf(false); flash("Draft created · Save will commit workflow.yaml + nodes/"); }}>Create draft</button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-400">Creates an in-memory draft. Nothing is written until you Save, which commits a <span className="font-mono">workflow.yaml</span> + node <span className="font-mono">.js</span> files to the repo.</p>
          <label className="block">
            <div className="mb-1 text-xs font-medium text-slate-300">Name</div>
            <input className="inp" defaultValue="Refund Processor" />
          </label>
          <label className="block">
            <div className="mb-1 text-xs font-medium text-slate-300">First trigger</div>
            <select className="inp">
              <option>manual</option>
              <option>cron</option>
              <option>webhook</option>
              <option>event</option>
            </select>
          </label>
        </div>
      </Modal>

      <Toast toast={toast} icon={<GitCommitHorizontal className="h-4 w-4 text-brand-400" />} />
    </div>
  );
}

// ── Reconcile drawer body ─────────────────────────────────────────────────────
function EndpointsCard({ endpoints, onCopy }: { endpoints: ProjectEndpoints; onCopy: (url: string) => void }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const abs = (p: string) => `${origin}${p}`;
  const exposed = !!endpoints.projectPath; // ≥1 workflow opted in with a webhook trigger
  return (
    <div className="card p-4" data-testid="endpoints-card">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Webhook className="h-4 w-4 text-brand-400" /> Endpoints
        <InfoTip text="A workflow is exposed over HTTP only when it declares a webhook trigger — nothing is reachable until you configure it. Send the bearer token in an Authorization header. Add ?wait=1 for a synchronous result; omit it for a webhook-style { jobId }." />
      </h2>
      {!exposed ? (
        <div className="mt-2 rounded-lg border border-white/5 bg-ink-950/40 p-3 text-[11px] text-slate-400" data-testid="endpoints-none">
          No HTTP endpoints. This project isn't exposed to the outside world. Open a workflow and
          add a <span className="font-medium text-slate-300">webhook</span> trigger to give it a URL —
          manual, cron and event workflows run without one.
        </div>
      ) : (
        <>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
            {endpoints.authRequired
              ? <span className="chip bg-emerald-500/10 text-emerald-300"><ShieldCheck className="h-3 w-3" /> Bearer token required</span>
              : <span className="chip bg-amber-500/10 text-amber-300"><AlertTriangle className="h-3 w-3" /> ingress token not set — endpoints return 503 until MILL_INGRESS_TOKEN (or the project's ingress.tokenEnv) is set</span>}
            <span className="font-mono text-slate-500">Authorization: Bearer &lt;token&gt;</span>
          </div>
          <div className="mt-3 space-y-1.5">
            <EndpointRow label="project" url={abs(endpoints.projectPath!)} onCopy={onCopy} />
            {endpoints.workflows.map((w) => (
              <EndpointRow key={w.workflow} label={w.workflow} url={abs(w.path)} onCopy={onCopy} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
function EndpointRow({ label, url, onCopy }: { label: string; url: string; onCopy: (u: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-ink-950/40 px-2.5 py-1.5 text-[11px]" data-testid={`endpoint-${label}`}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="w-20 shrink-0 truncate text-slate-400">{label}</span>
        <span className="truncate font-mono text-slate-300">{url}</span>
      </span>
      <button type="button" data-testid={`copy-endpoint-${label}`} onClick={() => onCopy(url)} className="chip shrink-0 bg-white/5 text-slate-400 hover:text-slate-200"><FileArchive className="h-3 w-3" /> copy</button>
    </div>
  );
}

function ReconcilePanel({ project, onApply, diff, reconcile }: { project: Project; onApply: () => void; diff: DiffEntry[]; reconcile: ReconcileEvent[] }) {
  const synced = project.sync === "Synced";
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <SyncBadge status={project.sync} />
        <HealthBadge health={project.health} />
        <span className="ml-auto font-mono text-xs text-slate-400">{project.syncedRevision} → {project.revision}</span>
      </div>

      {/* fetch/apply split */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Fetch / apply split <InfoTip text="Flux's model: Phase A fetches + validates + compiles a revision into an immutable SHA-keyed artifact; Phase B reconciles running state toward it. Makes activation a pointer-swap and rollback a re-point." />
        </h3>
        <div className="space-y-1.5">
          <Phase n="A" title="Fetch + validate + compile" detail={`fetch ${project.branch}@${project.revision} · Zod-validate every workflow.yaml · bun build → SHA-keyed artifact`} done />
          <Phase n="B" title="Apply (idempotent, diff-and-apply)" detail="atomic active-version swap · register missing triggers · deregister removed · never blind re-create" done={synced} />
        </div>
      </div>

      {/* diff-and-apply plan */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Changes to apply <InfoTip text="Reconcile is level-triggered: a pure function of observed-vs-desired. This is the delta re-derived from scratch, not a reaction to one event." />
        </h3>
        {diff.length > 0 ? (
          <div className="space-y-1.5" data-testid="reconcile-diff">
            {diff.map((d) => (
              <DiffRow key={d.path} change={d.change} path={d.path} summary={d.summary} />
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
            <CheckCircle2 className="h-4 w-4" /> No drift — running state already matches git.
          </div>
        )}
      </div>

      {/* activity feed */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Reconcile activity <InfoTip text="Wake-ups: git webhook (instant) or ~3min poll + jitter (authoritative backstop). A webhook + poll landing together coalesce into one run; failures back off, they don't hot-loop." />
        </h3>
        <div className="space-y-1" data-testid="reconcile-feed">
          {reconcile.length ? reconcile.map((e, i) => (
            <ReconcileRow key={i} e={e} />
          )) : <p className="text-xs text-slate-500">No reconcile activity yet.</p>}
        </div>
      </div>

      <div className="rounded-xl border border-white/5 bg-ink-950/40 p-3 text-xs text-slate-400">
        <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-emerald-300" />
        In-flight jobs are never killed by a reconcile — they finish on their pinned version. Only future dispatch uses the new revision.
      </div>

      <button className="btn-primary w-full justify-center" data-testid="reconcile-apply" onClick={onApply} disabled={synced}>
        <RefreshCw className="h-4 w-4" /> {synced ? "Already synced" : "Sync now"}
      </button>
    </div>
  );
}

function Phase({ n, title, detail, done }: { n: string; title: string; detail: string; done?: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-white/5 bg-ink-950/50 px-3 py-2">
      <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-semibold ${done ? "bg-emerald-500/20 text-emerald-300" : "bg-white/10 text-slate-400"}`}>{n}</span>
      <div className="min-w-0">
        <div className="text-xs font-medium text-slate-200">{title}</div>
        <div className="font-mono text-[11px] leading-relaxed text-slate-500">{detail}</div>
      </div>
    </div>
  );
}

const kindStyle: Record<ReconcileEvent["kind"], string> = {
  webhook: "text-sky-300",
  poll: "text-slate-300",
  fetch: "text-slate-300",
  compile: "text-brand-300",
  apply: "text-emerald-300",
  coalesce: "text-indigo-300",
  backoff: "text-amber-300",
  error: "text-rose-300",
};

function ReconcileRow({ e }: { e: ReconcileEvent }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="w-16 shrink-0 text-right font-mono text-[10px] text-slate-600">{e.time}</span>
      <span className={`w-16 shrink-0 font-mono uppercase ${kindStyle[e.kind]}`}>{e.kind}</span>
      <span className="text-slate-400">{e.detail}{e.revision && <span className="ml-1 font-mono text-slate-600">@{e.revision}</span>}</span>
    </div>
  );
}

function PolicyRow({ label, desc, checked, onChange, testid, guard }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void; testid?: string; guard?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <span className="font-mono text-xs text-slate-200">{label}</span>
        {guard && <span className="ml-2 chip bg-emerald-500/10 text-[10px] text-emerald-300">allow-empty guard</span>}
        <p className="text-xs text-slate-500">{desc}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} testid={testid} />
    </div>
  );
}
