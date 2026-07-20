// Upsert the patient into your CRM. Point it at your real CRM by setting Secrets:
//   CRM_API_URL   (e.g. https://api.hubapi.com/crm/v3/objects/contacts)
//   CRM_API_KEY   (Bearer token)
// Without them it simulates the upsert so the flow still runs end-to-end.
export default async function crmUpsert(input, ctx) {
  const p = input.patient ? input : (input.payloads && input.payloads.crm) || input;
  const url = ctx.secrets.CRM_API_URL;
  const key = ctx.secrets.CRM_API_KEY;

  if (!url) {
    ctx.log.warn("CRM_API_URL not set — simulating CRM upsert (set it in Secrets to go live)");
    return { workload: "crm", simulated: true, op: p.op, email: p.patient && p.patient.email };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ op: p.op, status: p.status, patient: p.patient }),
  });
  if (!res.ok) { ctx.log.error("CRM error", { status: res.status }); throw new Error(`CRM ${res.status}`); }
  ctx.log.info("CRM upsert", { op: p.op, email: p.patient && p.patient.email });
  return { workload: "crm", ok: true, status: res.status };
}
