export default async function createInvoice(input, ctx) {
  const p = (input.payloads && input.payloads.invoice) || input;
  const r = await fetch("https://postman-echo.com/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
  ctx.log.info("invoice created", { amountCents: p.amountCents });
  return { workload: "invoice", status: r.status, sent: p };
}
