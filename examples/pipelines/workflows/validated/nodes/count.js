export default function count(input, ctx) { return { total: input.items.length, sum: input.items.reduce((s, x) => s + x, 0) }; }
