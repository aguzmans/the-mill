import { test, expect, describe, beforeAll } from "bun:test";

// A tiny in-memory stand-in for the ioredis hash commands the SecretStore uses — keeps this a
// pure unit test (no external Redis) while exercising the real store + crypto code paths.
class FakeRedis {
  private h = new Map<string, Map<string, string>>();
  private hash(k: string) { let m = this.h.get(k); if (!m) { m = new Map(); this.h.set(k, m); } return m; }
  async hset(k: string, f: string, v: string) { this.hash(k).set(f, v); return 1; }
  async hdel(k: string, f: string) { return this.hash(k).delete(f) ? 1 : 0; }
  async hkeys(k: string) { return [...this.hash(k).keys()]; }
  async hgetall(k: string) { return Object.fromEntries(this.hash(k)); }
  async hexists(k: string, f: string) { return this.hash(k).has(f) ? 1 : 0; }
  raw(k: string, f: string) { return this.hash(k).get(f); } // test-only: inspect stored bytes
}

// The crypto key is captured at module load, so set it BEFORE importing the module.
let SecretStore: typeof import("../src/secrets").SecretStore;
let decryptSecret: typeof import("../src/secrets").decryptSecret;
let validSecretName: typeof import("../src/secrets").validSecretName;

beforeAll(async () => {
  process.env.MILL_SECRETS_KEY = "unit-test-key-please-encrypt";
  const m = await import("../src/secrets");
  SecretStore = m.SecretStore; decryptSecret = m.decryptSecret; validSecretName = m.validSecretName;
});

describe("SecretStore", () => {
  test("set → names → all round-trips; values are decrypted", async () => {
    const r = new FakeRedis();
    const s = new SecretStore(r as any, "test");
    await s.set("ACUITY_API_KEY", "sk_live_abc123");
    await s.set("ACUITY_USER_ID", "998877");

    expect(await s.names()).toEqual(["ACUITY_API_KEY", "ACUITY_USER_ID"]); // sorted
    expect(await s.has("ACUITY_API_KEY")).toBe(true);
    expect(await s.all()).toEqual({ ACUITY_API_KEY: "sk_live_abc123", ACUITY_USER_ID: "998877" });
  });

  test("values are encrypted at rest (raw bytes are not the plaintext)", async () => {
    const r = new FakeRedis();
    const s = new SecretStore(r as any, "test");
    await s.set("TOKEN", "super-secret-value");
    const stored = r.raw("test:secrets", "TOKEN")!;
    expect(s.encryptedAtRest()).toBe(true);
    expect(stored.startsWith("gcm:")).toBe(true);
    expect(stored).not.toContain("super-secret-value"); // ciphertext, not plaintext
    expect(decryptSecret(stored)).toBe("super-secret-value"); // …but decrypts back
  });

  test("delete removes a secret", async () => {
    const r = new FakeRedis();
    const s = new SecretStore(r as any, "test");
    await s.set("A", "1");
    expect(await s.remove("A")).toBe(1);
    expect(await s.names()).toEqual([]);
    expect(await s.remove("A")).toBe(0); // already gone
  });

  test("rejects invalid names", async () => {
    const r = new FakeRedis();
    const s = new SecretStore(r as any, "test");
    expect(validSecretName("ACUITY_API_KEY")).toBe(true);
    expect(validSecretName("1BAD")).toBe(false);
    expect(validSecretName("has space")).toBe(false);
    await expect(s.set("bad name", "x")).rejects.toThrow(/invalid secret name/);
  });

  test("decryptSecret tolerates legacy plaintext + plain: prefix", () => {
    expect(decryptSecret("plain:hello")).toBe("hello");
    expect(decryptSecret("legacy-no-prefix")).toBe("legacy-no-prefix");
  });

  test("scopes are isolated + stored under distinct keys", async () => {
    const r = new FakeRedis();
    const s = new SecretStore(r as any, "test");
    await s.set("API_KEY", "global-val");                                          // global
    await s.set("API_KEY", "proj-val", { kind: "project", project: "billing" });   // project
    await s.set("API_KEY", "wf-val", { kind: "workflow", project: "billing", workflow: "invoices" });

    expect(await s.names()).toEqual(["API_KEY"]);
    expect(await s.all()).toEqual({ API_KEY: "global-val" });
    expect(await s.all({ kind: "project", project: "billing" })).toEqual({ API_KEY: "proj-val" });
    expect(r.raw("test:secrets:p:billing", "API_KEY")).toBeDefined();              // distinct redis key
    expect(r.raw("test:secrets:w:billing:invoices", "API_KEY")).toBeDefined();
    // deleting a workflow secret doesn't touch the project/global one
    await s.remove("API_KEY", { kind: "workflow", project: "billing", workflow: "invoices" });
    expect(await s.all({ kind: "workflow", project: "billing", workflow: "invoices" })).toEqual({});
    expect(await s.all({ kind: "project", project: "billing" })).toEqual({ API_KEY: "proj-val" });
  });

  test("resolve() layers most-specific-wins: global < project < workflow", async () => {
    const r = new FakeRedis();
    const s = new SecretStore(r as any, "test");
    await s.set("SHARED", "g", { kind: "global" });
    await s.set("ONLY_GLOBAL", "g");
    await s.set("SHARED", "p", { kind: "project", project: "billing" });
    await s.set("ONLY_PROJECT", "p", { kind: "project", project: "billing" });
    await s.set("SHARED", "w", { kind: "workflow", project: "billing", workflow: "invoices" });

    // workflow run: sees all three layers, SHARED resolves to the workflow value
    expect(await s.resolve("billing", "invoices")).toEqual({ SHARED: "w", ONLY_GLOBAL: "g", ONLY_PROJECT: "p" });
    // project-level (no workflow): SHARED resolves to the project value; no workflow-only keys
    expect(await s.resolve("billing")).toEqual({ SHARED: "p", ONLY_GLOBAL: "g", ONLY_PROJECT: "p" });
    // a different project only gets global
    expect(await s.resolve("other")).toEqual({ SHARED: "g", ONLY_GLOBAL: "g" });
    // no project → global only
    expect(await s.resolve()).toEqual({ SHARED: "g", ONLY_GLOBAL: "g" });
  });

  test("sources() reports provenance most-specific-wins", async () => {
    const r = new FakeRedis();
    const s = new SecretStore(r as any, "test");
    await s.set("SHARED", "g");                                                   // global
    await s.set("ONLY_GLOBAL", "g");
    await s.set("SHARED", "p", { kind: "project", project: "billing" });          // project
    await s.set("SHARED", "w", { kind: "workflow", project: "billing", workflow: "invoices" });
    await s.set("WF_ONLY", "w", { kind: "workflow", project: "billing", workflow: "invoices" });

    const src = await s.sources("billing", "invoices");
    const by = Object.fromEntries(src.map((x) => [x.name, x]));
    expect(by.SHARED.source).toBe("workflow");
    expect(by.SHARED.scopes).toEqual(["global", "project", "workflow"]); // present in all three
    expect(by.ONLY_GLOBAL.source).toBe("global");
    expect(by.WF_ONLY.source).toBe("workflow");
    expect(by.WF_ONLY.scopes).toEqual(["workflow"]);
    // at project level (no workflow), SHARED's winner is project and no workflow-only names appear
    const projSrc = await s.sources("billing");
    expect(Object.fromEntries(projSrc.map((x) => [x.name, x.source])).SHARED).toBe("project");
    expect(projSrc.find((x) => x.name === "WF_ONLY")).toBeUndefined();
  });

  test("rejects unsafe project/workflow ids in a scope key", async () => {
    const r = new FakeRedis();
    const s = new SecretStore(r as any, "test");
    await expect(s.set("K", "v", { kind: "project", project: "bad:id" })).rejects.toThrow(/invalid project id/);
    await expect(s.set("K", "v", { kind: "workflow", project: "ok", workflow: "bad/../id" })).rejects.toThrow(/invalid workflow id/);
  });
});
