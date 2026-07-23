import type Redis from "ioredis";
import crypto from "node:crypto";

// Runtime secret store (Redis-backed). Secrets are set/edited from the UI and injected into
// `ctx.secrets` at run time — a node only ever sees the refs it declares (`secrets: [...]`),
// scrubbed by the SDK. This is the interim "no k8s Secret round-trip" store; env/k8s Secrets
// still work and take lower precedence than a value set here.
//
// Encryption at rest: if MILL_SECRETS_KEY is set, values are AES-256-GCM encrypted in Redis
// (api + worker must share the same key). Without it, values are stored plaintext — fine for
// local/dev, NOT for shared prod (see docs/DEPLOYMENT.md § Secrets).
const KEY_ENV = process.env.MILL_SECRETS_KEY;
function keyBuf(): Buffer | null {
  return KEY_ENV ? crypto.createHash("sha256").update(KEY_ENV).digest() : null; // 32 bytes
}
export function encryptSecret(v: string): string {
  const k = keyBuf();
  if (!k) return "plain:" + v;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(v, "utf8"), c.final()]);
  return "gcm:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function decryptSecret(s: string): string {
  if (s.startsWith("plain:")) return s.slice(6);
  if (s.startsWith("gcm:")) {
    const k = keyBuf();
    if (!k) throw new Error("secret is encrypted but MILL_SECRETS_KEY is not set");
    const buf = Buffer.from(s.slice(4), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", k, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  }
  return s; // legacy plaintext (no prefix)
}

/** Secret names follow env-var conventions so a node can read `ctx.secrets.NAME`. */
export const validSecretName = (n: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n);
/** Project/workflow ids are folder names — keep them safe to embed in a Redis key. */
const validScopeId = (s: string): boolean => /^[A-Za-z0-9._-]+$/.test(s);

// A secret lives in one of three scopes. At run time they layer most-specific-wins:
//   env/k8s  <  global  <  project  <  workflow
// so a global value is a shared default that a project or a single workflow can override.
export type SecretScope =
  | { kind: "global" }
  | { kind: "project"; project: string }
  | { kind: "workflow"; project: string; workflow: string };

export const GLOBAL: SecretScope = { kind: "global" };
/** Human label for a scope (used in API responses / UI). */
export function scopeLabel(s: SecretScope): string {
  return s.kind === "global" ? "global" : s.kind === "project" ? `project:${s.project}` : `workflow:${s.project}/${s.workflow}`;
}

export class SecretStore {
  constructor(private redis: Redis, private prefix = "mill") {}

  // Per-scope Redis hash. Global keeps the original `mill:secrets` key (backward compatible),
  // so existing secrets keep working untouched.
  private hkey(scope: SecretScope = GLOBAL): string {
    if (scope.kind === "global") return `${this.prefix}:secrets`;
    if (!validScopeId(scope.project)) throw new Error(`invalid project id '${scope.project}'`);
    if (scope.kind === "project") return `${this.prefix}:secrets:p:${scope.project}`;
    if (!validScopeId(scope.workflow)) throw new Error(`invalid workflow id '${scope.workflow}'`);
    return `${this.prefix}:secrets:w:${scope.project}:${scope.workflow}`;
  }

  /** Store (or overwrite) a secret value in a scope (default: global). */
  async set(name: string, value: string, scope: SecretScope = GLOBAL): Promise<void> {
    if (!validSecretName(name)) throw new Error(`invalid secret name '${name}' — use letters, digits, underscore`);
    await this.redis.hset(this.hkey(scope), name, encryptSecret(value));
  }
  async remove(name: string, scope: SecretScope = GLOBAL): Promise<number> {
    return this.redis.hdel(this.hkey(scope), name);
  }
  /** Names only, for one scope — values are NEVER returned to the UI. */
  async names(scope: SecretScope = GLOBAL): Promise<string[]> {
    return (await this.redis.hkeys(this.hkey(scope))).sort();
  }
  async has(name: string, scope: SecretScope = GLOBAL): Promise<boolean> {
    return (await this.redis.hexists(this.hkey(scope), name)) === 1;
  }
  /** Decrypted values for one scope. */
  async all(scope: SecretScope = GLOBAL): Promise<Record<string, string>> {
    const h = await this.redis.hgetall(this.hkey(scope));
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      try { out[k] = decryptSecret(v); } catch { /* unreadable (key rotated) — skip */ }
    }
    return out;
  }
  /**
   * Effective secrets for a run: global < project < workflow, later layers overriding earlier
   * (most-specific wins). This is what the worker/step-tester injects into ctx.secrets.
   */
  async resolve(project?: string, workflow?: string): Promise<Record<string, string>> {
    const layers: SecretScope[] = [GLOBAL];
    if (project) layers.push({ kind: "project", project });
    if (project && workflow) layers.push({ kind: "workflow", project, workflow });
    const out: Record<string, string> = {};
    for (const s of layers) Object.assign(out, await this.all(s));
    return out;
  }
  /**
   * Provenance for a run's effective secrets (names only). For each name that resolves, reports
   * the winning scope (`source`) and every scope that holds it (`scopes`, precedence order) — so a
   * UI can show "API_KEY comes from workflow, overriding project + global". No values are read.
   */
  async sources(project?: string, workflow?: string): Promise<{ name: string; source: "global" | "project" | "workflow"; scopes: ("global" | "project" | "workflow")[] }[]> {
    const layers: { label: "global" | "project" | "workflow"; scope: SecretScope }[] = [{ label: "global", scope: GLOBAL }];
    if (project) layers.push({ label: "project", scope: { kind: "project", project } });
    if (project && workflow) layers.push({ label: "workflow", scope: { kind: "workflow", project, workflow } });
    const namesByLayer = await Promise.all(layers.map((l) => this.names(l.scope)));
    const map = new Map<string, ("global" | "project" | "workflow")[]>();
    layers.forEach((l, i) => { for (const n of namesByLayer[i]) map.set(n, [...(map.get(n) ?? []), l.label]); });
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, scopes]) => ({ name, source: scopes[scopes.length - 1], scopes })); // last = most-specific = winner
  }

  /** True when values are encrypted at rest (MILL_SECRETS_KEY configured). */
  encryptedAtRest(): boolean { return !!keyBuf(); }
}
