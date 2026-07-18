export default async function sendConfirmation(input, ctx) {
  const p = (input.payloads && input.payloads.confirmation) || input;
  const r = await fetch("https://postman-echo.com/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
  ctx.log.info("confirmation sent", { to: p.to, template: p.template });
  return { workload: "confirmation", status: r.status, sent: p };
}
