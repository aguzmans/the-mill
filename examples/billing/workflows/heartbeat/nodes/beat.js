export default async function beat(input, ctx) {
  ctx.log.info("heartbeat tick", { at: input });
  return { ok: true };
}
