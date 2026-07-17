// Handles every data type without throwing — proves iteration over heterogeneous data.
export default function classify(v, ctx) {
  const type = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  return { at: ctx.state.index, type };
}
