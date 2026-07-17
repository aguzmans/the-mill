// The loop BODY: runs once per URL (the item is passed as `input`). ctx.state.index is the
// current position. Errors are caught per item so one bad URL can't fail the whole batch.
export default async function fetchOne(url, ctx) {
  const i = ctx.state.index;
  try {
    const res = await fetch(url, { headers: { "user-agent": "mill-bot" }, redirect: "follow" });
    const body = await res.text();
    ctx.log.info(`fetched [${i}] ${url}`, { status: res.status, bytes: body.length });
    return { url, ok: res.ok, status: res.status, bytes: body.length };
  } catch (e) {
    ctx.log.warn(`failed [${i}] ${url}`, { error: String(e) });
    return { url, ok: false, status: 0, bytes: 0 };
  }
}
