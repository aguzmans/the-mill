export default async function load(input, ctx) {
  ctx.log.info("loading warehouse", { count: input.length, dsn: ctx.secrets.WAREHOUSE_DSN ? "present" : "missing" });
  // A real node would upsert into ctx.secrets.WAREHOUSE_DSN; the demo just counts.
  return { loaded: input.length };
}
