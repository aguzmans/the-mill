// Small reusable UI primitives shared across the prototype:
// Modal, Drawer, Toggle, DiffRow, Spec reference chip, and a toast hook.
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

// ── Modal ────────────────────────────────────────────────────────────────────
export function Modal({
  open,
  onClose,
  title,
  icon,
  children,
  footer,
  testid,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  testid?: string;
  wide?: boolean;
}) {
  useEsc(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          data-testid={testid ? `${testid}-backdrop` : undefined}
        >
          <motion.div
            className={`card w-full ${wide ? "max-w-3xl" : "max-w-lg"} p-5`}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.16 }}
            onClick={(e) => e.stopPropagation()}
            data-testid={testid}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="flex items-center gap-2 text-base font-semibold text-white">
                {icon}
                {title}
              </h2>
              <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200" aria-label="Close" data-testid="modal-close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4">{children}</div>
            {footer && <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Drawer (right side) ───────────────────────────────────────────────────────
export function Drawer({
  open,
  onClose,
  title,
  icon,
  children,
  testid,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  testid?: string;
}) {
  useEsc(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          data-testid={testid ? `${testid}-backdrop` : undefined}
        >
          <motion.div
            className="flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-ink-900/95 shadow-2xl"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "tween", duration: 0.22, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
            data-testid={testid}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center justify-between gap-3 border-b border-white/5 px-5 py-4">
              <h2 className="flex items-center gap-2 text-base font-semibold text-white">
                {icon}
                {title}
              </h2>
              <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200" aria-label="Close" data-testid="drawer-close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────────────
export function Toggle({
  checked,
  onChange,
  disabled,
  testid,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testid}
      data-checked={checked}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        checked ? "bg-brand-500" : "bg-white/15"
      }`}
    >
      <motion.span layout className="inline-block h-4 w-4 rounded-full bg-white shadow" animate={{ x: checked ? 18 : 2 }} transition={{ type: "spring", stiffness: 500, damping: 32 }} />
    </button>
  );
}

// ── Diff row ──────────────────────────────────────────────────────────────────
export function DiffRow({ change, path, summary }: { change: "added" | "modified" | "removed"; path: string; summary: string }) {
  const map = {
    added: { sym: "+", cls: "text-emerald-300", bg: "bg-emerald-500/10" },
    modified: { sym: "~", cls: "text-amber-300", bg: "bg-amber-500/10" },
    removed: { sym: "−", cls: "text-rose-300", bg: "bg-rose-500/10" },
  }[change];
  return (
    <div className="flex items-start gap-2 rounded-lg border border-white/5 bg-ink-950/50 px-3 py-2" data-testid="diff-row">
      <span className={`mt-0.5 grid h-5 w-5 place-items-center rounded ${map.bg} font-mono text-xs ${map.cls}`}>{map.sym}</span>
      <div className="min-w-0">
        <div className="truncate font-mono text-xs text-slate-200">{path}</div>
        <div className="text-xs text-slate-500">{summary}</div>
      </div>
    </div>
  );
}

// ── Spec provenance chip (for the engineering design review) ──────────────────
export function Spec({ doc }: { doc: string }) {
  return (
    <span className="chip border border-white/10 bg-white/5 font-mono text-[10px] text-slate-400" title={`Traceable to ${doc} in docs/`} data-testid="spec-ref">
      {doc}
    </span>
  );
}

// ── Toast ─────────────────────────────────────────────────────────────────────
export function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2400);
  }, []);
  return { toast, flash };
}

export function Toast({ toast, icon }: { toast: string | null; icon?: ReactNode }) {
  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          data-testid="toast"
          className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-white/10 bg-ink-800 px-4 py-2 text-sm text-slate-100 shadow-xl"
        >
          <span className="inline-flex items-center gap-2">{icon}{toast}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function useEsc(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
}
