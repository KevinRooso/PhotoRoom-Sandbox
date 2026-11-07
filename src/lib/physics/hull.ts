import Matter from 'matter-js';

// ============================================================================
// Silhouette collisions — convex hull of the opaque pixels of a rasterized
// cutout texture, in body-local px centred on the body rect.
// ============================================================================

type V = { x: number; y: number };

const cross = (o: V, a: V, b: V) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Monotone-chain convex hull. */
function hullPoints(pts: V[]): V[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return [];
  const lower: V[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: V[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function triArea(a: V, b: V, c: V): number {
  return Math.abs(cross(a, b, c)) / 2;
}

/** Drop the vertex whose removal changes the polygon area least, until ≤ n. */
function simplify(hull: V[], n: number): V[] {
  const h = [...hull];
  while (h.length > n) {
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i < h.length; i++) {
      const prev = h[(i - 1 + h.length) % h.length];
      const next = h[(i + 1) % h.length];
      const cost = triArea(prev, h[i], next);
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    h.splice(best, 1);
  }
  return h;
}

function polyArea(p: V[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a) / 2;
}

/**
 * Convex hull of the opaque (alpha > 32) pixels of `tex`, expressed in
 * body-local px centred on a `bodyW`×`bodyH` rect. ≤ 16 vertices, or null
 * when the silhouette is degenerate (< 3 points or < 15% of the rect area).
 */
export function computeHull(
  tex: HTMLCanvasElement,
  bodyW: number,
  bodyH: number,
): V[] | null {
  const ctx = tex.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const { width: tw, height: th } = tex;
  if (tw < 2 || th < 2) return null;
  const data = ctx.getImageData(0, 0, tw, th).data;

  // ~64 cells along the longest side
  const grid = 64;
  const cols = tw >= th ? grid : Math.max(4, Math.round((tw / th) * grid));
  const rows = th >= tw ? grid : Math.max(4, Math.round((th / tw) * grid));
  const cw = tw / cols;
  const ch = th / rows;

  const pts: V[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = Math.min(tw - 1, Math.floor((c + 0.5) * cw));
      const py = Math.min(th - 1, Math.floor((r + 0.5) * ch));
      if (data[(py * tw + px) * 4 + 3] > 32) {
        const x0 = c * cw;
        const y0 = r * ch;
        pts.push(
          { x: x0, y: y0 },
          { x: x0 + cw, y: y0 },
          { x: x0, y: y0 + ch },
          { x: x0 + cw, y: y0 + ch },
        );
      }
    }
  }
  if (pts.length < 3) return null;
  const hull = simplify(hullPoints(pts), 16);
  if (hull.length < 3) return null;

  // tex px → body-local px centred on the rect
  const sx = bodyW / tw;
  const sy = bodyH / th;
  const local = hull.map((v) => ({ x: v.x * sx - bodyW / 2, y: v.y * sy - bodyH / 2 }));
  if (polyArea(local) < 0.15 * bodyW * bodyH) return null;
  return local;
}

/**
 * Build a silhouette body: hull body at `pos + c` (c = hull centroid), sprite
 * offsets overwritten so the texture still covers the original rect. Falls
 * back to null when the hull is degenerate (caller uses the rect path).
 */
export function createHullBody(
  x: number,
  y: number,
  w: number,
  h: number,
  key: string,
  texture: HTMLCanvasElement,
): Matter.Body | null {
  const hull = computeHull(texture, w, h);
  if (!hull) return null;
  const c = Matter.Vertices.centre(hull);
  const body = Matter.Bodies.fromVertices(c.x, c.y, [hull as Matter.Vector[]], {
    restitution: 0.35,
    friction: 0.4,
    frictionAir: 0.005,
    render: {
      sprite: {
        texture: key,
        xScale: w / Math.max(1, texture.width),
        yScale: h / Math.max(1, texture.height),
      },
    },
  });
  if (!body) return null;
  const sprite = body.render.sprite as { xOffset?: number; yOffset?: number } | undefined;
  if (sprite) {
    sprite.xOffset = (c.x + w / 2) / w;
    sprite.yOffset = (c.y + h / 2) / h;
  }
  Matter.Body.setPosition(body, { x: x + c.x, y: y + c.y });
  return body;
}
