import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { Check, Loader2 } from "lucide-react";
import { configureMonaco } from "../lib/monaco";

/**
 * A real JS editor for JS Code nodes: Monaco with syntax + type validation,
 * autocompletion (including Mill's `ctx.` SDK), and a Save & Apply button that
 * writes the edited code back to the node draft.
 */
export function JsEditor({ value, filename, onApply }: { value: string; filename: string; onApply: (code: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);

  // Reset when a different node/file is selected.
  useEffect(() => {
    setDraft(value);
    setDirty(false);
  }, [value, filename]);

  return (
    <div data-testid="code-editor" className="overflow-hidden rounded-xl border border-white/10 bg-ink-950/80">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5 text-xs text-slate-400">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        <span className="ml-1 font-mono">{filename}</span>
        {dirty && <span className="chip bg-amber-500/15 px-1.5 py-0 text-[10px] text-amber-300">unsaved</span>}
        <button
          type="button"
          data-testid="code-apply"
          disabled={!dirty}
          onClick={() => { onApply(draft); setDirty(false); }}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-brand-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-brand-500 disabled:opacity-40"
        >
          <Check className="h-3 w-3" /> Save &amp; Apply
        </button>
      </div>
      <Editor
        height="248px"
        theme="vs-dark"
        language="javascript"
        path={filename}
        value={draft}
        beforeMount={configureMonaco}
        loading={<div className="flex h-[248px] items-center justify-center text-xs text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> loading editor…</div>}
        onChange={(v) => { setDraft(v ?? ""); setDirty(true); }}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          fontFamily: "JetBrains Mono, monospace",
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          padding: { top: 10, bottom: 10 },
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          scrollbar: { vertical: "auto", horizontalScrollbarSize: 8, verticalScrollbarSize: 8 },
        }}
      />
    </div>
  );
}
