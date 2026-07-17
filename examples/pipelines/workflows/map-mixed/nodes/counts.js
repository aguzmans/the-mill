export default function counts(rows, ctx) {
  if (rows.length !== 6) throw new Error("continuity broken: expected 6 values");
  const byType = {};
  for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
  return { total: rows.length, byType };
}
