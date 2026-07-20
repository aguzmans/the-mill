import { useEffect, useState, useCallback } from "react";
import { KeyRound, Plus, Trash2, ShieldCheck, AlertTriangle, Lock } from "lucide-react";
import { InfoTip } from "../components/InfoTip";
import { useToast, Toast } from "../components/Kit";
import { LIVE, getSecrets, putSecret, deleteSecret, type SecretsInfo } from "../lib/api";

// Runtime secrets: names are listed, values are write-only (never returned). A node reads a
// value via ctx.secrets.<NAME> only if it declares `secrets: [NAME]`.
export function SecretsPage() {
  const { toast, flash } = useToast();
  const [info, setInfo] = useState<SecretsInfo | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!LIVE) return;
    try { setInfo(await getSecrets()); } catch { /* keep last */ }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  async function onSave() {
    const n = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { flash("Invalid name — letters, digits, underscore (e.g. ACUITY_API_KEY)"); return; }
    if (!value) { flash("Enter a value"); return; }
    setBusy(true);
    try { await putSecret(n, value); await reload(); setName(""); setValue(""); flash(`Saved ${n}`); }
    catch (e) { flash(`Save failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setBusy(false); }
  }
  async function onDelete(n: string) {
    if (!window.confirm(`Delete secret "${n}"? Workloads reading it will stop resolving it.`)) return;
    try { await deleteSecret(n); await reload(); flash(`Deleted ${n}`); }
    catch (e) { flash(`Delete failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const names = info?.names ?? [];

  return (
    <div className="space-y-6" data-testid="secrets-page">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
          <KeyRound className="h-5 w-5 text-brand-400" /> Secrets
          <InfoTip text="Runtime credentials (API keys, tokens). A node reads a value via ctx.secrets.NAME only if it declares secrets: [NAME]. Values are write-only here — they're never shown again after saving." />
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Injected into <span className="font-mono text-slate-300">ctx.secrets</span> at run time. Values are write-only — set once, never displayed.
        </p>
      </div>

      {!LIVE ? (
        <div className="card p-6 text-sm text-slate-400" data-testid="secrets-prototype">
          Secrets are a live-backend feature. Run the dynamic build (served at <span className="font-mono">/</span>) to manage them.
        </div>
      ) : (
        <>
          {/* at-rest status */}
          <div className="flex items-center gap-2 text-xs" data-testid="secrets-atrest">
            {info?.encryptedAtRest
              ? <span className="chip bg-emerald-500/10 text-emerald-300"><Lock className="h-3 w-3" /> encrypted at rest</span>
              : <span className="chip bg-amber-500/10 text-amber-300"><AlertTriangle className="h-3 w-3" /> stored unencrypted — set MILL_SECRETS_KEY to encrypt at rest</span>}
            <span className="text-slate-500">Stored in Redis · admin-guarded when MILL_ADMIN_TOKEN is set</span>
          </div>

          {/* add / update */}
          <div className="card p-4">
            <div className="mb-3 text-sm font-medium text-slate-200">Add or update a secret</div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <div className="mb-1 text-xs font-medium text-slate-300">Name</div>
                <input className="inp font-mono" placeholder="ACUITY_API_KEY" data-testid="secret-name" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block flex-1 min-w-[220px]">
                <div className="mb-1 text-xs font-medium text-slate-300">Value</div>
                <input className="inp font-mono" type="password" placeholder="•••••••• (write-only)" data-testid="secret-value" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onSave(); }} />
              </label>
              <button className="btn-primary" data-testid="secret-save" onClick={onSave} disabled={busy}>
                <Plus className="h-4 w-4" /> {busy ? "Saving…" : "Save"}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              A workload uses it by declaring <span className="font-mono">secrets: [{name.trim() || "NAME"}]</span> on a node, then reading <span className="font-mono">ctx.secrets.{name.trim() || "NAME"}</span>.
            </p>
          </div>

          {/* list */}
          <div className="card p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-200">
              <ShieldCheck className="h-4 w-4 text-brand-400" /> Stored secrets <span className="font-mono text-xs text-slate-500">({names.length})</span>
            </div>
            {names.length === 0 ? (
              <div className="text-sm text-slate-500" data-testid="secrets-empty">No secrets yet. Add one above (e.g. ACUITY_USER_ID, ACUITY_API_KEY).</div>
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
        </>
      )}

      <Toast toast={toast} icon={<KeyRound className="h-4 w-4 text-brand-400" />} />
    </div>
  );
}
