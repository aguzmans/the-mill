import { useEffect, useRef, useState } from "react";
import { LogIn, Check, X } from "lucide-react";
import { getAdminToken, setAdminToken } from "../lib/api";

// Header control for the admin API token. When the controller runs with MILL_ADMIN_TOKEN every
// /api call needs the bearer; the SPA has no server session, so an operator pastes the token
// here once. It's kept in localStorage (this browser only) and attached to every request.
export function TokenControl() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(getAdminToken());
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const signedIn = !!token;
  const save = () => { const t = draft.trim(); setAdminToken(t); setToken(t); setDraft(""); setOpen(false); };
  const signOut = () => { setAdminToken(""); setToken(""); setOpen(false); };

  return (
    <div className="relative" ref={ref}>
      <button
        data-testid="token-control"
        onClick={() => setOpen((v) => !v)}
        className={`chip ${signedIn ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}
        title="Set the admin API token"
      >
        <LogIn className="h-3 w-3" /> {signedIn ? "Signed in" : "Sign in"}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-white/10 bg-ink-850 p-3 shadow-xl" data-testid="token-popover">
          <div className="mb-1 text-xs font-medium text-slate-300">API token</div>
          <p className="mb-2 text-[11px] text-slate-500">Paste the controller's admin token to access the API. Stored in this browser only.</p>
          <input
            type="password"
            data-testid="token-input"
            className="inp font-mono text-xs"
            placeholder="paste admin token"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            autoFocus
          />
          <div className="mt-2 flex items-center justify-between">
            <button data-testid="token-save" className="chip bg-brand-500/20 text-brand-200" onClick={save}><Check className="h-3 w-3" /> Save</button>
            {signedIn && <button data-testid="token-signout" className="chip bg-white/5 text-slate-400" onClick={signOut}><X className="h-3 w-3" /> Sign out</button>}
          </div>
        </div>
      )}
    </div>
  );
}
