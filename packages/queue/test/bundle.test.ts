import { test, expect, describe } from "bun:test";
import { MillQueue } from "../src/index";

// Minimal ioredis stand-in for the string commands the bundle cache uses (SET .. EX .. NX, GET,
// EXISTS) — keeps this a pure unit test of the publish-once-per-revision behaviour.
class FakeRedis {
  store = new Map<string, string>();
  async set(key: string, val: string, ..._args: unknown[]) {
    const nx = _args.includes("NX");
    if (nx && this.store.has(key)) return null; // NX: don't overwrite
    this.store.set(key, val);
    return "OK";
  }
  async get(key: string) { return this.store.get(key) ?? null; }
  async exists(key: string) { return this.store.has(key) ? 1 : 0; }
}

describe("MillQueue bundle cache", () => {
  const q = new MillQueue(new FakeRedis() as any);

  test("key is project@revision namespaced", () => {
    expect(q.bundleKeyFor("billing", "abc123")).toBe("mill:bundle:billing@abc123");
  });

  test("put → exists → get round-trips the file map", async () => {
    const key = q.bundleKeyFor("billing", "rev1");
    expect(await q.bundleExists(key)).toBe(false);
    await q.putBundle(key, { "project.yaml": "kind: Project", "workflows/x/workflow.yaml": "kind: Workflow" });
    expect(await q.bundleExists(key)).toBe(true);
    expect(await q.getBundle(key)).toEqual({ "project.yaml": "kind: Project", "workflows/x/workflow.yaml": "kind: Workflow" });
  });

  test("putBundle is write-once per revision (NX) — a re-publish does not clobber", async () => {
    const key = q.bundleKeyFor("billing", "rev2");
    await q.putBundle(key, { "project.yaml": "v1" });
    await q.putBundle(key, { "project.yaml": "v2-should-be-ignored" });
    expect((await q.getBundle(key))!["project.yaml"]).toBe("v1");
  });

  test("missing bundle → null", async () => {
    expect(await q.getBundle(q.bundleKeyFor("nope", "x"))).toBeNull();
  });
});
