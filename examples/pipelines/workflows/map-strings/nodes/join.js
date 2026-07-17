export default function join(rows, ctx) {
  if (rows.length !== 3) throw new Error("continuity broken: expected 3 words");
  return { joined: rows.map((r) => r.upper).join(","), totalLen: rows.reduce((a, r) => a + r.len, 0) };
}
