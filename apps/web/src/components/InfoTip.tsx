import * as Tooltip from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import type { ReactNode } from "react";

const content =
  "z-50 max-w-xs rounded-lg border border-white/10 bg-ink-800 px-3 py-2 text-xs leading-relaxed text-slate-200 shadow-xl shadow-black/40 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95";

/** A small `(i)` icon that reveals an explanation of a feature on hover/focus. */
export function InfoTip({ text, label }: { text: string; label?: string }) {
  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={label ? `About ${label}` : "More information"}
            data-testid="infotip"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-500 hover:text-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-500"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className={content} sideOffset={6} role="tooltip">
            {text}
            <Tooltip.Arrow className="fill-ink-800" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/** Wrap any control (button/badge) so hovering it explains what it does. */
export function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className={content} sideOffset={6} role="tooltip">
            {text}
            <Tooltip.Arrow className="fill-ink-800" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
