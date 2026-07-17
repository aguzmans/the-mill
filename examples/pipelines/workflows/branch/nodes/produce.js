export default function produce(input, ctx) { return { n: (input && input.n) ?? 4, tag: "seed" }; }
