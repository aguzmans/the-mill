// Live API client. The app is served by the controller (same origin), so the base is
// relative. LIVE is set at build time (VITE_MILL_MODE=live) for the dynamic build.
export const LIVE = import.meta.env.VITE_MILL_MODE === "live";
const BASE = (import.meta.env.VITE_MILL_API as string) || "/api";

/** GET JSON that FAILS LOUDLY on a non-2xx. A 401/500 body is still valid JSON, so a bare
 * `.json()` would hand pages an `{error}` object where they expect `{workers:[…]}` and then
 * crash on `.map`. Throwing here lets the polling hooks catch it and render an error state. */
async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `GET ${path} (${r.status})`);
  return r.json() as Promise<T>;
}

export interface LiveEvent {
  type: "node" | "log" | "done";
  node?: string;
  status?: string;
  ms?: number;
  error?: string;
  level?: string;
  message?: string;
  fields?: Record<string, unknown>;
}

export async function triggerRun(projectId: string, workflow: string, input: unknown): Promise<string> {
  const r = await fetch(`${BASE}/projects/${projectId}/workflows/${workflow}/trigger`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!r.ok) throw new Error(`trigger failed (${r.status})`);
  const j = await r.json();
  if (!j.jobId) throw new Error(j.error || "no jobId");
  return j.jobId;
}

export function streamEvents(jobId: string, onEvent: (e: LiveEvent) => void, onDone: () => void): () => void {
  const es = new EventSource(`${BASE}/jobs/${jobId}/events`);
  let closed = false;
  const stop = () => { if (closed) return; closed = true; es.close(); onDone(); };
  es.onmessage = (m) => { const e = JSON.parse(m.data) as LiveEvent; onEvent(e); if (e.type === "done") stop(); };
  es.addEventListener("done", stop);
  es.onerror = stop;
  return () => { closed = true; es.close(); };
}

export async function getJob(jobId: string): Promise<{ status: string; result: unknown; error?: string }> {
  return getJSON(`/jobs/${jobId}`);
}

export interface LiveRunningJob { id: string; workflow: string; startedAt: number }
export interface LiveWorker {
  id: string; host: string; inFlight: number; concMin: number; concMax: number; paused: boolean;
  beatAt?: number; memMB?: number; memMaxMB?: number; executor?: string; jobs?: LiveRunningJob[];
}
export async function getWorkers(): Promise<{ workers: LiveWorker[]; queueDepth: number }> {
  return getJSON(`/workers`);
}

export interface FleetStats {
  throughputPerMin: number; completedLastHour: number; failedLastHour: number; p50Ms: number; p95Ms: number;
  successRatePct: number; avgWaitMs: number; throughputTrend: number[];
}
export interface FleetData {
  workers: LiveWorker[];
  queueDepth: number;
  stats: FleetStats;
  queue: { depth: number; oldestWaitMs: number; byWorkflow: { workflow: string; count: number }[] };
  now: number;
}
export async function getFleet(): Promise<FleetData> {
  return getJSON(`/fleet`);
}

export interface LiveWorkflowStatus { name: string; ok: boolean; error?: string }
export interface LiveProjectStatus { id: string; health: "Healthy" | "Degraded"; workflows: LiveWorkflowStatus[] }
export interface LiveStatus {
  targetRevision?: string;
  syncedRevision?: string;
  sync?: "Synced" | "OutOfSync";
  health?: "Healthy" | "Degraded";
  projects?: LiveProjectStatus[];
  error?: string;
  pending?: boolean;
  source?: string;
}
export async function getStatus(): Promise<LiveStatus> {
  return getJSON(`/status`);
}
export async function reconcileNow(): Promise<LiveStatus> {
  return (await fetch(`${BASE}/reconcile`, { method: "POST" })).json();
}

export interface LiveGraph {
  workflow: string;
  nodes: any[];
  edges: { from: string; to: string; branch?: "true" | "false" }[];
  order: string[];
  triggers: any[];
  exclusive?: boolean;
  inputSchema?: string;
}
export async function getWorkflowGraph(projectId: string, wf: string): Promise<LiveGraph> {
  const r = await fetch(`${BASE}/projects/${projectId}/workflows/${wf}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `graph ${r.status}`);
  return r.json();
}

async function del(path: string) {
  const r = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `delete ${r.status}`);
  return r.json();
}
export const deleteWorkflow = (projectId: string, wf: string) => del(`/projects/${projectId}/workflows/${wf}`);
export const deleteProject = (projectId: string) => del(`/projects/${projectId}`);

export async function createProject(id: string, opts?: { autoSync?: boolean; selfHeal?: boolean; prune?: boolean }) {
  const r = await fetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, ...opts }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `create ${r.status}`);
  return j;
}

export interface LiveRun { id: string; status: string; trigger?: string; revision?: string; createdAt?: string; startedAt?: string; finishedAt?: string; ms?: string; error?: string; workflow?: string }
export async function getRuns(projectId: string, wf: string): Promise<{ runs: LiveRun[] }> {
  return getJSON(`/projects/${projectId}/workflows/${wf}/runs`);
}
export interface NodeTiming { key: string; status: string; ms: number }
export async function getTimeline(jobId: string): Promise<{ nodeTimings: NodeTiming[]; error?: { node: string; message: string } }> {
  return getJSON(`/jobs/${jobId}/timeline`);
}
export async function retryRun(jobId: string): Promise<{ jobId: string }> {
  const r = await fetch(`${BASE}/jobs/${jobId}/retry`, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `retry ${r.status}`);
  return j;
}
export interface ReconcileEventLive { at: number; targetRevision: string; syncedRevision: string; sync: string; health: string; error?: string }
export async function getReconcileEvents(): Promise<{ events: ReconcileEventLive[] }> {
  return getJSON(`/reconcile-events`);
}
export interface DiffEntryLive { change: string; path: string }
export async function getDiff(projectId: string): Promise<{ diff: DiffEntryLive[]; synced: boolean; targetRevision?: string; syncedRevision?: string }> {
  return getJSON(`/projects/${projectId}/diff`);
}
export interface ProjectEndpoints {
  project: string;
  projectPath: string | null; // null → no workflow exposes an HTTP endpoint yet
  workflows: { workflow: string; path: string; customPaths: string[] }[];
  ingressEnabled?: boolean; // a bearer token is configured (global or per-project)
  authRequired: boolean;
}
export async function getEndpoints(projectId: string): Promise<ProjectEndpoints> {
  return getJSON(`/projects/${projectId}/endpoints`);
}

export interface NodeTestResult { status: "succeeded" | "failed"; node: string; kind: string; output?: unknown; error?: string; logs: LiveEvent[]; ms: number }
export async function testNode(projectId: string, wf: string, key: string, input: unknown, secrets?: Record<string, string>): Promise<NodeTestResult> {
  const r = await fetch(`${BASE}/projects/${projectId}/workflows/${wf}/nodes/${key}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, secrets }),
  });
  return r.json();
}

export interface SaveWorkflowBody { message?: string; workflow: unknown; files: Record<string, string> }
export async function saveWorkflow(projectId: string, wf: string, body: SaveWorkflowBody) {
  const r = await fetch(`${BASE}/projects/${projectId}/workflows/${wf}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j.error || `save ${r.status}`) as Error & { issues?: unknown }; err.issues = j.issues; throw err; }
  return j;
}

// ── Secrets (runtime, Redis-backed) — values are write-only from the UI ──────────
export interface SecretsInfo { names: string[]; encryptedAtRest: boolean }
export async function getSecrets(): Promise<SecretsInfo> {
  return getJSON(`/secrets`);
}
export async function putSecret(name: string, value: string): Promise<void> {
  const r = await fetch(`${BASE}/secrets/${encodeURIComponent(name)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `save failed (${r.status})`);
}
export async function deleteSecret(name: string): Promise<void> {
  const r = await fetch(`${BASE}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete failed (${r.status})`);
}
