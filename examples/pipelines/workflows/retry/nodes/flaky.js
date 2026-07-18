// Transient failure: throws on the first two attempts, succeeds on the third. ctx.state
// persists across a node's retry attempts, so it can count them.
export default function flaky(input, ctx) {
  ctx.state.tries = (ctx.state.tries || 0) + 1;
  if (ctx.state.tries < 3) throw new Error(`transient failure (attempt ${ctx.state.tries})`);
  return { ok: true, tries: ctx.state.tries };
}
