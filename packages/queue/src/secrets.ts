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

export class SecretStore {
  constructor(private redis: Redis, private prefix = "mill") {}
  private hkey(): string { return `${this.prefix}:secrets`; }

  /** Store (or overwrite) a secret value. */
  async set(name: string, value: string): Promise<void> {
    if (!validSecretName(name)) throw new Error(`invalid secret name '${name}' — use letters, digits, underscore`);
    await this.redis.hset(this.hkey(), name, encryptSecret(value));
  }
  async remove(name: string): Promise<number> {
    return this.redis.hdel(this.hkey(), name);
  }
  /** Names only — values are NEVER returned to the UI. */
  async names(): Promise<string[]> {
    return (await this.redis.hkeys(this.hkey())).sort();
  }
  async has(name: string): Promise<boolean> {
    return (await this.redis.hexists(this.hkey(), name)) === 1;
  }
  /** Decrypted values, for the worker/step-tester to inject into ctx.secrets. */
  async all(): Promise<Record<string, string>> {
    const h = await this.redis.hgetall(this.hkey());
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      try { out[k] = decryptSecret(v); } catch { /* unreadable (key rotated) — skip */ }
    }
    return out;
  }
  /** True when values are encrypted at rest (MILL_SECRETS_KEY configured). */
  encryptedAtRest(): boolean { return !!keyBuf(); }
}
