#!/usr/bin/env bun
// End-to-end smoke test for the local Gate-2 stack (run after `docker compose up redis api worker`).
// Triggers workflows over HTTP, waits for the worker to run them, and checks results + live events.
const BASE = (process.env.MILL_API ?? "http://localhost:8787") + "/api";
let failures = 0;
const check = (name: string, cond: boolean) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) failures++; };

async function waitHealth(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`API never became healthy at ${BASE}`);
}
async function trigger(project: string, wf: string, input: unknown): Promise<string> {
  const r = await fetch(`${BASE}/projects/${project}/workflows/${wf}/trigger`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }),
  });
  if (!r.ok) throw new Error(`trigger ${wf} failed: ${r.status}`);
  return (await r.json()).jobId;
}
async function waitJob(id: string, tries = 80): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const j = await (await fetch(`${BASE}/jobs/${id}`)).json();
    if (j.status === "succeeded" || j.status === "failed") return j;
    await Bun.sleep(300);
  }
  throw new Error(`job ${id} did not finish`);
}

await waitHealth();
console.log(`API healthy at ${BASE}\n`);

const projects = await (await fetch(`${BASE}/projects`)).json();
check("lists the billing project", projects.some((p: any) => p.id === "billing"));

// invoices — happy path across all five node kinds, with a callScript into 'notify'
const id1 = await trigger("billing", "invoices", {});
const j1 = await waitJob(id1);
check("invoices job succeeded", j1.status === "succeeded");
check("invoices result = { loaded: 2 }", j1.result?.loaded === 2);

// live event stream (SSE) — per-node status + the callScript recursion
const evText = await (await fetch(`${BASE}/jobs/${id1}/events`)).text();
check("event stream shows the 'load' node succeeding", evText.includes('"node":"load"') && evText.includes('"status":"succeeded"'));
check("callScript recursed into notify (its 'post' node ran)", evText.includes('"node":"post"'));

// invoices false-branch — no open invoices → transform/load skipped
const j2 = await waitJob(await trigger("billing", "invoices", { empty: true }));
check("invoices (empty) still succeeds", j2.status === "succeeded");

// dunning — a failing node aborts the run
const j3 = await waitJob(await trigger("billing", "dunning", {}));
check("dunning job failed", j3.status === "failed");
check("dunning error mentions SMTP", String(j3.error).includes("SMTP"));

// workers registered via heartbeat
const w = await (await fetch(`${BASE}/workers`)).json();
check("at least one worker registered", (w.workers ?? []).length >= 1);

// GitOps: the controller cloned + reconciled the repo
async function waitStatus(tries = 40): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const s = await (await fetch(`${BASE}/status`)).json();
    if (!s.pending) return s;
    await Bun.sleep(300);
  }
  throw new Error("reconcile status stayed pending");
}
const st = await waitStatus();
check("repo reconciled to Synced / Healthy", st.sync === "Synced" && st.health === "Healthy");
check("billing project reported Healthy", st.projects?.find((p: any) => p.id === "billing")?.health === "Healthy");

console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED ✅");
process.exit(failures ? 1 : 0);
