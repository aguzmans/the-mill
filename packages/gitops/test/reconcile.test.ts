import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, cpSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRepo, reconcile, type RepoState } from "../src";

const BILLING = resolve(import.meta.dir, "../../../examples/billing");
const BAD_WORKFLOW = `apiVersion: mill/v1
kind: Workflow
metadata: { name: invoices }
nodes:
  - { key: a, kind: jscode, name: A, file: nodes/a.js }
edges: []
`; // no start, no end → fails validation

async function git(args: string[], cwd?: string) {
  const p = Bun.spawn(["git", "-c", "user.email=ci@mill.dev", "-c", "user.name=Mill CI", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

let base: string, remote: string, author: string, work: string, state: RepoState;

async function commitPush(message: string) {
  await git(["add", "-A"], author);
  await git(["commit", "-q", "-m", message], author);
  await git(["push", "-q", "origin", "main"], author);
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "mill-gitops-"));
  remote = join(base, "remote.git");
  author = join(base, "author");
  work = join(base, "work");

  await git(["init", "-q", "--bare", "-b", "main", remote]);
  await git(["init", "-q", "-b", "main", author]);
  cpSync(BILLING, join(author, "billing"), { recursive: true });
  await git(["remote", "add", "origin", remote], author);
  await commitPush("seed billing");

  state = await openRepo(remote, work, "main");
});

afterAll(() => { if (base && existsSync(base)) rmSync(base, { recursive: true, force: true }); });

describe("openRepo", () => {
  test("clones into a NON-empty working copy (a PVC's lost+found)", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(base, "pvc-workdir");
    mkdirSync(join(dir, "lost+found"), { recursive: true }); // simulate an ext4 PVC root
    writeFileSync(join(dir, "lost+found", ".keep"), "");
    const st = await openRepo(remote, dir, "main"); // git clone would fail here — init-in-place must work
    expect(st.syncedRevision).toMatch(/^[0-9a-f]{7,}$/);
    expect(existsSync(join(dir, "billing", "project.yaml"))).toBe(true);
  });
});

describe("reconcile", () => {
  test("a valid revision reconciles to Synced / Healthy", async () => {
    const s = await reconcile(state);
    expect(s.sync).toBe("Synced");
    expect(s.health).toBe("Healthy");
    expect(s.projects.find((p) => p.id === "billing")?.health).toBe("Healthy");
    expect(s.syncedRevision).toBe(s.targetRevision);
  });

  test("a bad commit → Degraded, keeps last-known-good (does not advance)", async () => {
    const good = state.syncedRevision;
    writeFileSync(join(author, "billing/workflows/invoices/workflow.yaml"), BAD_WORKFLOW);
    await commitPush("break invoices");

    const s = await reconcile(state);
    expect(s.health).toBe("Degraded");
    expect(s.sync).toBe("OutOfSync");
    expect(s.error).toContain("last-known-good");
    expect(s.syncedRevision).toBe(good); // NOT advanced to the bad revision
    expect(s.targetRevision).not.toBe(good); // git moved ahead
    const billing = s.projects.find((p) => p.id === "billing");
    expect(billing?.health).toBe("Degraded");
    expect(billing?.workflows.find((w) => w.name === "invoices")?.ok).toBe(false);
  });

  test("a fix commit reconciles forward to Synced / Healthy again", async () => {
    cpSync(join(BILLING, "workflows/invoices/workflow.yaml"), join(author, "billing/workflows/invoices/workflow.yaml"));
    await commitPush("fix invoices");

    const s = await reconcile(state);
    expect(s.sync).toBe("Synced");
    expect(s.health).toBe("Healthy");
    expect(s.syncedRevision).toBe(s.targetRevision);
  });

  test("a broken node .js → workflow Degraded but the revision still applies (healthy ones keep serving)", async () => {
    // valid graph, but the node source has a syntax error (a shell comment — the site-check bug)
    writeFileSync(join(author, "billing/workflows/heartbeat/nodes/beat.js"), "export default async () => ({ ok: true })\n# manual apply test\n");
    await commitPush("break heartbeat node source");

    const s = await reconcile(state);
    expect(s.syncedRevision).toBe(s.targetRevision); // applied — a bad node file does NOT block apply
    expect(s.health).toBe("Degraded");               // …but health reflects the broken workflow
    const billing = s.projects.find((p) => p.id === "billing");
    expect(billing?.workflows.find((w) => w.name === "heartbeat")?.ok).toBe(false);
    expect(billing?.workflows.find((w) => w.name === "invoices")?.ok).toBe(true); // healthy sibling unaffected

    // restore
    cpSync(join(BILLING, "workflows/heartbeat/nodes/beat.js"), join(author, "billing/workflows/heartbeat/nodes/beat.js"));
    await commitPush("fix heartbeat");
    expect((await reconcile(state)).health).toBe("Healthy");
  });
});
