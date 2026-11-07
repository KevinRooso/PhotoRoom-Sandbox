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
/** Wall span: oversized so repositioning alone covers any canvas size. */
export const WALL_LENGTH = 20000;
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
  const L = WALL_LENGTH;
  const opts: Matter.IChamferableBodyDefinition = { isStatic: true, render: { visible: false } };
  return [
    Matter.Bodies.rectangle(w / 2, h + t / 2, L, t, opts), // floor
    Matter.Bodies.rectangle(w / 2, -t / 2, L, t, opts), // ceiling
    Matter.Bodies.rectangle(-t / 2, h / 2, t, L, opts), // left
    Matter.Bodies.rectangle(w + t / 2, h / 2, t, L, opts), // right
  ];
}

export function updateWalls(walls: Matter.Body[], w: number, h: number): void {
  if (walls.length < 4) return;
  const t = WALL_THICKNESS;
  Matter.Body.setPosition(walls[0], { x: w / 2, y: h + t / 2 });
  Matter.Body.setPosition(walls[1], { x: w / 2, y: -t / 2 });
  Matter.Body.setPosition(walls[2], { x: -t / 2, y: h / 2 });
  Matter.Body.setPosition(walls[3], { x: w + t / 2, y: h / 2 });
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
 * Rasterize a loaded image into an offscreen canvas sized from the target
 * body's aspect: longest side = min(longest * devicePixelRatio, TEXTURE_MAX_PX).
 * Sizing from bodyW/bodyH (not naturalWidth) means SVGs reporting a 0 natural
 * size still draw correctly.
 */
export function rasterizeTexture(img: HTMLImageElement, bodyW: number, bodyH: number): HTMLCanvasElement {
  const dpr = window.devicePixelRatio || 1;
  const longest = Math.max(bodyW, bodyH, 1);
  const target = Math.max(1, Math.min(Math.round(longest * dpr), TEXTURE_MAX_PX));
  const scale = target / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bodyW * scale));
  canvas.height = Math.max(1, Math.round(bodyH * scale));
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

/**
 * Push bodies that ended up outside the canvas back inside and stop them.
 * Centres are clamped by the body's half-extents (from `body.bounds`); a body
 * larger than the canvas on an axis is centred on that axis.
 */
export function clampBodiesInside(bodies: Matter.Body[], w: number, h: number): void {
  for (const body of bodies) {
    if (body.isStatic) continue;
    const hw = (body.bounds.max.x - body.bounds.min.x) / 2;
    const hh = (body.bounds.max.y - body.bounds.min.y) / 2;
    const p = body.position;
    const nx = hw * 2 >= w ? w / 2 : Math.max(hw, Math.min(w - hw, p.x));
    const ny = hh * 2 >= h ? h / 2 : Math.max(hh, Math.min(h - hh, p.y));
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

// Unique texture key per spawned sprite — a shared key would break every other
// sprite when `releaseBodyTexture` deletes it for one evicted body.
let showcaseTexSeq = 0;
function nextShowcaseKey(name: string): string {
  showcaseTexSeq += 1;
  return `physics-tex-showcase-${name}-${showcaseTexSeq}`;
}

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
  const crateKey = nextShowcaseKey('crate');
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
  const ballKey = nextShowcaseKey('ball');
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

// --- Materials ---------------------------------------------------------------

export type MaterialName = 'normal' | 'rubber' | 'metal' | 'feather';

export const MATERIALS: Record<
  MaterialName,
  { label: string; restitution: number; friction: number; frictionAir: number; density: number; color: string }
> = {
  normal: { label: 'Normal', restitution: 0.35, friction: 0.4, frictionAir: 0.005, density: 0.001, color: '#8a90a6' },
  rubber: { label: 'Rubber', restitution: 0.9, friction: 0.8, frictionAir: 0.004, density: 0.0012, color: '#f43f5e' },
  metal: { label: 'Metal', restitution: 0.1, friction: 0.25, frictionAir: 0.002, density: 0.006, color: '#cbd5e1' },
  feather: { label: 'Feather', restitution: 0.25, friction: 0.6, frictionAir: 0.07, density: 0.0003, color: '#a3e635' },
};

export function applyMaterial(body: Matter.Body, name: MaterialName): void {
  const m = MATERIALS[name];
  body.restitution = m.restitution;
  body.friction = m.friction;
  body.frictionAir = m.frictionAir;
  Matter.Body.setDensity(body, m.density);
  body.plugin = body.plugin || {};
  (body.plugin as Record<string, unknown>).material = name;
}

// --- Black hole ----------------------------------------------------------------

export interface BlackHole {
  x: number;
  y: number;
  /** engine.timing.timestamp at placement — freezes with the engine when paused */
  bornAt: number;
}

export const BLACK_HOLE_LIFETIME = 4000;
export const BLACK_HOLE_G = 0.0012;

export function blackHoleRadius(canvasW: number, canvasH: number): number {
  return Math.max(180, Math.min(420, 0.45 * Math.min(canvasW, canvasH)));
}

/**
 * Pull bodies toward the hole: magnitude G·mass·(1 − d/R), ~30% tangential
 * swirl, strong velocity damping inside ~40px so bodies cluster instead of
 * slingshotting. The global velocity cap still applies.
 */
export function applyBlackHole(bodies: Matter.Body[], hole: BlackHole, R: number, G = BLACK_HOLE_G): void {
  for (const body of bodies) {
    if (body.isStatic) continue;
    const dx = hole.x - body.position.x;
    const dy = hole.y - body.position.y;
    const d = Math.max(20, Math.hypot(dx, dy));
    if (d > R) continue;
    const mag = G * body.mass * (1 - d / R);
    const ux = dx / d;
    const uy = dy / d;
    // tangential unit vector for swirl
    const tx = -uy;
    const ty = ux;
    Matter.Body.applyForce(body, body.position, {
      x: ux * mag + tx * mag * 0.3,
      y: uy * mag + ty * mag * 0.3,
    });
    if (d < 40) {
      Matter.Body.setVelocity(body, { x: body.velocity.x * 0.92, y: body.velocity.y * 0.92 });
    }
  }
}
