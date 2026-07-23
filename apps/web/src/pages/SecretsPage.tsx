import { useEffect, useState, useCallback, useMemo } from "react";
import { KeyRound, Plus, Trash2, ShieldCheck, AlertTriangle, Lock, Globe, Boxes, Workflow as WorkflowIcon } from "lucide-react";
import { InfoTip } from "../components/InfoTip";
import { useToast, Toast } from "../components/Kit";
import { LIVE, getSecrets, putSecret, deleteSecret, getProjects, getEffectiveSecrets, type SecretsInfo, type SecretScope, type ProjectListItem, type EffectiveSecrets, type SecretSourceScope } from "../lib/api";

type ScopeKind = "global" | "project" | "workflow";

const SCOPE_BADGE: Record<SecretSourceScope, string> = {
  workflow: "bg-brand-500/20 text-brand-200",
  project: "bg-cyan-500/15 text-cyanx",
  global: "bg-slate-500/15 text-slate-300",
};

// Read-only "what does this workflow actually resolve" view: each name + the scope its value
// comes from (most-specific-wins), which lower scopes it overrides, and any declared-but-unset.
function EffectiveSecretsPanel({ data }: { data: EffectiveSecrets }) {
  return (
    <div className="card p-4" data-testid="effective-panel">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
        <ShieldCheck className="h-4 w-4 text-emerald-400" /> Effective secrets
        <span className="font-mono text-xs text-slate-500">{data.workflow}</span>
        <InfoTip text="What this workflow resolves at run time and which scope each value comes from (workflow overrides project overrides global). Read-only — values are never shown." />
      </div>
      <p className="mb-3 text-[11px] text-slate-500">This is exactly what a run of this workflow injects into <span className="font-mono">ctx.secrets</span>.</p>
      {data.resolved.length === 0 && data.missing.length === 0 ? (
        <div className="text-sm text-slate-500" data-testid="effective-empty">Nothing resolves yet — no secret is set in global, this project, or this workflow.</div>
      ) : (
        <div className="space-y-1.5" data-testid="effective-list">
          {data.resolved.map((r) => {
            const overrides = r.scopes.filter((s) => s !== r.source);
            return (
              <div key={r.name} className="flex items-center justify-between rounded-lg border border-white/5 bg-ink-950/40 px-3 py-2" data-testid={`effective-row-${r.name}`}>
                <span className="flex items-center gap-2 font-mono text-sm text-slate-200"><KeyRound className="h-3.5 w-3.5 text-slate-500" /> {r.name}</span>
                <span className="flex items-center gap-2">
                  {overrides.length > 0 && <span className="text-[10px] text-slate-500">overrides {overrides.join(", ")}</span>}
                  <span className={`chip text-[10px] ${SCOPE_BADGE[r.source]}`} data-testid={`effective-source-${r.name}`}>{r.source}</span>
                </span>
              </div>
            );
          })}
          {data.missing.map((n) => (
            <div key={n} className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2" data-testid={`effective-missing-${n}`}>
              <span className="flex items-center gap-2 font-mono text-sm text-amber-200/90"><AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> {n}</span>
              <span className="text-[10px] text-amber-300/80">declared by a node · not set in any scope (may come from env/k8s)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Runtime secrets: names are listed, values are write-only (never returned). A node reads a
// value via ctx.secrets.<NAME> only if it declares `secrets: [NAME]`. Values resolve at run
// time most-specific-wins: env/k8s < global < project < workflow.
export function SecretsPage() {
  const { toast, flash } = useToast();
  const [info, setInfo] = useState<SecretsInfo | null>(null);
  const [effective, setEffective] = useState<EffectiveSecrets | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [kind, setKind] = useState<ScopeKind>("global");
  const [project, setProject] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  // The scope object sent to the API for the current selection.
  const scope: SecretScope | undefined = useMemo(() => {
    if (kind === "project" && project) return { project };
    if (kind === "workflow" && project && workflow) return { project, workflow };
    return undefined; // global
  }, [kind, project, workflow]);

  // A scope is "ready" to load/edit (a project/workflow selection is required for those kinds).
  const scopeReady = kind === "global" || (kind === "project" && !!project) || (kind === "workflow" && !!project && !!workflow);
  const scopeLabel = kind === "global" ? "global" : kind === "project" ? `project: ${project || "—"}` : `workflow: ${project || "—"}/${workflow || "—"}`;
  const wfOptions = useMemo(() => projects.find((p) => p.id === project)?.workflows ?? [], [projects, project]);

  const reload = useCallback(async () => {
    if (!LIVE || !scopeReady) { setInfo(null); setEffective(null); return; }
    try { setInfo(await getSecrets(scope)); } catch { /* keep last */ }
    // Effective (resolved) view only makes sense once a full workflow is selected.
    if (kind === "workflow" && project && workflow) {
      try { setEffective(await getEffectiveSecrets(project, workflow)); } catch { setEffective(null); }
    } else setEffective(null);
  }, [scope, scopeReady, kind, project, workflow]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if (LIVE) getProjects().then(setProjects).catch(() => {}); }, []);

  async function onSave() {
    const n = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { flash("Invalid name — letters, digits, underscore (e.g. ACUITY_API_KEY)"); return; }
    if (!value) { flash("Enter a value"); return; }
    if (!scopeReady) { flash("Pick a project/workflow for this scope first"); return; }
    setBusy(true);
    try { await putSecret(n, value, scope); await reload(); setName(""); setValue(""); flash(`Saved ${n} → ${scopeLabel}`); }
    catch (e) { flash(`Save failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }
  async function onDelete(n: string) {
    if (!window.confirm(`Delete secret "${n}" from ${scopeLabel}? Workloads reading it will fall back to a broader scope (or stop resolving it).`)) return;
    try { await deleteSecret(n, scope); await reload(); flash(`Deleted ${n} from ${scopeLabel}`); }
    catch (e) { flash(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const names = info?.names ?? [];
  const scopeBtn = (k: ScopeKind, label: string, Icon: typeof Globe) => (
    <button
      key={k}
      type="button"
      data-testid={`scope-${k}`}
      onClick={() => setKind(k)}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${kind === k ? "bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/40" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"}`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );

  return (
    <div className="space-y-6" data-testid="secrets-page">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
          <KeyRound className="h-5 w-5 text-brand-400" /> Secrets
          <InfoTip text="Runtime credentials (API keys, tokens). A node reads a value via ctx.secrets.NAME only if it declares secrets: [NAME]. Values are write-only here — never shown again after saving." />
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Injected into <span className="font-mono text-slate-300">ctx.secrets</span> at run time. Scoped and resolved most-specific-wins:
          <span className="font-mono text-slate-300"> env/k8s &lt; global &lt; project &lt; workflow</span>.
        </p>
      </div>

      {!LIVE ? (
        <div className="card p-6 text-sm text-slate-400" data-testid="secrets-prototype">
          Secrets are a live-backend feature. Run the dynamic build (served at <span className="font-mono">/</span>) to manage them.
        </div>
      ) : (
        <>
          {/* scope selector */}
          <div className="card p-4" data-testid="scope-selector">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
              Scope <InfoTip text="Where this secret lives. A workflow value overrides a project value, which overrides a global one — so set shared defaults globally and override per project/workflow." />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl bg-ink-950/50 p-1">
                {scopeBtn("global", "Global", Globe)}
                {scopeBtn("project", "Project", Boxes)}
                {scopeBtn("workflow", "Workflow", WorkflowIcon)}
              </div>
              {(kind === "project" || kind === "workflow") && (
                <select className="inp !w-auto !py-1.5 text-xs" data-testid="scope-project-select" value={project} onChange={(e) => { setProject(e.target.value); setWorkflow(""); }}>
                  <option value="">select project…</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
                </select>
              )}
              {kind === "workflow" && (
                <select className="inp !w-auto !py-1.5 text-xs" data-testid="scope-workflow-select" value={workflow} onChange={(e) => setWorkflow(e.target.value)} disabled={!project}>
                  <option value="">select workflow…</option>
                  {wfOptions.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
              )}
              <span className="ml-auto chip bg-white/5 font-mono text-[11px] text-slate-400" data-testid="scope-current">{scopeLabel}</span>
            </div>
          </div>

          {/* at-rest status */}
          <div className="flex items-center gap-2 text-xs" data-testid="secrets-atrest">
            {info?.encryptedAtRest
              ? <span className="chip bg-emerald-500/10 text-emerald-300"><Lock className="h-3 w-3" /> encrypted at rest</span>
              : <span className="chip bg-amber-500/10 text-amber-300"><AlertTriangle className="h-3 w-3" /> stored unencrypted — set MILL_SECRETS_KEY to encrypt at rest</span>}
            <span className="text-slate-500">Stored in Redis · admin-guarded when MILL_ADMIN_TOKEN is set</span>
          </div>

          {/* add / update */}
          <div className="card p-4">
            <div className="mb-3 text-sm font-medium text-slate-200">Add or update a secret <span className="font-mono text-xs text-brand-300">→ {scopeLabel}</span></div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <div className="mb-1 text-xs font-medium text-slate-300">Name</div>
                <input className="inp font-mono" placeholder="ACUITY_API_KEY" data-testid="secret-name" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block flex-1 min-w-[220px]">
                <div className="mb-1 text-xs font-medium text-slate-300">Value</div>
                <input className="inp font-mono" type="password" placeholder="•••••••• (write-only)" data-testid="secret-value" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onSave(); }} />
              </label>
              <button className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed" data-testid="secret-save" onClick={onSave} disabled={busy || !scopeReady}>
                <Plus className="h-4 w-4" /> {busy ? "Saving…" : "Save"}
              </button>
            </div>
            {!scopeReady ? (
              <p className="mt-2 text-[11px] text-amber-300/80" data-testid="scope-hint">Select a {kind === "workflow" && project ? "workflow" : "project"} above to add a secret in this scope.</p>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">
                A workload uses it by declaring <span className="font-mono">secrets: [{name.trim() || "NAME"}]</span> on a node, then reading <span className="font-mono">ctx.secrets.{name.trim() || "NAME"}</span>.
              </p>
            )}
          </div>

          {/* list */}
          <div className="card p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-200">
              <ShieldCheck className="h-4 w-4 text-brand-400" /> Stored secrets <span className="font-mono text-xs text-slate-500">({scopeLabel} · {names.length})</span>
            </div>
            {!scopeReady ? (
              <div className="text-sm text-slate-500" data-testid="secrets-noscope">Pick a project/workflow above to see its secrets.</div>
            ) : names.length === 0 ? (
              <div className="text-sm text-slate-500" data-testid="secrets-empty">No secrets in this scope yet. Add one above (e.g. ACUITY_USER_ID, ACUITY_API_KEY).</div>
            ) : (
              <div className="space-y-1.5" data-testid="secrets-list">
                {names.map((n) => (
                  <div key={n} className="flex items-center justify-between rounded-lg border border-white/5 bg-ink-950/40 px-3 py-2" data-testid={`secret-row-${n}`}>
                    <span className="flex items-center gap-2 font-mono text-sm text-slate-200"><KeyRound className="h-3.5 w-3.5 text-slate-500" /> {n}</span>
                    <span className="flex items-center gap-3">
                      <span className="font-mono text-xs text-slate-600">••••••••</span>
                      <button type="button" data-testid={`secret-delete-${n}`} title="Delete secret" onClick={() => onDelete(n)} className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-rose-300">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* effective (resolved) view — only when a full workflow is selected */}
          {effective && <EffectiveSecretsPanel data={effective} />}
        </>
      )}

      <Toast toast={toast} icon={<KeyRound className="h-4 w-4 text-brand-400" />} />
    </div>
  );
}
