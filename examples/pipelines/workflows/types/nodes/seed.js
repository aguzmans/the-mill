// Emit one value of every JS data type the pipeline must carry intact.
export default function seed(input, ctx) {
  return { num: 42, str: "mill", bool: true, nil: null, arr: [1, 2, 3, 4], obj: { a: 1, b: 2 }, nested: { items: [{ x: 10 }, { x: 20 }] } };
}
