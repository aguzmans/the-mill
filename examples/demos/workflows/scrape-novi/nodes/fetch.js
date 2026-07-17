export default async function fetchPage(input, ctx) {
  const url = (input && input.url) || "https://novi-health.com";
  ctx.log.info("fetching page", { url });
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; mill-bot)" }, redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const html = await res.text();
  return { url, status: res.status, html };
}
