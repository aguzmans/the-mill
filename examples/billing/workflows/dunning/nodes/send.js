export default async function send(input, ctx) {
  // The "bad commit": points at a dead SMTP host, so this node fails at runtime.
  throw new Error("SMTP connection refused (ECONNREFUSED smtp.acme.io:587)");
}
