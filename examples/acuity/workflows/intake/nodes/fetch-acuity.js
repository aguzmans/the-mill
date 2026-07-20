// Fetch the FULL appointment from Acuity's API. Acuity's webhook only sends `id` + `action` +
// `appointmentTypeID` — every real detail (name, email, price, type) comes from this call.
// Auth is HTTP Basic with your Acuity User ID + API key, read from Mill Secrets (never in git):
//   ACUITY_USER_ID, ACUITY_API_KEY   (set them on the Secrets page)
export default async function fetchAcuity(input, ctx) {
  const id = input.id || (input.appt && input.appt.id);
  const userId = ctx.secrets.ACUITY_USER_ID;
  const apiKey = ctx.secrets.ACUITY_API_KEY;

  if (!id) {
    ctx.log.warn("no appointment id on the webhook — nothing to fetch");
    return { ...input, appt: input.appt || {} };
  }
  // No creds yet → don't fail the run; route on the webhook fields and flag it (so you can wire
  // secrets and re-run). Once ACUITY_USER_ID/ACUITY_API_KEY are set, this fetches for real.
  if (!userId || !apiKey) {
    ctx.log.warn("ACUITY_USER_ID / ACUITY_API_KEY not set — skipping live fetch (add them in Secrets)");
    return { ...input, appt: input.appt || { id: String(id) }, acuity: { fetched: false, reason: "no credentials" } };
  }

  const auth = "Basic " + Buffer.from(`${userId}:${apiKey}`).toString("base64");
  const res = await fetch(`https://acuityscheduling.com/api/v1/appointments/${encodeURIComponent(id)}`, {
    headers: { authorization: auth, accept: "application/json" },
  });
  if (!res.ok) {
    ctx.log.error("Acuity API error", { id, status: res.status });
    throw new Error(`Acuity API ${res.status} fetching appointment ${id}`);
  }
  const a = await res.json();
  ctx.log.info("fetched appointment", { id: a.id, type: a.type, email: a.email });
  // Normalize into the shape consolidate.js routes on.
  return {
    ...input,
    appt: {
      id: String(a.id),
      type: a.type,
      appointmentTypeID: a.appointmentTypeID,
      email: a.email,
      name: `${a.firstName || ""} ${a.lastName || ""}`.trim(),
      price: Number(a.price || 0),
      datetime: a.datetime,
      raw: a, // keep the full payload for downstream workloads
    },
    acuity: { fetched: true },
  };
}
