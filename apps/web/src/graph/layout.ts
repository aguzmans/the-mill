import type { NodeKind } from "../lib/mock";

/** Approximate on-canvas footprint per node kind (px), used for overlap checks. */
export const NODE_SIZE: Record<NodeKind, { w: number; h: number }> = {
  start: { w: 112, h: 44 },
  end: { w: 112, h: 44 },
  if: { w: 176, h: 72 },
  jscode: { w: 192, h: 64 },
  callScript: { w: 192, h: 66 },
  loop: { w: 192, h: 72 },
};

/** Small minimum gap between nodes — close is fine, overlapping is not. */
export const MIN_GAP = 14;

type Placed = { position: { x: number; y: number }; data?: { kind?: NodeKind } };

function overlaps(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number, gap: number) {
  return ax < bx + bw + gap && ax + aw + gap > bx && ay < by + bh + gap && ay + ah + gap > by;
}

/**
 * Returns a position near `pos` that keeps `kind` at least MIN_GAP away from every
 * existing node, so a dropped/added node is never rendered on top of another.
 * Scans downward, then wraps to a new column, until it finds a free slot.
 */
export function resolvePosition(pos: { x: number; y: number }, kind: NodeKind, nodes: Placed[]): { x: number; y: number } {
  const s = NODE_SIZE[kind];
  const boxes = nodes.map((n) => {
    const size = NODE_SIZE[n.data?.kind ?? "jscode"];
    return { x: n.position.x, y: n.position.y, w: size.w, h: size.h };
  });
  const hits = (x: number, y: number) => boxes.some((b) => overlaps(x, y, s.w, s.h, b.x, b.y, b.w, b.h, MIN_GAP));

  let { x, y } = pos;
  const startY = y;
  const stepY = s.h + MIN_GAP;
  const stepX = s.w + MIN_GAP;
  let guard = 0;
  while (hits(x, y) && guard++ < 300) {
    y += stepY;
    if (y > startY + stepY * 6) {
      y = startY;
      x += stepX;
    }
  }
  return { x, y };
}
