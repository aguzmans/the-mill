import { test, expect, describe } from "bun:test";
import { resolve } from "node:path";
import { InProcessExecutor, SubprocessExecutor, runWorkflow } from "../src";

const BILLING = resolve(import.meta.dir, "../../../examples/billing");
const CLI = resolve(import.meta.dir, "../../../apps/cli/src/mill.ts");
const secrets = { WAREHOUSE_DSN: "postgres://demo", SMTP_URL: "smtp://demo", API_URL: "https://demo" };

describe("end-to-end: Billing invoices (in-process)", () => {
  test("runs start → fetch → if(true) → transform → load → callScript(notify) → end", async () => {
    const r = await new InProcessExecutor().execute({ projectDir: BILLING, workflow: "invoices", input: {}, secrets });
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ loaded: 2 }); // two open invoices, loaded and passed through notify
    expect(r.statuses?.transform).toBe("succeeded");
    expect(r.statuses?.notify).toBe("succeeded");
    // callScript recursed into the notify sub-workflow (its 'post' node emitted events)
    expect(r.events.some((e) => e.type === "node" && e.node === "post")).toBe(true);
  });

  test("takes the false branch when there are no open invoices", async () => {
    const r = await runWorkflow({ projectDir: BILLING, workflow: "invoices", input: { empty: true }, secrets });
    expect(r.status).toBe("succeeded");
    expect(r.statuses?.transform).toBe("skipped");
    expect(r.statuses?.load).toBe("skipped");
  });

  test("a failing node aborts the run and names the offending node", async () => {
    const r = await runWorkflow({ projectDir: BILLING, workflow: "dunning", input: {}, secrets });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("SMTP");
    expect(r.statuses?.send).toBe("failed");
  });
});

describe("end-to-end: Billing invoices (subprocess)", () => {
  test("runs the flow in a separate Bun process and returns the result", async () => {
    const r = await new SubprocessExecutor(CLI).execute({ projectDir: BILLING, workflow: "invoices", input: {}, secrets });
    expect(r.status).toBe("succeeded");
    expect(r.result).toEqual({ loaded: 2 });
  });

  test("enforces a wall-clock cap (kills a run that exceeds wallMs)", async () => {
    const r = await new SubprocessExecutor(CLI).execute({ projectDir: BILLING, workflow: "invoices", input: {}, secrets, limits: { wallMs: 1 } });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("timeout");
  });
});
