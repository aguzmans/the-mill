import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { GitBranch, Plus, FolderGit2, Workflow as WorkflowIcon, GitCommitHorizontal, KeyRound, Trash2 } from "lucide-react";
import { workspace, projects } from "../lib/mock";
import { SyncBadge, HealthBadge } from "../components/Badges";
import { InfoTip, Tip } from "../components/InfoTip";
import { Modal, Toggle, Spec, useToast, Toast } from "../components/Kit";
import { useLiveStatus } from "../lib/useLive";
import { deleteProject } from "../lib/api";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function WorkspacePage() {
  const [showNew, setShowNew] = useState(false);
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

  // In Live mode, render real projects from /api/status; otherwise the mock catalogue.
  const cards = ready
    ? status!.projects!.map((p) => ({
        id: p.id, name: cap(p.id), description: "GitOps project (live from the controller).",
        sync: status!.sync ?? "OutOfSync", health: p.health, branch: "main",
        revision: (status!.syncedRevision ?? "").slice(0, 7), wfCount: p.workflows.length,
      }))
    : projects.map((p) => ({
        id: p.id, name: p.name, description: p.description,
        sync: p.sync, health: p.health, branch: p.branch, revision: p.revision, wfCount: p.workflows.length,
      }));

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
            Root config repo: <span className="font-mono text-slate-300">{workspace.rootRepo}</span>
            <InfoTip text="The root config repo (app-of-apps) registers which project repos this workspace tracks. Credentials live in k8s Secrets, never in git." />
            <Spec doc="ARCH §5" />
          </p>
        </div>
        <Tip text="Register a new project by pointing Mill at a git repo. It appears here once the reconciler indexes it.">
          <button className="btn-primary" data-testid="new-project" onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> New Project
          </button>
        </Tip>
      </div>

      {/* app-of-apps binding */}
      <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-xs text-slate-400" data-testid="app-of-apps">
        <span className="flex items-center gap-1.5 font-medium text-slate-300">
          <GitCommitHorizontal className="h-4 w-4 text-brand-400" /> Workspace
          <InfoTip text="v1 ships as a single GitHub repo with a folder per project (each project's config lives in its folder); Save writes to it directly. Binding several repos ('app-of-apps') comes soon after v1. Credentials are k8s Secrets, never in git." />
        </span>
        <span>{workspace.name} ·</span>
        <span className="font-mono text-slate-300">{projects.length} projects</span>
        <span className="chip bg-white/5 text-[10px] text-slate-400">v1: single repo · multi-repo soon</span>
        <span className="text-slate-600">·</span>
        <span className="inline-flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" /> creds via k8s Secrets (never in git)</span>
      </div>

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
              onClick={() => {
                setShowNew(false);
                flash("Project registered · reconciler will clone + index it");
              }}
            >
              Register
            </button>
          </>
        }
      >
        <div className="space-y-4">
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
          <div className="rounded-xl border border-white/10 bg-ink-950/50 p-3">
            <div className="mb-2 text-xs font-medium text-slate-300">Sync policy <InfoTip text="Written to project.yaml. Drives how the reconcile loop applies new revisions." /></div>
            <PolicyRow label="autoSync" desc="Apply new revisions automatically (vs a manual Sync click)." checked={autoSync} onChange={setAutoSync} testid="np-autosync" />
            <PolicyRow label="selfHeal" desc="Continuously correct drift back to git (nearly free — live state is derived)." checked={selfHeal} onChange={setSelfHeal} />
            <PolicyRow label="prune" desc="Deregister triggers removed from git. Guarded by an allow-empty check so an empty repo can't wipe everything." checked={prune} onChange={setPrune} />
          </div>
        </div>
      </Modal>

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
