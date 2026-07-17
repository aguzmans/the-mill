/**
 * Prototype code editor: a styled, read-only-ish textarea with a mono font.
 * In the functional app this component is swapped for Monaco (see docs/DEPENDENCIES.md)
 * without changing its call sites.
 */
export function CodeEditor({
  value,
  onChange,
  filename,
}: {
  value: string;
  onChange?: (v: string) => void;
  filename?: string;
}) {
  const lines = value.split("\n");
  return (
    <div data-testid="code-editor" className="overflow-hidden rounded-xl border border-white/10 bg-ink-950/80">
      {filename && (
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5 text-xs text-slate-400">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          <span className="ml-2 font-mono">{filename}</span>
        </div>
      )}
      <div className="flex max-h-72 overflow-auto">
        <pre className="select-none py-3 pl-3 pr-2 text-right font-mono text-xs leading-5 text-slate-600">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </pre>
        <textarea
          spellCheck={false}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          className="min-h-[12rem] w-full resize-none bg-transparent py-3 pr-3 font-mono text-xs leading-5 text-slate-200 outline-none"
        />
      </div>
    </div>
  );
}
