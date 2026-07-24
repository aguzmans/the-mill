import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { GitBranch, Plus, FolderGit2, Workflow as WorkflowIcon, GitCommitHorizontal, KeyRound, Trash2, UploadCloud } from "lucide-react";
import { workspace, projects } from "../lib/mock";
import { SyncBadge, HealthBadge } from "../components/Badges";
import { InfoTip, Tip } from "../components/InfoTip";
import { Modal, Toggle, Spec, useToast, Toast } from "../components/Kit";
import { ImportFlowModal } from "../components/ImportFlowModal";
import { useLiveStatus } from "../lib/useLive";
import { LIVE, deleteProject, createProject } from "../lib/api";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function WorkspacePage() {
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [selfHeal, setSelfHeal] = useState(true);
  const [prune, setPrune] = useState(false);
  const { toast, flash } = useToast();
  const { status, ready, reload } = useLiveStatus();

  async function onDeleteProject(id: string) {
    if (!window.confirm(`Delete project "${id}"? This commits a deletion to your git repo.`)) return;
    flash(`Deleting ${id}…`);
    try { await deleteProject(id); await reload(); flash(`Deleted ${id}`); }
    catch (e) { flash(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const [npId, setNpId] = useState("");
  const [creating, setCreating] = useState(false);
  async function onCreateProject() {
    if (!LIVE) { setShowNew(false); flash("Project registered · reconciler will clone + index it"); return; }
    const id = npId.trim().toLowerCase();
    if (!id) { flash("Enter a project name"); return; }
    setCreating(true);
    flash(`Creating ${id}…`);
    try {
      await createProject(id, { autoSync, selfHeal, prune });
      await reload();
      setShowNew(false); setNpId("");
      flash(`Created ${id} · committed to git + reconciled`);
    } catch (e) {
      flash(`Create failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setCreating(false); }
  }

  // Live mode renders ONLY real projects from /api/status — never the demo catalogue.
  // The mock catalogue exists purely for the standalone /prototype build (!LIVE).
  const cards = ready
    ? status!.projects!.map((p) => ({
        id: p.id, name: cap(p.id), description: "GitOps project (live from the controller).",
        sync: status!.sync ?? "OutOfSync", health: p.health, branch: "main",
        revision: (status!.syncedRevision ?? "").slice(0, 7), wfCount: (p.workflows ?? []).length,
      }))
    : LIVE
      ? [] // live but not yet loaded → show a connecting state, not demo data
      : projects.map((p) => ({
          id: p.id, name: p.name, description: p.description,
          sync: p.sync, health: p.health, branch: p.branch, revision: p.revision, wfCount: p.workflows.length,
        }));
  const connecting = LIVE && !ready; // controller status hasn't arrived yet
  const emptyLive = LIVE && ready && cards.length === 0; // connected, but the repo has no projects

  return (
    <div className="space-y-6" data-testid="workspace-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
            Projects
            <InfoTip
              label="projects"
              text="Each project is a git repo of YAML + JS. Git is the source of truth; Mill continuously reconciles running state toward it."
            />
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <FolderGit2 className="h-4 w-4" />
            Root config repo: <span className="font-mono text-slate-300">{LIVE ? "git-backed workspace" : workspace.rootRepo}</span>
            <InfoTip text="The root config repo (app-of-apps) registers which project repos this workspace tracks. Credentials live in k8s Secrets, never in git." />
            <Spec doc="ARCH §5" />
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tip text="Import a Windmill flow (.flow.yaml or OpenFlow .json) as a brand-new project. Mill converts it to workflows, commits, and reconciles.">
            <button className="btn-ghost" data-testid="import-flow-open" onClick={() => setShowImport(true)}>
              <UploadCloud className="h-4 w-4" /> Import from Windmill
            </button>
          </Tip>
          <Tip text="Register a new project by pointing Mill at a git repo. It appears here once the reconciler indexes it.">
            <button className="btn-primary" data-testid="new-project" onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" /> New Project
            </button>
          </Tip>
        </div>
      </div>

      {/* app-of-apps binding */}
      <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-xs text-slate-400" data-testid="app-of-apps">
        <span className="flex items-center gap-1.5 font-medium text-slate-300">
          <GitCommitHorizontal className="h-4 w-4 text-brand-400" /> Workspace
          <InfoTip text="v1 ships as a single GitHub repo with a folder per project (each project's config lives in its folder); Save writes to it directly. Binding several repos ('app-of-apps') comes soon after v1. Credentials are k8s Secrets, never in git." />
        </span>
        <span>{LIVE ? "Workspace" : workspace.name} ·</span>
        <span className="font-mono text-slate-300">{LIVE ? cards.length : projects.length} projects</span>
        <span className="chip bg-white/5 text-[10px] text-slate-400">v1: single repo · multi-repo soon</span>
        <span className="text-slate-600">·</span>
        <span className="inline-flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" /> creds via k8s Secrets (never in git)</span>
      </div>

      {connecting && (
        <div className="card p-8 text-center text-sm text-slate-400" data-testid="workspace-connecting">
          <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-white/10 border-t-brand-400" />
          Connecting to the controller…
        </div>
      )}

      {emptyLive && (
        <div className="card p-8 text-center" data-testid="workspace-empty">
          <FolderGit2 className="mx-auto mb-3 h-8 w-8 text-slate-500" />
          <div className="text-sm font-medium text-slate-200">No projects yet</div>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">
            This workspace's git repo has no projects. Click <span className="font-medium text-slate-300">New Project</span> to
            create one — Mill writes <span className="font-mono">&lt;name&gt;/project.yaml</span>, commits it, and reconciles.
          </p>
          <button className="btn-primary mx-auto mt-4" data-testid="empty-new-project" onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> New Project
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-grid">
        {cards.map((p, i) => (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.2 }}
            whileHover={{ y: -3 }}
          >
            <Link to={`/projects/${p.id}`} data-testid={`project-card-${p.id}`} className="card block p-4 transition-shadow hover:glow">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-white">{p.name}</div>
                <div className="flex items-center gap-1.5">
                  <SyncBadge status={p.sync} />
                  <HealthBadge health={p.health} />
                  {ready && (
                    <button
                      type="button"
                      data-testid={`delete-project-${p.id}`}
                      title="Delete project (commits to git)"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDeleteProject(p.id); }}
                      className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-slate-400">{p.description}</p>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <span className="inline-flex items-center gap-1 font-mono">
                  <GitBranch className="h-3.5 w-3.5" />
                  {p.branch}@{p.revision}
                </span>
                <span className="inline-flex items-center gap-1">
                  <WorkflowIcon className="h-3.5 w-3.5" />
                  {p.wfCount} workflow{p.wfCount === 1 ? "" : "s"}
                </span>
              </div>
            </Link>
          </motion.div>
        ))}
      </div>

      <Modal
        open={showNew}
        onClose={() => setShowNew(false)}
        testid="new-project-modal"
        icon={<FolderGit2 className="h-4 w-4 text-brand-400" />}
        title={<span className="flex items-center gap-2">Register a project <Spec doc="ARCH §5" /></span>}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
            <button
              className="btn-primary"
              data-testid="new-project-submit"
              onClick={onCreateProject}
              disabled={creating}
            >
              {creating ? "Creating…" : LIVE ? "Create" : "Register"}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {LIVE ? (
            <>
              <p className="text-xs text-slate-400">
                v1 is a single repo with a <strong>folder per project</strong>. Creating a project writes
                <span className="font-mono"> &lt;name&gt;/project.yaml</span>, commits it to git, and reconciles — it then
                appears here. Add workflows inside it from its page.
              </p>
              <Field label="Project name" hint="lowercase letters, digits, hyphens">
                <input className="inp font-mono" placeholder="e.g. payments" data-testid="np-id" value={npId} onChange={(e) => setNpId(e.target.value)} autoFocus />
              </Field>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-400">
                Point Mill at a git repo. There is no database — the repo <em>is</em> the source of truth. The reconciler
                clones it, validates + compiles every workflow, and starts driving running state toward it.
              </p>
              <Field label="Git remote" hint="SSH or HTTPS URL of the project repo">
                <input className="inp" defaultValue="git@github.com:acme/mill-payments.git" data-testid="np-repo" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Tracked branch" hint="Or pin a tag/commit">
                  <input className="inp" defaultValue="main" />
                </Field>
                <Field label="Credential ref" hint="k8s Secret name — never a value">
                  <input className="inp font-mono" defaultValue="mill-payments-deploy-key" />
                </Field>
              </div>
            </>
          )}
          <div className="rounded-xl border border-white/10 bg-ink-950/50 p-3">
            <div className="mb-2 text-xs font-medium text-slate-300">Sync policy <InfoTip text="Written to project.yaml. Drives how the reconcile loop applies new revisions." /></div>
            <PolicyRow label="autoSync" desc="Apply new revisions automatically (vs a manual Sync click)." checked={autoSync} onChange={setAutoSync} testid="np-autosync" />
            <PolicyRow label="selfHeal" desc="Continuously correct drift back to git (nearly free — live state is derived)." checked={selfHeal} onChange={setSelfHeal} />
            <PolicyRow label="prune" desc="Deregister triggers removed from git. Guarded by an allow-empty check so an empty repo can't wipe everything." checked={prune} onChange={setPrune} />
          </div>
        </div>
      </Modal>

      <ImportFlowModal open={showImport} onClose={() => setShowImport(false)}
        onDone={async (imported, pid) => { await reload(); flash(`Imported ${imported.join(", ")} into ${pid} · committed + reconciled`); }} />

      <Toast toast={toast} icon={<GitCommitHorizontal className="h-4 w-4 text-brand-400" />} />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-300">{label}{hint && <span className="font-normal text-slate-500">· {hint}</span>}</div>
      {children}
    </label>
  );
}

function PolicyRow({ label, desc, checked, onChange, testid }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <span className="font-mono text-xs text-slate-200">{label}</span>
        <p className="text-xs text-slate-500">{desc}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} testid={testid} />
    </div>
  );
}
