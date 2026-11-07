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

/**
 * Mass-weighted centroid of non-static bodies, shifted 40px along the
 * normalized gravity vector (so the blast starts inside the pile, not above
 * it), clamped to [60, w−60] × [60, h−60]. Stage centre when there are no
 * bodies.
 */
export function explosionOrigin(
  bodies: Matter.Body[],
  canvasW: number,
  canvasH: number,
  gravity: { x: number; y: number },
): { x: number; y: number } {
  const dyn = bodies.filter((b) => !b.isStatic);
  if (dyn.length === 0) return { x: canvasW / 2, y: canvasH / 2 };
  let mx = 0;
  let my = 0;
  let mt = 0;
  for (const b of dyn) {
    mx += b.position.x * b.mass;
    my += b.position.y * b.mass;
    mt += b.mass;
  }
  let x = mx / mt;
  let y = my / mt;
  const gl = Math.hypot(gravity.x, gravity.y);
  if (gl > 0) {
    x += (gravity.x / gl) * 40;
    y += (gravity.y / gl) * 40;
  }
  return {
    x: Math.max(60, Math.min(canvasW - 60, x)),
    y: Math.max(60, Math.min(canvasH - 60, y)),
  };
}

export function explode(
  bodies: Matter.Body[],
  center: { x: number; y: number },
  canvasW: number,
  canvasH: number,
  gravity: { x: number; y: number },
): void {
  const maxDist = Math.hypot(canvasW, canvasH) / 2 || 1;
  const gl = Math.hypot(gravity.x, gravity.y);
  const gx = gl > 0 ? gravity.x / gl : 0;
  const gy = gl > 0 ? gravity.y / gl : 0;
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
    let ux = dx / dist;
    let uy = dy / dist;
    if (gl > 0) {
      // bias against gravity so resting piles actually lift off
      ux += -gx * 1.0;
      uy += -gy * 1.0;
      const l = Math.hypot(ux, uy);
      if (l < 0.3) {
        ux = -gx;
        uy = -gy;
      } else {
        ux /= l;
        uy /= l;
      }
      // guarantee a minimum anti-gravity component — bodies near the origin or
      // at pile level would otherwise be pinned horizontally into the walls.
      // Snapped directions get a small perpendicular jitter so it still scatters.
      if (ux * -gx + uy * -gy < 0.55) {
        const j = (Math.random() - 0.5) * 0.7;
        const px = gy;
        const py = -gx;
        ux = -gx + px * j;
        uy = -gy + py * j;
        const l2 = Math.hypot(ux, uy) || 1;
        ux /= l2;
        uy /= l2;
      }
    }
    const t = Math.min(1, dist / maxDist);
    const speed = 28 - t * 10; // 28 at centre → 18 at edges
    Matter.Body.setVelocity(body, { x: ux * speed, y: uy * speed });
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
  render.bounds.min.x = 0;
  render.bounds.min.y = 0;
  render.bounds.max.x = w;
  render.bounds.max.y = h;
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


// ============================================================================
// Sound — Web Audio synth engine
// ============================================================================
// Graph: per-sound nodes → sfx bus / ambient bus → master gain → compressor →
// destination. Nodes are short-lived (osc.stop at envelope end, onended →
// disconnect). Calls before unlock() or while muted are no-ops; stats count
// only sounds actually played.

export interface SoundEngine {
  unlock(): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  impact(intensity: number, material: MaterialName): void;
  explosion(): void;
  spawn(): void;
  spawnBatch(): void;
  grab(): void;
  throwWhoosh(intensity: number): void;
  gravityToggle(on: boolean): void;
  gravityChange(dir: GravityDirection): void;
  tick(): void;
  click(): void;
  pause(paused: boolean): void;
  clear(): void;
  reset(): void;
  snapshot(): void;
  blackHoleStart(): void;
  blackHoleStop(): void;
  debug(): { ctx: AudioContext | null; output: AudioNode | null; stats: Record<string, number> };
  dispose(): void;
}

const MUTE_KEY = 'physicslab:muted';
const MAX_IMPACT_VOICES = 10;

export function readStoredMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function createSoundEngine(initialMuted: boolean): SoundEngine {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let comp: DynamicsCompressorNode | null = null;
  let sfxBus: GainNode | null = null;
  let ambientBus: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let muted = initialMuted;
  let liveImpacts = 0;
  const stats: Record<string, number> = {};
  // black-hole hum nodes
  let humOsc: OscillatorNode | null = null;
  let humLfo: OscillatorNode | null = null;
  let humLfoGain: GainNode | null = null;
  let humFilter: BiquadFilterNode | null = null;
  let humGain: GainNode | null = null;

  const bump = (name: string) => {
    stats[name] = (stats[name] || 0) + 1;
  };
  const ready = () => {
    if (!(ctx && master && sfxBus && !muted && ctx.state !== 'closed')) return false;
    // headless/hidden pages can suspend the context — try to resume on demand
    if (ctx.state === 'suspended') void ctx.resume();
    return true;
  };
  const now = () => (ctx ? ctx.currentTime : 0);

  function ensureCtx(): void {
    if (ctx) return;
    const AC: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(comp);
    sfxBus = ctx.createGain();
    sfxBus.connect(master);
    ambientBus = ctx.createGain();
    ambientBus.gain.value = 1;
    ambientBus.connect(master);
    // shared 1s white-noise buffer
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  function noise(): AudioBufferSourceNode {
    const src = ctx!.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    return src;
  }

  function osc(type: OscillatorType, freq: number): OscillatorNode {
    const o = ctx!.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  function gainEnv(peak: number, attack: number, decay: number, t0: number): GainNode {
    const g = ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    return g;
  }

  /** Connect nodes in series → sfxBus, start/stop the source, then disconnect
   *  only the per-sound nodes (never the shared bus). */
  function chain(nodes: AudioNode[], startT: number, stopT: number): void {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(sfxBus!);
    const first = nodes[0] as AudioScheduledSourceNode;
    first.start(startT);
    first.stop(stopT);
    first.onended = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already gone */
        }
      }
    };
  }

  function setAmbientPaused(p: boolean): void {
    if (!ctx || !ambientBus) return;
    const t = ctx.currentTime;
    ambientBus.gain.cancelScheduledValues(t);
    ambientBus.gain.setValueAtTime(ambientBus.gain.value, t);
    ambientBus.gain.linearRampToValueAtTime(p ? 0 : 1, t + 0.3);
  }

  function toSfx(node: AudioNode, pan = 0): AudioNode {
    if (pan !== 0) {
      const p = ctx!.createStereoPanner();
      p.pan.value = pan;
      node.connect(p);
      p.connect(sfxBus!);
      return p;
    }
    node.connect(sfxBus!);
    return node;
  }

  const api: SoundEngine = {
    unlock() {
      ensureCtx();
      if (ctx && ctx.state === 'suspended') void ctx.resume();
    },

    setMuted(m: boolean) {
      muted = m;
      try {
        window.localStorage.setItem(MUTE_KEY, m ? '1' : '0');
      } catch {
        /* storage unavailable */
      }
      if (m) api.blackHoleStop();
    },

    get muted() {
      return muted;
    },

    impact(intensity: number, material: MaterialName) {
      if (!ready() || liveImpacts >= MAX_IMPACT_VOICES) return;
      bump('impact');
      liveImpacts += 1;
      const release = () => {
        liveImpacts -= 1;
      };
      const t = now();
      const g = Math.pow(Math.max(0, Math.min(1, intensity)), 1.5);

      if (material === 'rubber') {
        // boing: sine pitch bend up then down
        const o = osc('sine', 170);
        o.frequency.setValueAtTime(170, t);
        o.frequency.exponentialRampToValueAtTime(340, t + 0.08);
        o.frequency.exponentialRampToValueAtTime(120, t + 0.25);
        const gn = gainEnv(0.45 * g + 0.02, 0.005, 0.25, t);
        o.connect(gn);
        gn.connect(sfxBus!);
        o.start(t);
        o.stop(t + 0.3);
        o.onended = () => {
          o.disconnect();
          gn.disconnect();
          release();
        };
      } else if (material === 'metal') {
        // clang: inharmonic partials, ~0.5s decay, mild detune
        const partials = [520, 1380, 2210, 3150];
        const gn = gainEnv(0.16 * g + 0.01, 0.002, 0.5, t);
        gn.connect(sfxBus!);
        let stopped = 0;
        for (const f of partials) {
          const o = osc('sine', f * (1 + (Math.random() - 0.5) * 0.03));
          const og = ctx!.createGain();
          og.gain.value = 1 / partials.length;
          o.connect(og);
          og.connect(gn);
          o.start(t);
          o.stop(t + 0.55);
          o.onended = () => {
            o.disconnect();
            og.disconnect();
            stopped += 1;
            if (stopped === partials.length) {
              gn.disconnect();
              release();
            }
          };
        }
      } else if (material === 'feather') {
        // soft high-passed noise puff
        const src = noise();
        const hp = ctx!.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 2800;
        const gn = gainEnv(0.12 * g + 0.005, 0.01, 0.14, t);
        src.connect(hp);
        hp.connect(gn);
        gn.connect(sfxBus!);
        src.start(t);
        src.stop(t + 0.18);
        src.onended = () => {
          src.disconnect();
          hp.disconnect();
          gn.disconnect();
          release();
        };
      } else {
        // normal: bandpassed noise thud + low sine thump with pitch drop
        const src = noise();
        const bp = ctx!.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 500;
        bp.Q.value = 0.8;
        const gn = gainEnv(0.4 * g + 0.01, 0.004, 0.1, t);
        src.connect(bp);
        bp.connect(gn);
        gn.connect(sfxBus!);
        const o = osc('sine', 150);
        o.frequency.setValueAtTime(150, t);
        o.frequency.exponentialRampToValueAtTime(65, t + 0.1);
        const og = gainEnv(0.5 * g + 0.02, 0.003, 0.12, t);
        o.connect(og);
        og.connect(sfxBus!);
        src.start(t);
        src.stop(t + 0.13);
        o.start(t);
        o.stop(t + 0.14);
        let done = 0;
        const fin = () => {
          done += 1;
          if (done === 2) release();
        };
        src.onended = () => {
          src.disconnect();
          bp.disconnect();
          gn.disconnect();
          fin();
        };
        o.onended = () => {
          o.disconnect();
          og.disconnect();
          fin();
        };
      }
    },

    explosion() {
      if (!ready()) return;
      bump('explosion');
      const t = now();
      // onset crack: high-passed noise, ~30ms
      {
        const src = noise();
        const hp = ctx!.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 2600;
        const gn = gainEnv(0.55, 0.001, 0.03, t);
        chain([src, hp, gn], t, t + 0.05);
      }
      // sub boom: sine 120→35Hz over .6s, 1.2s envelope
      {
        const o = osc('sine', 120);
        o.frequency.setValueAtTime(120, t);
        o.frequency.exponentialRampToValueAtTime(35, t + 0.6);
        const gn = ctx!.createGain();
        gn.gain.setValueAtTime(0.0001, t);
        gn.gain.exponentialRampToValueAtTime(0.9, t + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
        o.connect(gn);
        gn.connect(sfxBus!);
        o.start(t);
        o.stop(t + 1.25);
        o.onended = () => {
          o.disconnect();
          gn.disconnect();
        };
      }
      // noise burst: lowpass sweeping 3000→200Hz over ~1s
      {
        const src = noise();
        const lp = ctx!.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(3000, t);
        lp.frequency.exponentialRampToValueAtTime(200, t + 1.0);
        const gn = gainEnv(0.65, 0.005, 1.0, t);
        chain([src, lp, gn], t, t + 1.1);
      }
      // rumble tail: low filtered noise ~1.5s
      {
        const src = noise();
        const lp = ctx!.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 130;
        const gn = ctx!.createGain();
        gn.gain.setValueAtTime(0.0001, t);
        gn.gain.linearRampToValueAtTime(0.22, t + 0.15);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
        src.connect(lp);
        lp.connect(gn);
        gn.connect(sfxBus!);
        src.start(t);
        src.stop(t + 1.65);
        src.onended = () => {
          src.disconnect();
          lp.disconnect();
          gn.disconnect();
        };
      }
    },

    spawn() {
      if (!ready()) return;
      bump('spawn');
      const t = now();
      const o = osc('sine', 480);
      o.frequency.setValueAtTime(480, t);
      o.frequency.exponentialRampToValueAtTime(880, t + 0.07);
      const gn = gainEnv(0.22, 0.003, 0.09, t);
      chain([o, gn], t, t + 0.12);
    },

    spawnBatch() {
      if (!ready()) return;
      bump('spawnBatch');
      const t = now();
      [0, 0.08, 0.16].forEach((dt, i) => {
        const o = osc('sine', 420 + i * 140);
        o.frequency.setValueAtTime(420 + i * 140, t + dt);
        o.frequency.exponentialRampToValueAtTime(760 + i * 160, t + dt + 0.07);
        const gn = gainEnv(0.2, 0.003, 0.09, t + dt);
        chain([o, gn], t + dt, t + dt + 0.12);
      });
    },

    grab() {
      if (!ready()) return;
      bump('grab');
      const t = now();
      const o = osc('triangle', 300);
      const gn = gainEnv(0.14, 0.002, 0.06, t);
      chain([o, gn], t, t + 0.08);
    },

    throwWhoosh(intensity: number) {
      if (!ready()) return;
      bump('throwWhoosh');
      const t = now();
      const g = Math.max(0, Math.min(1, intensity));
      const src = noise();
      const bp = ctx!.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(600, t);
      bp.frequency.exponentialRampToValueAtTime(2400, t + 0.16);
      const gn = gainEnv(0.3 * g + 0.03, 0.01, 0.17, t);
      chain([src, bp, gn], t, t + 0.22);
    },

    gravityToggle(on: boolean) {
      if (!ready()) return;
      bump('gravityToggle');
      const t = now();
      const o = osc('sine', on ? 280 : 700);
      o.frequency.setValueAtTime(on ? 280 : 700, t);
      o.frequency.exponentialRampToValueAtTime(on ? 700 : 220, t + 0.18);
      const gn = gainEnv(0.18, 0.005, 0.18, t);
      chain([o, gn], t, t + 0.22);
    },

    gravityChange(dir: GravityDirection) {
      if (!ready()) return;
      bump('gravityChange');
      const t = now();
      const pan = dir === 'left' ? -0.6 : dir === 'right' ? 0.6 : 0;
      const from = dir === 'up' ? 400 : dir === 'down' ? 520 : 350;
      const to = dir === 'up' ? 820 : dir === 'down' ? 210 : 560;
      const o = osc('sine', from);
      o.frequency.setValueAtTime(from, t);
      o.frequency.exponentialRampToValueAtTime(to, t + 0.14);
      const gn = gainEnv(0.16, 0.005, 0.14, t);
      o.connect(gn);
      const last = toSfx(gn, pan);
      o.start(t);
      o.stop(t + 0.18);
      o.onended = () => {
        o.disconnect();
        gn.disconnect();
        last.disconnect();
      };
    },

    tick() {
      if (!ready()) return;
      bump('tick');
      const t = now();
      const o = osc('square', 900);
      const gn = gainEnv(0.035, 0.001, 0.025, t);
      chain([o, gn], t, t + 0.04);
    },

    click() {
      if (!ready()) return;
      bump('click');
      const t = now();
      const o = osc('triangle', 700);
      const gn = gainEnv(0.09, 0.001, 0.05, t);
      chain([o, gn], t, t + 0.07);
    },

    pause(paused: boolean) {
      // ambient-bus ramp runs whenever a context exists — independent of mute,
      // so mute/unmute while paused can't leave the bus stuck at 0
      setAmbientPaused(paused);
      if (!ready()) return;
      bump('pause');
      const t = now();
      const o = osc('sawtooth', paused ? 800 : 150);
      o.frequency.setValueAtTime(paused ? 800 : 150, t);
      o.frequency.exponentialRampToValueAtTime(paused ? 110 : 900, t + (paused ? 0.4 : 0.3));
      const lp = ctx!.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2000;
      const gn = gainEnv(0.1, 0.01, paused ? 0.4 : 0.3, t);
      o.connect(lp);
      lp.connect(gn);
      gn.connect(sfxBus!);
      o.start(t);
      o.stop(t + 0.45);
      o.onended = () => {
        o.disconnect();
        lp.disconnect();
        gn.disconnect();
      };
    },

    clear() {
      if (!ready()) return;
      bump('clear');
      const t = now();
      const src = noise();
      const lp = ctx!.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2200, t);
      lp.frequency.exponentialRampToValueAtTime(140, t + 0.5);
      const gn = gainEnv(0.3, 0.01, 0.5, t);
      chain([src, lp, gn], t, t + 0.55);
    },

    reset() {
      // restore the ambient bus even if we're muted/paused right now
      setAmbientPaused(false);
      if (!ready()) return;
      bump('reset');
      const t = now();
      [523.25, 659.25, 783.99].forEach((f, i) => {
        const o = osc('sine', f);
        const gn = gainEnv(0.14, 0.005, 0.3, t + i * 0.09);
        chain([o, gn], t + i * 0.09, t + i * 0.09 + 0.35);
      });
    },

    snapshot() {
      if (!ready()) return;
      bump('snapshot');
      const t = now();
      for (const dt of [0, 0.06]) {
        const src = noise();
        const hp = ctx!.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 4000;
        const gn = gainEnv(0.3, 0.001, 0.02, t + dt);
        chain([src, hp, gn], t + dt, t + dt + 0.04);
      }
    },

    blackHoleStart() {
      if (!ready()) return;
      bump('blackHoleStart');
      const t = now();
      // rising whoosh
      {
        const src = noise();
        const bp = ctx!.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.5;
        bp.frequency.setValueAtTime(200, t);
        bp.frequency.exponentialRampToValueAtTime(1600, t + 0.3);
        const gn = gainEnv(0.25, 0.02, 0.3, t);
        chain([src, bp, gn], t, t + 0.36);
      }
      // looping low hum on the ambient bus (replace if already running)
      api.blackHoleStop();
      humOsc = ctx!.createOscillator();
      humOsc.type = 'sawtooth';
      humOsc.frequency.value = 55;
      humFilter = ctx!.createBiquadFilter();
      humFilter.type = 'lowpass';
      humFilter.frequency.value = 300;
      humLfo = ctx!.createOscillator();
      humLfo.type = 'sine';
      humLfo.frequency.value = 0.7;
      humLfoGain = ctx!.createGain();
      humLfoGain.gain.value = 80;
      humLfo.connect(humLfoGain);
      humLfoGain.connect(humFilter.frequency);
      humGain = ctx!.createGain();
      humGain.gain.setValueAtTime(0.0001, t);
      humGain.gain.linearRampToValueAtTime(0.12, t + 0.3);
      humOsc.connect(humFilter);
      humFilter.connect(humGain);
      humGain.connect(ambientBus!);
      humOsc.start(t);
      humLfo.start(t);
    },

    blackHoleStop() {
      if (!ctx || !humOsc) return;
      bump('blackHoleStop');
      const t = ctx.currentTime;
      const o = humOsc;
      const lfo = humLfo;
      const lg = humLfoGain;
      const f = humFilter;
      const g = humGain;
      humOsc = null;
      humLfo = null;
      humLfoGain = null;
      humFilter = null;
      humGain = null;
      if (g) {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.4);
      }
      try {
        o.stop(t + 0.45);
        if (lfo) lfo.stop(t + 0.45);
      } catch {
        /* already stopped */
      }
      o.onended = () => {
        for (const n of [o, lfo, lg, f, g]) {
          try {
            n?.disconnect();
          } catch {
            /* ok */
          }
        }
      };
    },

    debug() {
      return { ctx, output: comp, stats };
    },

    dispose() {
      api.blackHoleStop();
      if (ctx && ctx.state !== 'closed') {
        try {
          void ctx.close();
        } catch {
          /* ok */
        }
      }
      ctx = null;
    },
  };

  return api;
}

// ============================================================================
// Explosion FX — canvas particles drawn in Render 'afterRender'
// ============================================================================
// Real-time stepped (performance.now delta, clamped in caller), composited
// with bodies so explosions appear in snapshots. At most 4 live explosions.

interface FxSpark {
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; size: number; color: string;
}
interface FxDebris {
  x: number; y: number; vx: number; vy: number;
  angle: number; va: number; size: number; sides: number;
  age: number; life: number; color: string;
}
interface FxSmoke {
  x: number; y: number; vx: number; vy: number;
  r0: number; r1: number; age: number; delay: number; life: number;
}
interface FxRing {
  delay: number; color: string;
}

export interface ExplosionFx {
  x: number;
  y: number;
  age: number;
  duration: number;
  fireballR: number;
  ringMax: number;
  sparks: FxSpark[];
  debris: FxDebris[];
  smoke: FxSmoke[];
  rings: FxRing[];
}

const SPARK_COLORS = ['#fde047', '#f59e0b', '#f43f5e', '#22d3ee', '#8b5cf6', '#ffffff'];
const DEBRIS_COLORS = ['#8b5cf6', '#22d3ee', '#f43f5e', '#f59e0b', '#a3e635'];
export const MAX_EXPLOSION_FX = 4;
export const EXPLOSION_TRAIL_MS = 900;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function createExplosionFx(
  center: { x: number; y: number },
  canvasW: number,
  canvasH: number,
  reducedMotion: boolean,
): ExplosionFx {
  const k = reducedMotion ? 0.4 : 1;
  const sparks: FxSpark[] = [];
  for (let i = 0; i < Math.round(110 * k); i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 280 + Math.random() * 1100;
    sparks.push({
      x: center.x, y: center.y,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      age: 0, life: 500 + Math.random() * 800,
      size: 1 + Math.random() * 2,
      color: SPARK_COLORS[(Math.random() * SPARK_COLORS.length) | 0],
    });
  }
  const debris: FxDebris[] = [];
  for (let i = 0; i < Math.round(18 * k); i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 120 + Math.random() * 500;
    debris.push({
      x: center.x, y: center.y,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 150,
      angle: Math.random() * Math.PI, va: (Math.random() - 0.5) * 14,
      size: 4 + Math.random() * 5, sides: Math.random() < 0.5 ? 3 : 4,
      age: 0, life: 1000 + Math.random() * 500,
      color: DEBRIS_COLORS[(Math.random() * DEBRIS_COLORS.length) | 0],
    });
  }
  const smoke: FxSmoke[] = [];
  for (let i = 0; i < Math.round(12 * k); i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * 30;
    smoke.push({
      x: center.x + Math.cos(a) * d, y: center.y + Math.sin(a) * d,
      vx: Math.cos(a) * (20 + Math.random() * 40), vy: Math.sin(a) * (20 + Math.random() * 40) - 25,
      r0: 20, r1: 90, age: 0, delay: 100, life: 1500,
    });
  }
  return {
    x: center.x, y: center.y, age: 0, duration: 1700,
    fireballR: Math.min(160, 0.25 * Math.min(canvasW, canvasH)),
    ringMax: 0.6 * Math.hypot(canvasW, canvasH),
    sparks, debris, smoke,
    rings: [
      { delay: 0, color: 'rgba(255,255,255,' },
      { delay: 90, color: 'rgba(34,211,238,' },
      { delay: 180, color: 'rgba(139,92,246,' },
    ],
  };
}

/**
 * Advance and draw every live explosion; removes finished entries in place.
 * `dtMs` is the real frame delta (clamped by the caller), `gravity` the
 * engine's gravity vector (for spark/debris drift).
 */
export function stepAndDrawFx(
  ctx: CanvasRenderingContext2D,
  fxList: ExplosionFx[],
  dtMs: number,
  gravity: { x: number; y: number },
): void {
  const dt = dtMs / 1000;
  for (let fi = fxList.length - 1; fi >= 0; fi--) {
    const fx = fxList[fi];
    fx.age += dtMs;
    if (fx.age > fx.duration) {
      fxList.splice(fi, 1);
      continue;
    }
    const age = fx.age;

    // smoke first (under everything)
    for (const s of fx.smoke) {
      const t = (age - s.delay) / s.life;
      if (t < 0 || t > 1) continue;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const r = s.r0 + (s.r1 - s.r0) * easeOutCubic(t);
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      g.addColorStop(0, `rgba(60, 52, 80, ${0.22 * (1 - t)})`);
      g.addColorStop(1, 'rgba(60, 52, 80, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // fireball
    if (age < 600) {
      const grow = Math.min(1, age / 220);
      const fade = 1 - Math.max(0, (age - 220) / 380);
      const r = fx.fireballR * easeOutCubic(grow);
      if (r > 0.5 && fade > 0) {
        const g = ctx.createRadialGradient(fx.x, fx.y, 0, fx.x, fx.y, r);
        g.addColorStop(0, `rgba(255,255,255,${0.95 * fade})`);
        g.addColorStop(0.3, `rgba(253,224,71,${0.8 * fade})`);
        g.addColorStop(0.6, `rgba(245,158,11,${0.6 * fade})`);
        g.addColorStop(0.85, `rgba(244,63,94,${0.35 * fade})`);
        g.addColorStop(1, 'rgba(244,63,94,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // shockwave rings
    for (const ring of fx.rings) {
      const t = (age - ring.delay) / 700;
      if (t < 0 || t > 1) continue;
      const r = fx.ringMax * easeOutCubic(t);
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `${ring.color}${(1 - t) * 0.7})`;
      ctx.lineWidth = 10 - 9 * t;
      ctx.stroke();
    }

    // sparks (streaks)
    for (const s of fx.sparks) {
      if (s.age > s.life) continue;
      s.age += dtMs;
      const drag = Math.exp(-dt * 2.2);
      s.vx *= drag;
      s.vy = s.vy * drag + gravity.y * 320 * dt;
      s.vx += gravity.x * 320 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const a = 1 - s.age / s.life;
      const speed = Math.hypot(s.vx, s.vy);
      if (speed < 1) continue;
      const len = Math.min(26, speed * 0.03 + 3);
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = a;
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - (s.vx / speed) * len, s.y - (s.vy / speed) * len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // debris chunks
    for (const d of fx.debris) {
      if (d.age > d.life) continue;
      d.age += dtMs;
      d.vy += gravity.y * 500 * dt;
      d.vx += gravity.x * 500 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.angle += d.va * dt;
      const a = 1 - d.age / d.life;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.angle);
      ctx.globalAlpha = a * 0.9;
      ctx.fillStyle = d.color;
      ctx.beginPath();
      if (d.sides === 3) {
        ctx.moveTo(0, -d.size);
        ctx.lineTo(d.size, d.size);
        ctx.lineTo(-d.size, d.size);
      } else {
        ctx.rect(-d.size / 2, -d.size / 2, d.size, d.size);
      }
      ctx.fill();
      ctx.restore();
    }
  }
}

/** Tapered fire-coloured streak behind fast non-static bodies. */
export function drawBodyTrails(
  ctx: CanvasRenderingContext2D,
  bodies: Matter.Body[],
  alpha: number,
): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const body of bodies) {
    if (body.isStatic || body.speed < 4) continue;
    const speed = body.speed;
    const len = Math.min(60, speed * 2.4);
    const ux = body.velocity.x / speed;
    const uy = body.velocity.y / speed;
    // start the streak at the body's trailing edge, not its centre
    const edge =
      Math.min(body.bounds.max.x - body.bounds.min.x, body.bounds.max.y - body.bounds.min.y) / 2;
    const sx = body.position.x - ux * edge;
    const sy = body.position.y - uy * edge;
    const a = alpha * Math.min(1, speed / 30);
    const g = ctx.createLinearGradient(sx, sy, body.position.x - ux * len, body.position.y - uy * len);
    g.addColorStop(0, `rgba(253, 224, 71, ${0.75 * a})`);
    g.addColorStop(0.5, `rgba(245, 158, 11, ${0.45 * a})`);
    g.addColorStop(1, 'rgba(244, 63, 94, 0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.min(14, 4 + speed * 0.35);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(body.position.x - ux * len, body.position.y - uy * len);
    ctx.stroke();
  }
  ctx.restore();
}
