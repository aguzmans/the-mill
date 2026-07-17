// CONTINUITY GATE: assert the previous step's output arrived intact, then transform each type.
export default function derive(input, ctx) {
  for (const k of ["num", "str", "bool", "nil", "arr", "obj", "nested"])
    if (!(k in input)) throw new Error("continuity broken: missing key '" + k + "'");
  if (input.num !== 42 || input.str !== "mill") throw new Error("continuity broken: scalar not threaded");
  return {
    num2: input.num * 2,
    upper: input.str.toUpperCase(),
    notBool: !input.bool,
    isNull: input.nil === null,
    arrSum: input.arr.reduce((s, x) => s + x, 0),
    objKeys: Object.keys(input.obj),
    deep: input.nested.items.map((i) => i.x),
  };
}
