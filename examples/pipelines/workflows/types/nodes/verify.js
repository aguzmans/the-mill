// Assert the derived output equals the expected — proves the transform's output flowed here intact.
export default function verify(input, ctx) {
  const exp = { num2: 84, upper: "MILL", notBool: false, isNull: true, arrSum: 10, objKeys: ["a", "b"], deep: [10, 20] };
  for (const k of Object.keys(exp)) {
    const got = JSON.stringify(input[k]), want = JSON.stringify(exp[k]);
    if (got !== want) throw new Error(`continuity broken at '${k}': ${got} !== ${want}`);
  }
  ctx.log.info("all data types threaded intact", { checked: Object.keys(exp).length });
  return { ok: true, checked: Object.keys(exp).length };
}
