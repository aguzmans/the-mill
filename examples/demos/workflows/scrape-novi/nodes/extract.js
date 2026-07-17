export default async function extract(input, ctx) {
  const html = input.html || "";
  const pick = (re) => (html.match(re) || [, ""])[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const result = {
    url: input.url,
    status: input.status,
    title: decode(pick(/<title[^>]*>([\s\S]*?)<\/title>/i)),
    h1: decode(pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i)).slice(0, 140),
    links: (html.match(/<a\b/gi) || []).length,
    images: (html.match(/<img\b/gi) || []).length,
    bytes: html.length,
  };
  ctx.log.info("extracted", { title: result.title, links: result.links });
  return result;
}
