// Send the appointment confirmation (email/SMS) via your provider. Set Secrets:
//   NOTIFY_API_URL  (e.g. https://api.postmarkapp.com/email  or a Twilio/SendGrid endpoint)
//   NOTIFY_API_KEY  (provider token)
// Without them it simulates the send so the flow still runs end-to-end.
export default async function sendConfirmation(input, ctx) {
  const p = input.to ? input : (input.payloads && input.payloads.confirmation) || input;
  const url = ctx.secrets.NOTIFY_API_URL;
  const key = ctx.secrets.NOTIFY_API_KEY;

  const message = {
    to: p.to,
    channel: p.channel || "email",
    template: p.template || "reminder",
    subject: p.template === "welcome" ? "Welcome to Novi Health" : "Your appointment is confirmed",
    appt: p.appt,
  };
  if (!url) {
    ctx.log.warn("NOTIFY_API_URL not set — simulating confirmation (set it in Secrets to go live)");
    return { workload: "confirmation", simulated: true, to: p.to, template: message.template };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(message),
  });
  if (!res.ok) { ctx.log.error("notify error", { status: res.status }); throw new Error(`notify ${res.status}`); }
  ctx.log.info("confirmation sent", { to: p.to, template: message.template });
  return { workload: "confirmation", ok: true, status: res.status };
}
