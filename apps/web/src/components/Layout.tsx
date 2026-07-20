import { NavLink, Outlet, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Boxes, Cpu, Workflow as WorkflowIcon, GitBranch, Network, HelpCircle } from "lucide-react";
import { InfoTip } from "./InfoTip";
import { workspace } from "../lib/mock";

function NavItem({ to, icon, label, tip }: { to: string; icon: React.ReactNode; label: string; tip: string }) {
  return (
    <NavLink
      to={to}
      data-testid={`nav-${label.toLowerCase()}`}
      className={({ isActive }) =>
        `group flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors ${
          isActive ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
        }`
      }
    >
      {icon}
      <span>{label}</span>
      <InfoTip text={tip} label={label} />
    </NavLink>
  );
}

export function Layout() {
  const location = useLocation();
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-900/70 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-5">
          <NavLink to="/workspace" className="flex items-center gap-2" data-testid="brand">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-cyanx glow">
              <WorkflowIcon className="h-4 w-4 text-white" />
            </div>
            <span className="text-sm font-semibold tracking-tight text-white">Mill</span>
          </NavLink>

          <div className="flex items-center gap-1 rounded-lg border border-white/5 bg-ink-850/60 px-2 py-1 text-xs text-slate-300" data-testid="workspace-switcher">
            <Boxes className="h-3.5 w-3.5 text-brand-400" />
            <span className="font-medium">{workspace.name}</span>
            <InfoTip
              label="workspace"
              text="A workspace is your top-level tenant. It binds one or more git repos (projects). The root config repo lists them."
            />
          </div>

          <nav className="ml-auto flex items-center gap-1">
            <NavItem to="/workspace" icon={<Boxes className="h-4 w-4" />} label="Workspace" tip="Browse the projects (git repos) in this workspace." />
            <NavItem to="/fleet" icon={<Cpu className="h-4 w-4" />} label="Fleet" tip="Live worker fleet, queue depth, and autoscaling signals." />
            <NavItem to="/architecture" icon={<Network className="h-4 w-4" />} label="Architecture" tip="In-app design reference: topology, no-DB rationale, k8s strategy, tech decisions." />
            <a
              href="/help"
              target="_blank"
              rel="noreferrer"
              data-testid="nav-help"
              className="group flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
            >
              <HelpCircle className="h-4 w-4" />
              <span>Help</span>
            </a>
            {import.meta.env.VITE_MILL_MODE === "live" ? (
              <span className="chip bg-emerald-500/15 text-emerald-300" data-testid="proto-badge">
                Live
                <InfoTip text="Wired to the real backend. Run actually triggers a job on the controller and streams live logs from the worker." />
              </span>
            ) : (
              <span className="chip bg-brand-500/15 text-brand-300" data-testid="proto-badge">
                Prototype
                <InfoTip text="Non-functional UI prototype — interactions are mocked. The Live build (served at /) is wired to the real backend." />
              </span>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-5 py-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="border-t border-white/5 py-3 text-center text-xs text-slate-600">
        <span className="inline-flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5" />
          Mill · GitOps-native workflow automation · MIT
        </span>
      </footer>
    </div>
  );
}
