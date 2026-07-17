// loop body — one number per call. ctx.state.index is the position.
export default function square(n, ctx) {
  if (typeof n !== "number") throw new Error("expected a number, got " + typeof n);
  return { n, sq: n * n, at: ctx.state.index };
}
