import Matter from 'matter-js';
import { applyMaterial, registerTexture, type MaterialName } from '../physics';

// ============================================================================
// Jelly — a grid of small texture-slice bodies held together by springs.
// One registry object; dragging any tile drags the whole thing.
// ============================================================================

export const JELLY_TILE_TEX_MAX = 64;
const MIN_OPAQUE = 0.15;

type V = { x: number; y: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function opaqueFraction(c: HTMLCanvasElement): number {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx || c.width === 0 || c.height === 0) return 0;
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 10) opaque += 1;
  return opaque / (data.length / 4);
}

export interface JellyResult {
  bodies: Matter.Body[];
  constraints: Matter.Constraint[];
  textureKeys: string[];
  /** tile nearest the centre — representative body (selection, face host) */
  root: Matter.Body;
}

let jellyTexSeq = 0;

/**
 * Build a jelly at (x, y) with bounding size w×h whose appearance is `texture`.
 * Returns null when fewer than 4 opaque tiles survive (caller falls back to a
 * solid body).
 */
export function createJelly(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  texture: HTMLCanvasElement;
  render: Matter.Render;
  material: MaterialName;
}): JellyResult | null {
  const { x, y, w, h, texture, render, material } = opts;
  const cols = clamp(Math.round(Math.sqrt((20 * w) / Math.max(1, h))), 2, 6);
  const rows = clamp(Math.round(20 / cols), 2, 6);
  const tw = w / cols;
  const th = h / rows;

  // tile canvases with ~1.5px overdraw so stretched seams stay covered
  const group = Matter.Body.nextGroup(true);
  interface Tile {
    r: number;
    c: number;
    body: Matter.Body;
    texKey: string;
  }
  const grid: (Tile | null)[][] = [];
  const tiles: Tile[] = [];
  const textureKeys: string[] = [];

  for (let r = 0; r < rows; r++) {
    grid.push(new Array<Tile | null>(cols).fill(null));
    for (let c = 0; c < cols; c++) {
      const tex = document.createElement('canvas');
      const over = 1.5;
      const srcX = Math.max(0, (c * tw - over) * (texture.width / w));
      const srcY = Math.max(0, (r * th - over) * (texture.height / h));
      const srcW = Math.min(texture.width - srcX, (tw + 2 * over) * (texture.width / w));
      const srcH = Math.min(texture.height - srcY, (th + 2 * over) * (texture.height / h));
      const ts = Math.min(1, JELLY_TILE_TEX_MAX / Math.max(srcW, srcH));
      tex.width = Math.max(1, Math.round(srcW * ts));
      tex.height = Math.max(1, Math.round(srcH * ts));
      const tctx = tex.getContext('2d');
      if (!tctx) continue;
      tctx.drawImage(texture, srcX, srcY, srcW, srcH, 0, 0, tex.width, tex.height);
      if (opaqueFraction(tex) < MIN_OPAQUE) continue;

      const bx = x - w / 2 + (c + 0.5) * tw;
      const by = y - h / 2 + (r + 0.5) * th;
      const body = Matter.Bodies.rectangle(bx, by, tw + 2, th + 2, {
        restitution: 0.3,
        friction: 0.4,
        collisionFilter: { group },
      });
      jellyTexSeq += 1;
      const key = `physics-tex-jelly-${jellyTexSeq}`;
      registerTexture(render, key, tex);
      textureKeys.push(key);
      body.render.sprite = {
        texture: key,
        // slightly overdrawing so springs can stretch without visible seams
        xScale: (tw + 3) / tex.width,
        yScale: (th + 3) / tex.height,
      };
      // replacing the sprite object drops Matter's offsets (NaN draw = invisible)
      (body.render.sprite as { xOffset?: number; yOffset?: number }).xOffset = 0.5;
      (body.render.sprite as { xOffset?: number; yOffset?: number }).yOffset = 0.5;
      const tile = { r, c, body, texKey: key };
      grid[r][c] = tile;
      tiles.push(tile);
    }
  }
  if (tiles.length < 4) {
    for (const k of textureKeys) delete (render.textures as Record<string, unknown>)[k];
    return null;
  }

  // keep only the largest 8-connected component
  const seen = new Set<Tile>();
  let largest: Set<Tile> | null = null;
  for (const t of tiles) {
    if (seen.has(t)) continue;
    const comp = new Set<Tile>();
    const queue = [t];
    seen.add(t);
    while (queue.length) {
      const u = queue.pop()!;
      comp.add(u);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const n = grid[u.r + dr]?.[u.c + dc];
          if (n && !seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
    }
    if (!largest || comp.size > largest.size) largest = comp;
  }
  const kept = tiles.filter((t) => largest!.has(t));
  for (const t of tiles) {
    if (!largest!.has(t)) {
      delete (render.textures as Record<string, unknown>)[t.texKey];
      textureKeys.splice(textureKeys.indexOf(t.texKey), 1);
    }
  }

  const at = new Map<Tile, Matter.Body>();
  for (const t of kept) at.set(t, t.body);
  const bodies = kept.map((t) => t.body);
  const constraints: Matter.Constraint[] = [];
  const spring = (a: Matter.Body, b: Matter.Body) => {
    const len = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
    constraints.push(
      Matter.Constraint.create({
        bodyA: a,
        bodyB: b,
        length: len,
        stiffness: 0.3,
        damping: 0.05,
        render: { visible: false },
      }),
    );
  };
  for (const t of kept) {
    const neighbours = [
      grid[t.r]?.[t.c + 1],
      grid[t.r + 1]?.[t.c],
      grid[t.r + 1]?.[t.c + 1],
      grid[t.r + 1]?.[t.c - 1],
    ];
    for (const n of neighbours) {
      if (n && at.has(n)) spring(t.body, at.get(n)!);
    }
  }
  for (const b of bodies) applyMaterial(b, material);

  // root = tile nearest the bounding centre
  const centre: V = { x, y };
  let root = bodies[0];
  let best = Infinity;
  for (const b of bodies) {
    const d = Math.hypot(b.position.x - centre.x, b.position.y - centre.y);
    if (d < best) {
      best = d;
      root = b;
    }
  }
  return { bodies, constraints, textureKeys, root };
}

/** Ash/ice tint applied to every tile texture of a jelly (source-atop). */
export function tintJellyTextures(
  obj: { bodies: Matter.Body[] },
  render: Matter.Render,
  tint: 'ice' | 'ash',
): void {
  for (const b of obj.bodies) {
    const key = b.render.sprite?.texture;
    if (!key) continue;
    const tex = (render.textures as Record<string, HTMLCanvasElement>)[key];
    if (!tex) continue;
    const ctx = tex.getContext('2d');
    if (!ctx) continue;
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = tint === 'ice' ? 'rgba(150,210,255,0.45)' : 'rgba(30,22,18,0.6)';
    ctx.fillRect(0, 0, tex.width, tex.height);
    ctx.globalCompositeOperation = 'source-over';
  }
}
