export default function summarize(rows, ctx) {
  if (rows.length !== 3) throw new Error("continuity broken: expected 3 rows");
  const badId = rows.find((r) => typeof r.id !== "string" || r.id.length !== 10);
  if (badId) throw new Error("nanoid did not produce a 10-char id: " + JSON.stringify(badId));
  ctx.log.info("enriched with external libs", { count: rows.length });
  return { count: rows.length, totalTtlMs: rows.reduce((s, r) => s + r.ttlMs, 0), idLen: rows[0].id.length };
}
