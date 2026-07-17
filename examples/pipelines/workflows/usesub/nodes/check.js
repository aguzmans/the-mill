// Assert the sub-workflow's output flowed back into this step intact.
export default function check(input, ctx) {
  if (!input || input.doubled !== 42) throw new Error("continuity broken across callScript: expected { doubled:42 }, got " + JSON.stringify(input));
  return { ok: true, doubled: input.doubled };
}
