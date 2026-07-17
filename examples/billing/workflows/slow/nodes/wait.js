export default async function wait(input, ctx) {
  const ms = (input && input.ms) || 9000;
  ctx.log.info("working slowly…", { ms });
  await new Promise((r) => setTimeout(r, ms));
  return { done: true, sleptMs: ms };
}
