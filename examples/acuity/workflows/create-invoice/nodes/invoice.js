// Create the visit invoice in your billing system. Set Secrets:
//   BILLING_API_URL  (e.g. https://api.stripe.com/v1/invoiceitems, or your billing service)
//   BILLING_API_KEY  (Bearer token / Stripe secret key)
// Without them it simulates the invoice so the flow still runs end-to-end.
export default async function createInvoice(input, ctx) {
  const p = input.customer ? input : (input.payloads && input.payloads.invoice) || input;
  const url = ctx.secrets.BILLING_API_URL;
  const key = ctx.secrets.BILLING_API_KEY;

  const invoice = { customer: p.customer, amountCents: p.amountCents, currency: p.currency || "usd", memo: p.memo };
  if (!url) {
    ctx.log.warn("BILLING_API_URL not set — simulating invoice (set it in Secrets to go live)");
    return { workload: "invoice", simulated: true, customer: p.customer, amountCents: p.amountCents };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(invoice),
  });
  if (!res.ok) { ctx.log.error("billing error", { status: res.status }); throw new Error(`billing ${res.status}`); }
  ctx.log.info("invoice created", { customer: p.customer, amountCents: p.amountCents });
  return { workload: "invoice", ok: true, status: res.status };
}
