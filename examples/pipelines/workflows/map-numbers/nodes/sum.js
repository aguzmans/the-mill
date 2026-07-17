// The loop's output is the array of per-item results — assert length continuity + reduce.
export default function sum(rows, ctx) {
  if (!Array.isArray(rows) || rows.length !== 5) throw new Error("continuity broken: expected 5 rows, got " + (rows && rows.length));
  return { count: rows.length, total: rows.reduce((s, r) => s + r.sq, 0) };
}
