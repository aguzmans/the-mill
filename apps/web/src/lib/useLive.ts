import { useCallback, useEffect, useState } from "react";
import { LIVE, getStatus, getFleet, type LiveStatus, type FleetData } from "./api";

/** In LIVE mode, polls /api/status so pages can show real GitOps sync/health. */
export function useLiveStatus(intervalMs = 5000) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const reload = useCallback(async () => {
    if (!LIVE) return;
    try { setStatus(await getStatus()); } catch { /* keep last */ }
  }, []);
  useEffect(() => {
    if (!LIVE) return;
    reload();
    const t = setInterval(reload, intervalMs);
    window.addEventListener("mill:token", reload);
    return () => { clearInterval(t); window.removeEventListener("mill:token", reload); };
  }, [reload, intervalMs]);
  const ready = LIVE && !!status && !status.pending && !!status.projects;
  return { status, reload, ready };
}

/** In LIVE mode, polls /api/fleet for real workers, queue, and execution stats. Surfaces
 * `error` so the page can show an "unauthorized / can't reach the API" state instead of
 * crashing on a 401 body (which lacks the `workers`/`stats` arrays the view maps over). */
export function useFleet(intervalMs = 3000) {
  const [fleet, setFleet] = useState<FleetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!LIVE) return;
    try { setFleet(await getFleet()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : "failed to load fleet"); /* keep last fleet */ }
  }, []);
  useEffect(() => {
    if (!LIVE) return;
    reload();
    const t = setInterval(reload, intervalMs);
    window.addEventListener("mill:token", reload);
    return () => { clearInterval(t); window.removeEventListener("mill:token", reload); };
  }, [reload, intervalMs]);
  const ready = LIVE && !!fleet;
  return { fleet, reload, ready, error };
}
