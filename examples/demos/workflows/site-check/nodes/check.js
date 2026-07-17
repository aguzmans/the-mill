export default async function check(input, ctx) {
  const url = (input && input.url) || "https://novi-health.com";
  const t = Date.now();
  const res = await fetch(url, { headers: { "user-agent": "mill-uptime" } });
  await res.text();
  const ms = Date.now() - t;
  ctx.log.info("site check", { url, status: res.status, ms });
  return { url, up: res.ok, status: res.status, ms };
}
