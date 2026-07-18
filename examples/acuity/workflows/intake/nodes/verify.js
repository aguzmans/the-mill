// Universal webhook front door: works for ANY of the 10-12 sources. ctx.request carries the
// raw body + headers + query, so we can (a) verify the provider's HMAC signature and
// (b) parse whatever format they sent (JSON already parsed into `input`; else parse raw).
import crypto from "node:crypto";
export default function verify(input, ctx) {
  const req = ctx.request;
  if (!req) return input; // manual/cron run — no HTTP request
  // Optional signature check (skip if this source doesn't sign / secret not configured).
  const sig = req.headers["x-webhook-signature"] || req.headers["x-signature"];
  const secret = ctx.secrets.WEBHOOK_SECRET;
  if (secret && sig) {
    const expected = crypto.createHmac("sha256", secret).update(req.raw).digest("hex");
    if (sig !== expected) throw new Error("invalid webhook signature — rejected");
    ctx.log.info("signature verified");
  }
  // Parse anything: JSON/form already in `input`; otherwise parse the raw body here (e.g. XML).
  let body = input;
  if ((!body || Object.keys(body).length === 0) && req.raw) {
    try { body = JSON.parse(req.raw); } catch { body = { raw: req.raw }; }
  }
  ctx.log.info("webhook accepted", { contentType: req.contentType, bytes: req.raw.length });
  return body;
}
