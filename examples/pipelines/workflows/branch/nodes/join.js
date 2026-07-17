// Fan-in: receives whichever branch ran. Assert the original data survived the branch.
export default function join(x, ctx) {
  if (!x || !("n" in x) || !("parity" in x)) throw new Error("continuity broken through branch");
  if (x.tag !== "seed") throw new Error("continuity broken: seed field lost through branch");
  return { n: x.n, parity: x.parity, seedKept: x.tag === "seed" };
}
