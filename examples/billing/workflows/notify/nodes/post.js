export default async function post(input, ctx) {
  ctx.log.info("posting to slack", { loaded: input && input.loaded });
  return input; // pass-through, so the caller's result flows on to its End
}
