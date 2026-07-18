// The fanout node returns [{ workflow, ok, result|error }] — summarize the batch.
export default function summarize(results, ctx) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  ctx.log.info("dispatch complete", { called: results.map((r) => r.workflow), ok: ok.length, failed: failed.length });
  return { dispatched: results.length, ok: ok.length, failed: failed.length, workloads: results.map((r) => ({ workflow: r.workflow, ok: r.ok })) };
}
