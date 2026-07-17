// The loop's output is the array of per-item results — reduce it to a summary.
export default function summarize(rows, ctx) {
  const ok = rows.filter((r) => r.ok).length;
  const totalBytes = rows.reduce((s, r) => s + (r.bytes || 0), 0);
  ctx.log.info("done", { fetched: rows.length, ok, totalBytes });
  return { fetched: rows.length, ok, failed: rows.length - ok, totalBytes };
}
