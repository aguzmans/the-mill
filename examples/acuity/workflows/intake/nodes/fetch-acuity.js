// "GET the full appointment from Acuity" — a real outbound read (tolerant of failure).
export default async function fetchAcuity(input, ctx) {
  let acuity = { source: "acuity", ok: false };
  try {
    const r = await fetch(`https://postman-echo.com/get?apptId=${encodeURIComponent(input.appt.id)}`);
    acuity = { source: "acuity", ok: r.ok, status: r.status, detail: (await r.json()).args };
  } catch (e) { ctx.log.warn("acuity fetch failed", { error: String(e) }); }
  return { ...input, acuity };
}
