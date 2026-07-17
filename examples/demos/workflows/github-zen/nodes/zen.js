export default async function zen(input, ctx) {
  const res = await fetch("https://api.github.com/zen", { headers: { "user-agent": "mill-bot" } });
  const quote = (await res.text()).trim();
  ctx.log.info("zen", { quote });
  return { quote, at: new Date().toISOString() };
}
