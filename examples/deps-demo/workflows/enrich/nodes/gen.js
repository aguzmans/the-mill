export default function gen(input, ctx) {
  return { events: [{ name: "cache", ttl: "2h" }, { name: "session", ttl: "30m" }, { name: "otp", ttl: "90s" }] };
}
