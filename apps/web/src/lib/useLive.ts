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
    return () => clearInterval(t);
  }, [reload, intervalMs]);
  const ready = LIVE && !!status && !status.pending && !!status.projects;
  return { status, reload, ready };
}

/** In LIVE mode, polls /api/fleet for real workers, queue, and execution stats. */
export function useFleet(intervalMs = 3000) {
  const [fleet, setFleet] = useState<FleetData | null>(null);
  const reload = useCallback(async () => {
    if (!LIVE) return;
    try { setFleet(await getFleet()); } catch { /* keep last */ }
  }, []);
  useEffect(() => {
    if (!LIVE) return;
    reload();
    const t = setInterval(reload, intervalMs);
    return () => clearInterval(t);
  }, [reload, intervalMs]);
  const ready = LIVE && !!fleet;
  return { fleet, reload, ready };
}
