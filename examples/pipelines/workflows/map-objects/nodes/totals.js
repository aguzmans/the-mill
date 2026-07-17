export default function totals(rows, ctx) {
  if (rows.length !== 3) throw new Error("continuity broken: expected 3 lines");
  return { lines: rows.length, grand: rows.reduce((s, r) => s + r.total, 0) };
}
