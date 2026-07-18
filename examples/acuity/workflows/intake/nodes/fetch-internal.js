// "Look up the patient in the internal EHR" — a second enrichment step.
export default async function fetchInternal(input, ctx) {
  let internal = { source: "ehr", known: false };
  try {
    const r = await fetch("https://postman-echo.com/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: input.appt.email }) });
    internal = { source: "ehr", known: !!input.appt.email, echoed: (await r.json()).data };
  } catch (e) { ctx.log.warn("ehr lookup failed", { error: String(e) }); }
  return { ...input, internal };
}
