// Produce the work-list. In a real flow this array would come from a DB query, an API
// page, or a prior script's output — here a few stable endpoints to fan out over.
export default function gen(input, ctx) {
  const urls = (input && Array.isArray(input.urls) && input.urls.length)
    ? input.urls
    : [
        "https://api.github.com/zen",
        "https://novi-health.com",
        "https://example.com",
      ];
  ctx.log.info("fanning out", { count: urls.length });
  return { urls };
}
