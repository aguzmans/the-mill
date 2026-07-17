export default function shout(s, ctx) {
  if (typeof s !== "string") throw new Error("continuity broken: expected string, got " + typeof s);
  return { s, len: s.length, upper: s.toUpperCase() };
}
