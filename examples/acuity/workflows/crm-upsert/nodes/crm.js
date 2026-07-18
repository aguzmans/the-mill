export default async function crmUpsert(input, ctx) {
  const p = (input.payloads && input.payloads.crm) || input;
  const r = await fetch("https://postman-echo.com/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
  const echoed = (await r.json()).data;
  ctx.log.info("CRM upsert", { op: p.op });
  return { workload: "crm", status: r.status, sent: p, echoed };
}
