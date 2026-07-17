// A reusable sub-workflow: returns its { value } doubled. Defaults so it also runs
// standalone; when called from `usesub` it receives a real { value } and continuity holds.
export default function dbl(input, ctx) {
  const value = input && typeof input.value === "number" ? input.value : 1;
  return { doubled: value * 2 };
}
