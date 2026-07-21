import { test, expect, describe } from "bun:test";
import { MillQueue } from "../src/index";

// Fake ioredis with just the list + hash ops requeueOwn touches.
class FakeRedis {
  lists = new Map<string, string[]>();
  hashes = new Map<string, Record<string, string>>();
  l(k: string) { let a = this.lists.get(k); if (!a) { a = []; this.lists.set(k, a); } return a; }
  async lpush(k: string, v: string) { this.l(k).unshift(v); return this.l(k).length; }
  async lmove(src: string, _dst: string, from: string, to: string) {
    const s = this.l(src); if (!s.length) return null;
    const v = from === "RIGHT" ? s.pop()! : s.shift()!;
    if (to === "LEFT") this.l(_dst).unshift(v); else this.l(_dst).push(v);
    return v;
  }
  async hset(k: string, obj: Record<string, string>) { this.hashes.set(k, { ...(this.hashes.get(k) ?? {}), ...obj }); return 1; }
}

describe("MillQueue.requeueOwn — reclaim a same-id pod's orphaned jobs on restart", () => {
  test("drains this worker's processing list back to the queue and marks jobs queued", async () => {
    const r = new FakeRedis();
    const q = new MillQueue(r as any);
    await r.lpush("mill:processing:w-abc", JSON.stringify({ id: "job1", workflow: "x" }));
    await r.lpush("mill:processing:w-abc", JSON.stringify({ id: "job2", workflow: "y" }));

    expect(await q.requeueOwn("w-abc")).toBe(2);
    expect(r.l("mill:processing:w-abc").length).toBe(0);   // drained
    expect(r.l("mill:queue").length).toBe(2);              // back on the queue for any worker
    expect(r.hashes.get("mill:job:job1")?.status).toBe("queued");
    expect(r.hashes.get("mill:job:job1")?.requeued).toBe("true");
  });

  test("no-op when there's nothing orphaned", async () => {
    const q = new MillQueue(new FakeRedis() as any);
    expect(await q.requeueOwn("w-none")).toBe(0);
  });
});
