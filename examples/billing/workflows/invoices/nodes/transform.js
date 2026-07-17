export default async function transform(input, ctx) {
  return input
    .filter((inv) => inv.status === "open")
    .map((inv) => ({ id: inv.id, total: inv.lines.reduce((s, l) => s + l.amount, 0) }));
}
