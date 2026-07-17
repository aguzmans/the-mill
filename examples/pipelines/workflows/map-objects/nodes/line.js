export default function line(item, ctx) {
  if (!item || typeof item !== "object" || !("price" in item)) throw new Error("continuity broken: bad line item");
  return { sku: item.sku, total: item.price * item.qty };
}
