import { useRef, useState } from "react";
import { UploadCloud, FileUp, AlertTriangle, CheckCircle2, ArrowRight } from "lucide-react";
import { Modal } from "./Kit";
import { LIVE, importWindmill, type WindmillImportResult } from "../lib/api";

// Windmill has no clean SQL/flow export — you copy the raw flow (a `.flow.yaml` or an OpenFlow
// `.json`). This modal takes that text (file picker or paste) and asks the controller to convert
// it into Mill workflow(s) + commit. Used two ways:
//   • project set  → import into that existing project (ProjectPage)
//   • project unset → "new project" mode: also collects an id and creates the project (WorkspacePage)
export function ImportFlowModal({ open, onClose, project, onDone }: {
  open: boolean;
  onClose: () => void;
  project?: string;
  onDone?: (imported: string[], projectId: string) => void;
}) {
  const newProject = !project;
  const fileRef = useRef<HTMLInputElement>(null);
  const [pid, setPid] = useState("");
  const [content, setContent] = useState("");
  const [filename, setFilename] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WindmillImportResult | null>(null);

  function reset() {
    setContent(""); setFilename(""); setName(""); setPid(""); setError(null); setResult(null); setBusy(false);
  }
  function close() { reset(); onClose(); }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFilename(f.name);
    setContent(await f.text());
    if (!name) setName(f.name.replace(/\.flow$/, "").replace(/\.(flow\.)?ya?ml$|\.json$/i, ""));
    setError(null); setResult(null);
  }

  async function run(force: boolean) {
    const targetId = (project ?? pid).trim().toLowerCase();
    if (newProject && !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(targetId)) { setError("project id: 2–40 chars, lowercase letters/digits/hyphens"); return; }
    if (!content.trim()) { setError("choose a flow file or paste its contents"); return; }
    setBusy(true); setError(null);
    try {
      const r = await importWindmill(targetId, { content, filename, name: name.trim() || undefined, force, sync: newProject ? { autoSync: true, selfHeal: true } : undefined });
      setResult(r);
      if (!r.blocked && r.imported) onDone?.(r.imported, targetId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const report = result?.report;
  const done = result && !result.blocked && result.imported;

  return (
    <Modal open={open} onClose={close} testid="import-flow" wide
      icon={<UploadCloud className="h-5 w-5 text-brand-400" />}
      title={newProject ? "Import a Windmill flow as a new project" : `Import a Windmill flow into ${project}`}
      footer={
        done ? (
          <button className="btn-primary" data-testid="import-flow-close" onClick={close}>Done</button>
        ) : result?.blocked ? (
          <>
            <button className="btn-ghost" onClick={() => setResult(null)}>Back</button>
            <button className="btn-primary" data-testid="import-flow-force" disabled={busy} onClick={() => run(true)}>Import anyway</button>
          </>
        ) : (
          <>
            <button className="btn-ghost" onClick={close}>Cancel</button>
            <button className="btn-primary" data-testid="import-flow-submit" disabled={busy || !LIVE} onClick={() => run(false)}>
              {busy ? "Importing…" : "Import"}
            </button>
          </>
        )
      }
    >
      {!LIVE && (
        <p className="mb-3 rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
          Import runs against a live controller. This is the prototype build — connect to a workspace to import for real.
        </p>
      )}

      {done ? (
        <div className="space-y-3 text-sm" data-testid="import-flow-report">
          <div className="flex items-center gap-2 text-emerald-300"><CheckCircle2 className="h-5 w-5" /> Imported {result!.imported!.length} workflow{result!.imported!.length > 1 ? "s" : ""}{result!.createdProject ? " · created the project" : ""}</div>
          <div className="flex flex-wrap gap-1.5">
            {result!.imported!.map((w) => <span key={w} className="chip bg-white/5 font-mono text-[11px] text-slate-300">{w}</span>)}
          </div>
          {report && (
            <div className="rounded-lg border border-white/5 bg-ink-950/40 p-3 text-xs text-slate-400">
              <div>{report.supported}/{report.total} steps converted{report.deps.length ? ` · deps: ${report.deps.join(", ")} (versions unpinned)` : ""}</div>
              {report.skipped.length > 0 && (
                <div className="mt-2 text-amber-200/80">
                  {report.skipped.length} step(s) need manual porting — emitted as loud TODO nodes:
                  <ul className="ml-4 mt-1 list-disc">{report.skipped.map((s) => <li key={s.id}><span className="font-mono">{s.id}</span> ({s.type}) — {s.reason}</li>)}</ul>
                </div>
              )}
              {report.warnings.map((w, i) => <div key={i} className="mt-1 text-slate-500">⚠ {w}</div>)}
            </div>
          )}
        </div>
      ) : result?.blocked ? (
        <div className="space-y-2 text-sm" data-testid="import-flow-blocked">
          <div className="flex items-center gap-2 text-amber-300"><AlertTriangle className="h-5 w-5" /> This flow calls scripts that aren't imported yet</div>
          <p className="text-xs text-slate-400">Import those first, or import anyway — the missing <span className="font-mono">callScript</span> steps will fail until their targets exist:</p>
          <div className="flex flex-wrap gap-1.5">{result.missing?.map((m) => <span key={m} className="chip bg-amber-500/10 font-mono text-[11px] text-amber-200">{m}</span>)}</div>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          {newProject && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">Project id</label>
              <input className="inp !py-1.5 w-full font-mono text-xs" data-testid="import-flow-pid" value={pid} onChange={(e) => setPid(e.target.value)} placeholder="billing" spellCheck={false} />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-300">Windmill flow</label>
            <input ref={fileRef} type="file" accept=".yaml,.yml,.json,.flow" className="hidden" data-testid="import-flow-file" onChange={onFile} />
            <button type="button" className="btn-ghost w-full justify-center border border-dashed border-white/10 py-3" onClick={() => fileRef.current?.click()}>
              <FileUp className="h-4 w-4" /> {filename || "Choose a .flow.yaml / OpenFlow .json file"}
            </button>
            <p className="mt-1 text-[11px] text-slate-500">…or paste the flow contents (Windmill → Export flow gives OpenFlow JSON):</p>
            <textarea className="inp mt-1 w-full font-mono text-[11px] leading-relaxed" rows={6} data-testid="import-flow-content" value={content}
              onChange={(e) => { setContent(e.target.value); setResult(null); }} placeholder='{ "summary": "...", "value": { "modules": [ ... ] } }' spellCheck={false} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-300">Workflow name <span className="text-slate-500">(optional)</span></label>
            <input className="inp !py-1.5 w-full font-mono text-xs" data-testid="import-flow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="derived from the file name" spellCheck={false} />
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <ArrowRight className="h-3.5 w-3.5" /> JS/TS → JS Code · Postgres → SQL · branches → if · loops → loop. Unsupported steps become TODO nodes (nothing dropped).
          </p>
        </div>
      )}
      {error && <p className="mt-3 text-xs text-rose-300" data-testid="import-flow-error">{error}</p>}
    </Modal>
  );
}
