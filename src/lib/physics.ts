import Matter from 'matter-js';
import {
  DEFAULT_SPAWN_SIZE,
  MAX_SPAWN_SIZE,
  MIN_SPAWN_SIZE,
  type CutoutAsset,
} from '../types/asset';

export const MAX_SPEED = 40;
export const MAX_BODIES = 60;
export const WALL_THICKNESS = 400;
export const TEXTURE_MAX_PX = 512;
export const MIN_BODY_SIDE = 24;
export const GRAVITY_MAX = 3;

export type GravityDirection = 'down' | 'up' | 'left' | 'right';

export const GRAVITY_VECTORS: Record<GravityDirection, { x: number; y: number }> = {
  down: { x: 0, y: 1 },
  up: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export function createEngine(): Matter.Engine {
  return Matter.Engine.create({
    enableSleeping: false,
    positionIterations: 8,
    velocityIterations: 6,
  });
}

export function applyGravity(
  engine: Matter.Engine,
  enabled: boolean,
  direction: GravityDirection,
  strength: number,
): void {
  const v = GRAVITY_VECTORS[direction];
  const s = Math.max(0, Math.min(GRAVITY_MAX, strength));
  engine.gravity.x = enabled ? v.x * s : 0;
  engine.gravity.y = enabled ? v.y * s : 0;
}

/** Floor, ceiling and side walls just outside the visible area. */
export function createWalls(w: number, h: number): Matter.Body[] {
  const t = WALL_THICKNESS;
  const opts: Matter.IChamferableBodyDefinition = { isStatic: true, render: { visible: false } };
  return [
    Matter.Bodies.rectangle(w / 2, h + t / 2, w + 2 * t, t, opts), // floor
    Matter.Bodies.rectangle(w / 2, -t / 2, w + 2 * t, t, opts), // ceiling
    Matter.Bodies.rectangle(-t / 2, h / 2, t, h + 2 * t, opts), // left
    Matter.Bodies.rectangle(w + t / 2, h / 2, t, h + 2 * t, opts), // right
  ];
}

export function updateWalls(walls: Matter.Body[], w: number, h: number): void {
  if (walls.length < 4) return;
  const t = WALL_THICKNESS;
  Matter.Body.setPosition(walls[0], { x: w / 2, y: h + t / 2 });
  Matter.Body.setPosition(walls[1], { x: w / 2, y: -t / 2 });
  Matter.Body.setPosition(walls[2], { x: -t / 2, y: h / 2 });
  Matter.Body.setPosition(walls[3], { x: w + t / 2, y: h / 2 });
  // Widths keep a 2 * WALL_THICKNESS overhang, so they still cover the edges on shrink.
}

export interface BodySize {
  width: number;
  height: number;
}

/**
 * Pixel size for a spawn request's body. Longest side = spawnSize (clamped to
 * MIN/MAX_SPAWN_SIZE and to the canvas minus margin), aspect preserved.
 */
export function computeBodySize(
  asset: CutoutAsset,
  naturalWidth: number,
  naturalHeight: number,
  canvasW: number,
  canvasH: number,
): BodySize {
  let aw = asset.width > 0 ? asset.width : naturalWidth;
  let ah = asset.height > 0 ? asset.height : naturalHeight;
  if (!(aw > 0) || !(ah > 0)) {
    aw = 1;
    ah = 1;
  }
  let longest = Math.max(MIN_SPAWN_SIZE, Math.min(MAX_SPAWN_SIZE, asset.spawnSize ?? DEFAULT_SPAWN_SIZE));
  longest = Math.min(longest, canvasW - 40, canvasH - 40);
  longest = Math.max(MIN_BODY_SIDE, longest);
  const scale = longest / Math.max(aw, ah);
  return { width: Math.max(1, aw * scale), height: Math.max(1, ah * scale) };
}

/**
 * Rasterize a loaded image into an offscreen canvas whose longest side is
 * min(longestSide * devicePixelRatio, TEXTURE_MAX_PX).
 */
export function rasterizeTexture(img: HTMLImageElement, longestSide: number): HTMLCanvasElement {
  const dpr = window.devicePixelRatio || 1;
  const target = Math.max(1, Math.min(Math.round(longestSide * dpr), TEXTURE_MAX_PX));
  const nw = img.naturalWidth || 1;
  const nh = img.naturalHeight || 1;
  const scale = target / Math.max(nw, nh);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(nw * scale));
  canvas.height = Math.max(1, Math.round(nh * scale));
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function textureKey(id: string): string {
  return `physics-tex-${id}`;
}

export function registerTexture(
  render: Matter.Render,
  key: string,
  canvas: HTMLCanvasElement,
): void {
  (render.textures as Record<string, CanvasImageSource>)[key] = canvas;
}

export function unregisterTexture(render: Matter.Render, key: string): void {
  delete (render.textures as Record<string, CanvasImageSource>)[key];
}

/** Drop the render texture a sprite body points at, if we registered one. */
export function releaseBodyTexture(render: Matter.Render, body: Matter.Body): void {
  const key = body.render?.sprite?.texture;
  if (key) unregisterTexture(render, key);
}

export function spawnPosition(canvasW: number, canvasH: number, bodyH: number): { x: number; y: number } {
  return {
    x: canvasW / 2 + (Math.random() - 0.5) * canvasW * 0.3,
    y: Math.max(canvasH * 0.15, bodyH / 2 + 4),
  };
}

export function createImageBody(
  x: number,
  y: number,
  w: number,
  h: number,
  key: string,
  texture: HTMLCanvasElement,
): Matter.Body {
  return Matter.Bodies.rectangle(x, y, w, h, {
    chamfer: { radius: Math.min(w, h) * 0.08 },
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
}

export function createPlaceholderBody(x: number, y: number, w: number, h: number): Matter.Body {
  return Matter.Bodies.rectangle(x, y, w, h, {
    chamfer: { radius: Math.min(w, h) * 0.08 },
    restitution: 0.4,
    friction: 0.4,
    render: {
      fillStyle: '#f43f5e',
      strokeStyle: '#fda4af',
      lineWidth: 2,
    },
  });
}

export function nonStaticBodies(engine: Matter.Engine): Matter.Body[] {
  return Matter.Composite.allBodies(engine.world).filter((b) => !b.isStatic);
}

export function nonStaticBodiesIn(composite: Matter.Composite): Matter.Body[] {
  return Matter.Composite.allBodies(composite).filter((b) => !b.isStatic);
}

/** Remove the oldest non-static bodies (and their textures) beyond the cap. */
export function enforceBodyCap(engine: Matter.Engine, render: Matter.Render): void {
  const bodies = nonStaticBodies(engine);
  const excess = bodies.length - MAX_BODIES;
  for (let i = 0; i < excess; i++) {
    releaseBodyTexture(render, bodies[i]);
    Matter.Composite.remove(engine.world, bodies[i]);
  }
}

export function clearBodies(engine: Matter.Engine, render: Matter.Render): void {
  for (const body of nonStaticBodies(engine)) {
    releaseBodyTexture(render, body);
    Matter.Composite.remove(engine.world, body);
  }
}

export function limitVelocity(bodies: Matter.Body[], max: number): void {
  for (const body of bodies) {
    const speed = body.speed;
    if (speed > max) {
      const k = max / speed;
      Matter.Body.setVelocity(body, { x: body.velocity.x * k, y: body.velocity.y * k });
    }
    const spin = body.angularSpeed;
    const maxSpin = 1.2;
    if (spin > maxSpin) {
      Matter.Body.setAngularVelocity(body, body.angularVelocity * (maxSpin / spin));
    }
  }
}

/** Push bodies that ended up outside the canvas back inside and stop them. */
export function clampBodiesInside(bodies: Matter.Body[], w: number, h: number): void {
  for (const body of bodies) {
    if (body.isStatic) continue;
    const p = body.position;
    const nx = Math.max(0, Math.min(w, p.x));
    const ny = Math.max(0, Math.min(h, p.y));
    if (nx !== p.x || ny !== p.y) {
      Matter.Body.setPosition(body, { x: nx, y: ny });
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      Matter.Body.setAngularVelocity(body, 0);
    }
  }
}

export function explode(bodies: Matter.Body[], center: { x: number; y: number }, canvasW: number, canvasH: number): void {
  const maxDist = Math.hypot(canvasW, canvasH) / 2 || 1;
  for (const body of bodies) {
    if (body.isStatic) continue;
    let dx = body.position.x - center.x;
    let dy = body.position.y - center.y;
    let dist = Math.hypot(dx, dy);
    if (dist < 1) {
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a);
      dy = Math.sin(a);
      dist = 1;
    }
    const t = Math.min(1, dist / maxDist);
    const speed = 28 - t * 10; // 28 at centre → 18 at edges
    Matter.Body.setVelocity(body, { x: (dx / dist) * speed, y: (dy / dist) * speed });
    Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.6);
  }
}

// --- Showcase objects -------------------------------------------------------

export interface ShowcaseItem {
  body: Matter.Body;
  texture?: { key: string; canvas: HTMLCanvasElement };
}

function drawCrate(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  ctx.fillStyle = '#8b5cf6';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = size * 0.08;
  ctx.strokeRect(size * 0.05, size * 0.05, size * 0.9, size * 0.9);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size, size);
  ctx.moveTo(size, 0);
  ctx.lineTo(0, size);
  ctx.strokeStyle = 'rgba(230,232,240,0.75)';
  ctx.lineWidth = size * 0.06;
  ctx.stroke();
  return c;
}

function drawStripedBall(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const r = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r - 1, 0, Math.PI * 2);
  ctx.clip();
  const stripes = ['#f43f5e', '#f59e0b', '#a3e635', '#22d3ee', '#8b5cf6'];
  const sw = size / stripes.length;
  stripes.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(i * sw, 0, sw + 1, size);
  });
  const grad = ctx.createRadialGradient(r * 0.7, r * 0.6, r * 0.1, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(r, r, r - 1.5, 0, Math.PI * 2);
  ctx.strokeStyle = '#e6e8f0';
  ctx.lineWidth = 3;
  ctx.stroke();
  return c;
}

const SHOWCASE_COLORS = ['#8b5cf6', '#22d3ee', '#f43f5e', '#f59e0b', '#a3e635'];

/**
 * ~8 mixed test objects: Matter primitives in theme colours plus 2
 * procedurally-drawn canvas textures rendered as sprites.
 */
export function createTestObjects(w: number, h: number, count = 8): ShowcaseItem[] {
  const items: ShowcaseItem[] = [];
  const spawn = (frac: number) => ({
    x: w * (0.2 + 0.6 * frac) + (Math.random() - 0.5) * w * 0.06,
    y: Math.max(30, h * 0.12 * Math.random()),
  });

  const circleR = 30 + Math.random() * 14;
  let p = spawn(0.1);
  items.push({
    body: Matter.Bodies.circle(p.x, p.y, circleR, {
      restitution: 0.55,
      friction: 0.3,
      render: { fillStyle: SHOWCASE_COLORS[1], strokeStyle: '#e6e8f0', lineWidth: 2 },
    }),
  });

  p = spawn(0.3);
  const box = 52 + Math.random() * 18;
  items.push({
    body: Matter.Bodies.rectangle(p.x, p.y, box, box, {
      chamfer: { radius: 10 },
      restitution: 0.4,
      friction: 0.4,
      render: { fillStyle: SHOWCASE_COLORS[0], strokeStyle: '#e6e8f0', lineWidth: 2 },
    }),
  });

  p = spawn(0.5);
  items.push({
    body: Matter.Bodies.polygon(p.x, p.y, 3, 44, {
      restitution: 0.45,
      friction: 0.35,
      render: { fillStyle: SHOWCASE_COLORS[2], strokeStyle: '#e6e8f0', lineWidth: 2 },
    }),
  });

  p = spawn(0.7);
  items.push({
    body: Matter.Bodies.polygon(p.x, p.y, 5, 40, {
      restitution: 0.45,
      friction: 0.35,
      render: { fillStyle: SHOWCASE_COLORS[3], strokeStyle: '#e6e8f0', lineWidth: 2 },
    }),
  });

  p = spawn(0.9);
  items.push({
    body: Matter.Bodies.polygon(p.x, p.y, 6, 42, {
      restitution: 0.45,
      friction: 0.35,
      render: { fillStyle: SHOWCASE_COLORS[4], strokeStyle: '#e6e8f0', lineWidth: 2 },
    }),
  });

  // 2 procedural-texture sprites
  const crateCanvas = drawCrate(96);
  p = spawn(0.4);
  const crateKey = 'physics-tex-showcase-crate';
  items.push({
    body: Matter.Bodies.rectangle(p.x, p.y, 64, 64, {
      chamfer: { radius: 6 },
      restitution: 0.4,
      friction: 0.45,
      render: { sprite: { texture: crateKey, xScale: 64 / 96, yScale: 64 / 96 } },
    }),
    texture: { key: crateKey, canvas: crateCanvas },
  });

  const ballCanvas = drawStripedBall(96);
  p = spawn(0.65);
  const ballKey = 'physics-tex-showcase-ball';
  items.push({
    body: Matter.Bodies.circle(p.x, p.y, 34, {
      restitution: 0.6,
      friction: 0.3,
      render: { sprite: { texture: ballKey, xScale: 68 / 96, yScale: 68 / 96 } },
    }),
    texture: { key: ballKey, canvas: ballCanvas },
  });

  // one extra small primitive to reach ~8
  p = spawn(0.2);
  items.push({
    body: Matter.Bodies.rectangle(p.x, p.y, 90, 26, {
      chamfer: { radius: 8 },
      restitution: 0.4,
      friction: 0.4,
      render: { fillStyle: SHOWCASE_COLORS[(count + 1) % SHOWCASE_COLORS.length], strokeStyle: '#e6e8f0', lineWidth: 2 },
    }),
  });

  return items;
}

/** Manually resize the Matter render (options, bounds, canvas px + css size). */
export function resizeRender(render: Matter.Render, w: number, h: number): void {
  const pr = render.options.pixelRatio || 1;
  render.options.width = w;
  render.options.height = h;
  render.bounds.max.x = render.bounds.min.x + w;
  render.bounds.max.y = render.bounds.min.y + h;
  render.canvas.width = Math.round(w * pr);
  render.canvas.height = Math.round(h * pr);
  render.canvas.style.width = `${w}px`;
  render.canvas.style.height = `${h}px`;
}
