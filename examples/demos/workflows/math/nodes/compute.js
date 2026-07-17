export default async function compute(input, ctx) {
  // Try modifying the input: {"numbers":[10,20,30]}
  const numbers = (input && Array.isArray(input.numbers)) ? input.numbers : [1, 2, 3, 4, 5];
  const sum = numbers.reduce((a, b) => a + b, 0);
  ctx.log.info("computing", { count: numbers.length });
  return { count: numbers.length, sum, mean: sum / numbers.length, max: Math.max(...numbers), min: Math.min(...numbers) };
}
