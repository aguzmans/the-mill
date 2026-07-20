// "Look up the patient in the internal EHR" — a second enrichment step. Swap the URL/auth for
// your real EHR (use ctx.secrets for its API key, like fetch-acuity does).
export default async function fetchInternal(input, ctx) {
  const email = (input.appt && input.appt.email) || input.email || "";
  let internal = { source: "ehr", known: false };
  try {
    const r = await fetch("https://postman-echo.com/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    internal = { source: "ehr", known: !!email, echoed: (await r.json()).data };
  } catch (e) { ctx.log.warn("ehr lookup failed", { error: String(e) }); }
  return { ...input, internal };
}
