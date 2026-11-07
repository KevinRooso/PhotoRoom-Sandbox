import Matter from 'matter-js';
import { registerTexture } from '../physics';

// ============================================================================
// Crumble / shatter — half-plane-clipping Voronoi in the parent's LOCAL
// (unrotated) frame. Convex cells only, so Bodies.fromVertices never needs
// poly-decomp. Shard textures are <= 128px clips of the parent's appearance.
// ============================================================================

export const MAX_SHARDS = 120;
export const SHARD_TEX_MAX = 128;
const MIN_OPAQUE = 0.15;

type V = { x: number; y: number };

const rotate = (p: V, a: number): V => ({
  x: p.x * Math.cos(a) - p.y * Math.sin(a),
  y: p.x * Math.sin(a) + p.y * Math.cos(a),
});

/** Keep the side of `poly` that contains seed `a` (bisector between a and b). */
function clipHalfPlane(poly: V[], a: V, b: V): V[] {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const nx = b.x - a.x;
  const ny = b.y - a.y;
  const out: V[] = [];
  const d = (p: V) => (p.x - mx) * nx + (p.y - my) * ny;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = d(p);
    const dq = d(q);
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out;
}

function polyArea(poly: V[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Rasterize the parent's appearance in its local frame (origin = position). */
function localTexture(body: Matter.Body, render: Matter.Render, local: V[], w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  let minX = Infinity;
  let minY = Infinity;
  for (const v of local) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
  }
  ctx.translate(-minX, -minY);
  const sprite = body.render.sprite;
  const texKey = sprite?.texture;
  const tex = texKey ? ((render.textures as Record<string, CanvasImageSource>)[texKey] as HTMLCanvasElement | undefined) : undefined;
  if (tex && sprite) {
    // sprite drawn at (-texW*xOff*xScale, -texH*yOff*yScale) relative to position
    const dw = tex.width * (sprite.xScale || 1);
    const dh = tex.height * (sprite.yScale || 1);
    const off = sprite as { xOffset?: number; yOffset?: number };
    ctx.drawImage(tex, -tex.width * (off.xOffset ?? 0.5) * (sprite.xScale || 1), -tex.height * (off.yOffset ?? 0.5) * (sprite.yScale || 1), dw, dh);
  } else {
    // primitive/placeholder: draw its own polygon (or disc) with its colours
    ctx.beginPath();
    if (body.circleRadius) {
      ctx.arc(0, 0, body.circleRadius, 0, Math.PI * 2);
    } else {
      ctx.moveTo(local[0].x, local[0].y);
      for (let i = 1; i < local.length; i++) ctx.lineTo(local[i].x, local[i].y);
      ctx.closePath();
    }
    ctx.fillStyle = body.render.fillStyle || '#8a90a6';
    ctx.fill();
    if (body.render.strokeStyle && (body.render.lineWidth ?? 0) > 0) {
      ctx.strokeStyle = body.render.strokeStyle;
      ctx.lineWidth = body.render.lineWidth ?? 1;
      ctx.stroke();
    }
  }
  return c;
}

function opaqueFraction(c: HTMLCanvasElement): number {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx || c.width === 0 || c.height === 0) return 0;
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  const total = data.length / 4;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 10) opaque += 1;
  return opaque / total;
}

export interface ShatterOptions {
  world: Matter.World;
  render: Matter.Render;
  /** world-space point the break radiates from */
  impact: { x: number; y: number };
  shardCount?: number;
  tint?: 'ice' | 'ash' | null;
}

let shardTexSeq = 0;

/**
 * Shatter `body` into textured convex shards. Does NOT remove the parent
 * (caller removes the owning object). Returns the shard bodies created —
 * caller adds them to the world.
 */
export function shatterBody(body: Matter.Body, opts: ShatterOptions): Matter.Body[] {
  const { world: _w, render, impact, tint } = opts;
  void _w;
  const angle = body.angle;
  const pos = body.position;

  // local polygon (unrotated, origin at body position)
  const local = body.vertices.map((v) => rotate({ x: v.x - pos.x, y: v.y - pos.y }, -angle));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of local) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw < 4 || bh < 4) return [];

  // shard count scaled down for small bodies
  const scaleCount = Math.max(bw, bh) < 60 ? 0.5 : Math.max(bw, bh) < 120 ? 0.75 : 1;
  const n = Math.max(3, Math.round((opts.shardCount ?? 8 + Math.floor(Math.random() * 7)) * scaleCount));

  // seeds: ~40% clustered near the impact point (local frame), rest uniform
  const impactLocal = rotate({ x: impact.x - pos.x, y: impact.y - pos.y }, -angle);
  const seeds: V[] = [impactLocal];
  while (seeds.length < n) {
    if (seeds.length < n * 0.4) {
      seeds.push({
        x: impactLocal.x + (Math.random() - 0.5) * bw * 0.5,
        y: impactLocal.y + (Math.random() - 0.5) * bh * 0.5,
      });
    } else {
      seeds.push({ x: minX + Math.random() * bw, y: minY + Math.random() * bh });
    }
  }

  // Voronoi cells by sequential half-plane clipping
  const cells: V[][] = [];
  for (let i = 0; i < seeds.length; i++) {
    let cell = local;
    for (let j = 0; j < seeds.length; j++) {
      if (i === j) continue;
      cell = clipHalfPlane(cell, seeds[i], seeds[j]);
      if (cell.length < 3) break;
    }
    if (cell.length >= 3 && Math.abs(polyArea(cell)) > 25) cells.push(cell);
  }

  // parent appearance raster in local frame
  const baseTex = localTexture(body, render, local, bw, bh);

  const pv = Matter.Body.getVelocity(body);
  const pvx = pv.x;
  const pvy = pv.y;
  const pvAngle = Matter.Body.getAngularVelocity(body);

  const shards: Matter.Body[] = [];
  for (const cell of cells) {
    let cMinX = Infinity;
    let cMinY = Infinity;
    let cMaxX = -Infinity;
    let cMaxY = -Infinity;
    for (const v of cell) {
      if (v.x < cMinX) cMinX = v.x;
      if (v.y < cMinY) cMinY = v.y;
      if (v.x > cMaxX) cMaxX = v.x;
      if (v.y > cMaxY) cMaxY = v.y;
    }
    const cw = cMaxX - cMinX;
    const ch = cMaxY - cMinY;
    if (cw < 2 || ch < 2) continue;

    // shard texture: clip the local texture to the cell, <= 128px
    const tex = document.createElement('canvas');
    const ts = Math.min(1, SHARD_TEX_MAX / Math.max(cw, ch));
    tex.width = Math.max(1, Math.ceil(cw * ts));
    tex.height = Math.max(1, Math.ceil(ch * ts));
    const tctx = tex.getContext('2d');
    if (!tctx) continue;
    tctx.scale(ts, ts);
    tctx.translate(-cMinX, -cMinY);
    tctx.beginPath();
    tctx.moveTo(cell[0].x, cell[0].y);
    for (let i = 1; i < cell.length; i++) tctx.lineTo(cell[i].x, cell[i].y);
    tctx.closePath();
    tctx.clip();
    // baseTex pixel (u,v) = local point (u+minX, v+minY); current transform
    // maps local → canvas via -cMinX, so blit at +minX/+minY to stay aligned
    tctx.drawImage(baseTex, minX, minY);
    if (tint) {
      tctx.globalCompositeOperation = 'source-atop';
      tctx.fillStyle = tint === 'ice' ? 'rgba(150,210,255,0.45)' : 'rgba(30,22,18,0.6)';
      tctx.fillRect(cMinX, cMinY, cw, ch);
      tctx.globalCompositeOperation = 'source-over';
    }
    if (opaqueFraction(tex) < MIN_OPAQUE) continue;

    // local centroid BEFORE creating the body — fromVertices recentres the
    // vertices on this centroid then repositions to (0,0), so shard.position
    // would be (0,0); compute it ourselves with the same area-centroid formula
    const c = Matter.Vertices.centre(cell);

    // shard body in local frame at angle 0
    const shard = Matter.Bodies.fromVertices(c.x, c.y, [cell as Matter.Vector[]], {
      restitution: body.restitution,
      friction: body.friction,
      frictionAir: body.frictionAir,
      density: body.density,
    });
    if (!shard) continue;

    shardTexSeq += 1;
    const key = `physics-tex-shard-${shardTexSeq}`;
    registerTexture(render, key, tex);
    shard.render.sprite = {
      texture: key,
      xScale: cw / tex.width,
      yScale: ch / tex.height,
    };
    // overwrite the auto offset _initProperties added at creation
    (shard.render.sprite as { xOffset?: number; yOffset?: number }).xOffset = (c.x - cMinX) / cw;
    (shard.render.sprite as { xOffset?: number; yOffset?: number }).yOffset = (c.y - cMinY) / ch;

    // world placement: local centroid rotated by parent angle
    const wc = rotate({ x: c.x, y: c.y }, angle);
    const worldC = { x: pos.x + wc.x, y: pos.y + wc.y };
    Matter.Body.setPosition(shard, worldC);
    Matter.Body.setAngle(shard, angle);

    // velocity = parent v + ω×r + outward impulse from impact
    const rx = worldC.x - impact.x;
    const ry = worldC.y - impact.y;
    const rd = Math.hypot(rx, ry) || 1;
    const out = 1.5 + Math.random() * 2.5;
    Matter.Body.setVelocity(shard, {
      x: pvx + -pvAngle * ry + (rx / rd) * out,
      y: pvy + pvAngle * rx + (ry / rd) * out,
    });
    Matter.Body.setAngularVelocity(shard, pvAngle + (Math.random() - 0.5) * 0.2);
    shard.plugin = shard.plugin || {};
    (shard.plugin as Record<string, unknown>).shard = true;
    shards.push(shard);
  }
  return shards;
}

/** Fade a shard out over its last 1.5s and report whether it should be removed. */
export function shardExpired(body: Matter.Body, timestamp: number): boolean {
  const meta = (body.plugin as Record<string, unknown> | undefined)?.shardMeta as
    | { bornAt: number; life: number }
    | undefined;
  if (!meta) return false;
  const age = timestamp - meta.bornAt;
  if (age > meta.life) return true;
  const fadeStart = meta.life - 1500;
  if (age > fadeStart) {
    body.render.opacity = Math.max(0, (meta.life - age) / 1500);
  }
  return false;
}

/** Tag a shard with birth/life metadata on the engine timestamp clock. */
export function tagShard(body: Matter.Body, bornAt: number): void {
  body.plugin = body.plugin || {};
  (body.plugin as Record<string, unknown>).shardMeta = {
    bornAt,
    life: 6000 + Math.random() * 2000,
  };
}
