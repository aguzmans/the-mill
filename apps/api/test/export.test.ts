import { test, expect, describe } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { exportProject } from "../src/export";
import { listWorkflows } from "@mill/projectfs";

const example = (name: string) => resolve(import.meta.dir, "../../../examples", name);

/** Export a project and extract the bundle to a temp dir; returns the dir + a cleanup fn. */
async function extract(projectDir: string) {
  const { tgz, name } = await exportProject(projectDir);
  const dir = mkdtempSync(join(tmpdir(), "mill-bundle-"));
  writeFileSync(join(dir, "bundle.tgz"), tgz);
  await Bun.spawn(["tar", "-xzf", "bundle.tgz"], { cwd: dir }).exited;
  return { dir, name, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run one workflow from an extracted bundle in batch mode; returns stdout JSON. */
async function runBatch(dir: string, workflow: string, input = "{}") {
  const proc = Bun.spawn(["bun", "run", join(dir, "index.js"), workflow, input], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { out: out.trim(), err, code: proc.exitCode };
}

describe("exportProject — batch mode (some scripts just run)", () => {
  test("billing/invoices runs to the same result", async () => {
    const { dir, name, cleanup } = await extract(example("billing"));
    try {
      expect(name).toBe("billing");
      const { out, err } = await runBatch(dir, "invoices");
      expect(out, `stderr: ${err}`).toContain('"loaded":2');
    } finally { cleanup(); }
  }, 30000);

  test("pipelines: loop + continuity workflows run standalone (all match in-Mill output)", async () => {
    const { dir, cleanup } = await extract(example("pipelines"));
    try {
      expect((await runBatch(dir, "map-numbers")).out).toBe(JSON.stringify({ count: 5, total: 55 }));   // loop body bundled
      expect((await runBatch(dir, "map-mixed")).out).toContain('"total":6');                             // iterate mixed types
      expect((await runBatch(dir, "types")).out).toBe(JSON.stringify({ ok: true, checked: 7 }));         // data-type continuity
      expect((await runBatch(dir, "usesub")).out).toBe(JSON.stringify({ ok: true, doubled: 42 }));       // callScript across bundle
    } finally { cleanup(); }
  }, 40000);

  test("EVERY pipelines workflow runs standalone with exit 0 (export + test all scripts)", async () => {
    const { dir, cleanup } = await extract(example("pipelines"));
    try {
      for (const wf of listWorkflows(example("pipelines"))) {
        const { out, err, code } = await runBatch(dir, wf);
        expect(code, `${wf} failed: ${err}`).toBe(0);
        expect(out.length, `${wf} produced no output`).toBeGreaterThan(0);
      }
    } finally { cleanup(); }
  }, 60000);
});

describe("exportProject — external dependencies", () => {
  test("run.sh alone installs deps and runs — no manual bun install", async () => {
    const { dir, cleanup } = await extract(example("deps-demo"));
    try {
      // deps a node declared must land in the bundle's package.json (so the export is portable)
      const pkg = JSON.parse(await Bun.file(join(dir, "package.json")).text());
      expect(pkg.dependencies).toHaveProperty("ms");
      expect(pkg.dependencies).toHaveProperty("nanoid");
      expect(existsSync(join(dir, "node_modules"))).toBe(false); // nothing installed yet

      // Just run the .sh — it must do EVERYTHING (install ms+nanoid, then execute).
      const proc = Bun.spawn(["bash", join(dir, "run.sh"), "enrich", "{}"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      expect(proc.exitCode, `stderr: ${err}`).toBe(0);
      expect(err).toContain("installing dependencies");   // run.sh installed on first run
      expect(existsSync(join(dir, "node_modules", "ms"))).toBe(true);
      expect(out).toContain('"totalTtlMs":9090000');
    } finally { cleanup(); }
  }, 60000);
});

describe("exportProject — server mode (others expose an API port)", () => {
  test("serve exposes /health + POST /run/<workflow>", async () => {
    const { dir, cleanup } = await extract(example("pipelines"));
    const port = 8931;
    // launch via run.sh — proves the .sh brings up the API server too
    const server = Bun.spawn(["bash", join(dir, "run.sh"), "serve", String(port)], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    try {
      // wait for the server to come up
      let up = false;
      for (let i = 0; i < 50 && !up; i++) {
        try { const r = await fetch(`http://localhost:${port}/health`); up = r.ok; } catch { await Bun.sleep(100); }
      }
      expect(up, "server did not start").toBe(true);

      const health = await (await fetch(`http://localhost:${port}/health`)).json();
      expect(health.ok).toBe(true);
      expect(health.workflows.map((w: { name: string }) => w.name)).toContain("map-numbers");

      const run = await (await fetch(`http://localhost:${port}/run/map-numbers`, { method: "POST", body: "{}" })).json();
      expect(run).toEqual({ status: "succeeded", workflow: "map-numbers", result: { count: 5, total: 55 } });

      // webhook alias + input passthrough
      const hook = await (await fetch(`http://localhost:${port}/hooks/branch`, { method: "POST", body: JSON.stringify({ n: 7 }) })).json();
      expect(hook.result).toEqual({ n: 7, parity: "odd", seedKept: true });

      const missing = await fetch(`http://localhost:${port}/run/nope`, { method: "POST", body: "{}" });
      expect(missing.status).toBe(404);
    } finally {
      server.kill();
      cleanup();
    }
  }, 40000);
});

describe("exportProject — .env.example (secrets the workload needs)", () => {
  test("lists declared secrets with their usage sites + example values", async () => {
    const { dir, cleanup } = await extract(example("acuity"));
    try {
      const env = readFileSync(join(dir, ".env.example"), "utf8");
      // every declared secret is present as an active KEY=value line
      for (const s of ["ACUITY_USER_ID", "ACUITY_API_KEY", "BILLING_API_URL", "CRM_API_KEY", "NOTIFY_API_URL", "WEBHOOK_SECRET"]) {
        expect(env, `missing ${s}`).toContain(`\n${s}=`);
      }
      expect(env).toContain("used by: intake/fetch-acuity");   // annotated with the node that uses it
      expect(env).toMatch(/_URL=https:\/\//);                  // URL-name heuristic → sample URL
      expect(env).toContain("ACUITY_USER_ID=your-acuity-user-id");
      // README advertises the secret requirement
      expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("This workload needs");
    } finally { cleanup(); }
  }, 30000);

  test("a project with no secrets gets a clear placeholder file", async () => {
    const { dir, cleanup } = await extract(example("pipelines"));
    try {
      expect(readFileSync(join(dir, ".env.example"), "utf8")).toContain("declares no secrets");
    } finally { cleanup(); }
  }, 30000);

  test("flags secrets referenced in code but NOT declared (so they won't be injected)", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mill-proj-"));
    const nodes = join(proj, "workflows", "w", "nodes");
    mkdirSync(nodes, { recursive: true });
    writeFileSync(join(proj, "project.yaml"), "apiVersion: mill/v1\nkind: Project\nmetadata:\n  name: synth\n");
    writeFileSync(join(proj, "workflows", "w", "workflow.yaml"),
      "apiVersion: mill/v1\nkind: Workflow\nmetadata:\n  name: w\nnodes:\n" +
      "  - { key: start, kind: start }\n" +
      "  - { key: step, kind: jscode, file: nodes/step.js, secrets: [ DECLARED_KEY ] }\n" +
      "  - { key: end, kind: end }\nedges:\n" +
      "  - { from: start, to: step }\n  - { from: step, to: end }\n");
    writeFileSync(join(nodes, "step.js"), "export default (i, ctx) => ({ a: ctx.secrets.DECLARED_KEY, b: ctx.secrets.UNDECLARED_TOKEN });\n");
    try {
      const { dir, cleanup } = await extract(proj);
      try {
        const env = readFileSync(join(dir, ".env.example"), "utf8");
        expect(env).toContain("DECLARED_KEY=");        // declared → active line
        expect(env).toContain("NOT declared");         // warning section present
        expect(env).toContain("# UNDECLARED_TOKEN=");  // commented out (won't be injected)
      } finally { cleanup(); }
    } finally { rmSync(proj, { recursive: true, force: true }); }
  }, 30000);
});
