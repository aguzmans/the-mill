export default async function fetch(input, ctx) {
  ctx.log.info("fetching invoices", { since: (input && input.since) || null });
  if (input && input.empty) return []; // lets the demo exercise the false branch
  return [
    { id: "INV-1", status: "open", lines: [{ amount: 100 }, { amount: 50 }] },
    { id: "INV-2", status: "open", lines: [{ amount: 200 }] },
    { id: "INV-3", status: "paid", lines: [{ amount: 30 }] },
  ];
}
