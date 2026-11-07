import { useCallback, useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Anchor,
  Bomb,
  Camera,
  Flame,
  Hammer,
  Hand,
  Link,
  Orbit,
  Pause,
  Play,
  RotateCcw,
  Shapes,
  Snowflake,
  Timer,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { CutoutAsset } from '../types/asset';
import {
  applyBlackHole,
  applyGravity,
  applyMaterial,
  BLACK_HOLE_LIFETIME,
  blackHoleRadius,
  clampBodiesInside,
  computeBodySize,
  createEngine,
  createExplosionFx,
  createImageBody,
  createPlaceholderBody,
  createSoundEngine,
  createTestObjects,
  createWalls,
  drawBodyTrails,
  explode,
  explosionOrigin,
  EXPLOSION_TRAIL_MS,
  GRAVITY_MAX,
  limitVelocity,
  MATERIALS,
  MAX_EXPLOSION_FX,
  MAX_SPEED,
  nonStaticBodies,
  rasterizeTexture,
  readStoredMuted,
  registerTexture,
  releaseBodyTexture,
  resizeRender,
  spawnPosition,
  stepAndDrawFx,
  textureKey,
  updateWalls,
  type BlackHole,
  type ExplosionFx,
  type GravityDirection,
  type MaterialName,
  type SoundEngine,
} from '../lib/physics';
import {
  createObjectRegistry,
  enforceObjectCap,
  type ObjectRegistry,
  type PhysObject,
} from '../lib/physics/objects';
import {
  localTexture,
  MAX_SHARDS,
  shatterBody,
  shardExpired,
  tagShard,
} from '../lib/physics/fracture';
import {
  createBurst,
  createDustBurst,
  createGlowRing,
  createImpactDust,
  createMaterializeFx,
  stepAndDrawBursts,
  stepAndDrawRings,
  type ParticleBurst,
  type RingFx,
} from '../lib/physics/fx';
import { createHullBody } from '../lib/physics/hull';
import { createJelly, tintJellyTextures } from '../lib/physics/softbody';
import { createRagdoll, createStickFigure, enforceJointLimits, enforcePinPositions, type RagdollJoint } from '../lib/physics/ragdoll';
import { createRope, createSpringLink, drawRope, drawSpring } from '../lib/physics/ropes';
import './PhysicsWorld.css';

export interface PhysicsWorldProps {
  spawnRequests: CutoutAsset[];
}

type MouseHandlers = Matter.Mouse & {
  mousemove: EventListener;
  mousedown: EventListener;
  mouseup: EventListener;
  mousewheel: EventListener;
};

const MOUSE_EVENTS: Array<[string, 'mousemove' | 'mousedown' | 'mouseup' | 'mousewheel']> = [
  ['mousemove', 'mousemove'],
  ['mousedown', 'mousedown'],
  ['mouseup', 'mouseup'],
  ['wheel', 'mousewheel'],
  ['touchmove', 'mousemove'],
  ['touchstart', 'mousedown'],
  ['touchend', 'mouseup'],
];

type ToolName = 'grab' | 'crumble' | 'freeze' | 'fire' | 'hang' | 'link' | 'blackhole';
type SpawnKind = 'solid' | 'jelly' | 'ragdoll';

const TOOLS: Array<{ id: ToolName; label: string; icon: React.ReactNode }> = [
  { id: 'grab', label: 'Grab', icon: <Hand size={16} /> },
  { id: 'crumble', label: 'Crumble', icon: <Hammer size={16} /> },
  { id: 'freeze', label: 'Freeze', icon: <Snowflake size={16} /> },
  { id: 'fire', label: 'Fire', icon: <Flame size={16} /> },
  { id: 'hang', label: 'Hang', icon: <Anchor size={16} /> },
  { id: 'link', label: 'Link', icon: <Link size={16} /> },
  { id: 'blackhole', label: 'Black Hole', icon: <Orbit size={16} /> },
];

const MAX_ROPES = 12;

/** Engine-time burn duration (ms). */
const BURN_MS = 3000;

interface ScaleIn {
  body: Matter.Body;
  t0: number;
  xs: number;
  ys: number;
}

interface Burning {
  obj: PhysObject;
  t0: number;
  voice: { stop(): void };
}

function addJelly(
  engine: Matter.Engine,
  registry: ObjectRegistry,
  jelly: NonNullable<ReturnType<typeof createJelly>>,
): void {
  registry.add(engine.world, {
    id: registry.nextId(),
    kind: 'jelly',
    root: jelly.root,
    bodies: jelly.bodies,
    constraints: jelly.constraints,
    textureKeys: jelly.textureKeys,
    createdAt: engine.timing.timestamp,
  });
}

function addRagdoll(
  engine: Matter.Engine,
  registry: ObjectRegistry,
  rd: NonNullable<ReturnType<typeof createRagdoll>>,
): void {
  registry.add(engine.world, {
    id: registry.nextId(),
    kind: 'ragdoll',
    root: rd.root,
    bodies: rd.bodies,
    constraints: rd.constraints,
    textureKeys: rd.textureKeys,
    createdAt: engine.timing.timestamp,
    joints: rd.joints,
  });
}

function addShowcase(
  engine: Matter.Engine,
  render: Matter.Render,
  w: number,
  h: number,
  material: MaterialName,
  registry: ObjectRegistry,
  spawnAs: SpawnKind,
  spawnFx?: (body: Matter.Body, opts?: { sound?: boolean }) => void,
): void {
  // stick figure: ragdoll in Ragdoll mode, jelly in Jelly mode, hull solid otherwise
  {
    const stick = createStickFigure();
    const sx = w * (0.45 + Math.random() * 0.1);
    const sy = 40;
    if (spawnAs === 'ragdoll') {
      const rd = createRagdoll({
        x: sx,
        y: sy + 60,
        w: 110,
        h: 200,
        texture: stick.canvas,
        pose: stick.pose,
        render,
        material,
      });
      if (rd) {
        addRagdoll(engine, registry, rd);
        spawnFx?.(rd.root, { sound: false });
      }
    } else if (spawnAs === 'jelly') {
      const jelly = createJelly({ x: sx, y: sy + 60, w: 110, h: 200, texture: stick.canvas, render, material });
      if (jelly) {
        addJelly(engine, registry, jelly);
        spawnFx?.(jelly.root, { sound: false });
      }
    } else {
      const key = `physics-tex-stick-${Date.now()}`;
      registerTexture(render, key, stick.canvas);
      const body =
        createHullBody(sx, sy + 60, 110, 200, key, stick.canvas) ??
        Matter.Bodies.rectangle(sx, sy + 60, 110, 200, {
          render: { sprite: { texture: key, xScale: 1, yScale: 1 } },
        });
      applyMaterial(body, material);
      registry.add(engine.world, {
        id: registry.nextId(),
        kind: 'solid',
        root: body,
        bodies: [body],
        constraints: [],
        textureKeys: [key],
        createdAt: engine.timing.timestamp,
      });
      spawnFx?.(body, { sound: false });
    }
  }
  for (const item of createTestObjects(w, h)) {
    if (spawnAs === 'jelly') {
      const body = item.body;
      const local = body.vertices.map((v) => ({
        x: v.x - body.position.x,
        y: v.y - body.position.y,
      }));
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
      const tex = item.texture
        ? item.texture.canvas
        : localTexture(body, render, local, bw, bh);
      const jelly = createJelly({
        x: body.position.x,
        y: body.position.y,
        w: bw,
        h: bh,
        texture: tex,
        render,
        material,
      });
      if (jelly) {
        registry.add(engine.world, {
          id: registry.nextId(),
          kind: 'jelly',
          root: jelly.root,
          bodies: jelly.bodies,
          constraints: jelly.constraints,
          textureKeys: jelly.textureKeys,
          createdAt: engine.timing.timestamp,
        });
        spawnFx?.(jelly.root, { sound: false });
        continue;
      }
    }
    if (item.texture) registerTexture(render, item.texture.key, item.texture.canvas);
    applyMaterial(item.body, material);
    spawnFx?.(item.body, { sound: false });
    registry.add(engine.world, {
      id: registry.nextId(),
      kind: 'solid',
      root: item.body,
      bodies: [item.body],
      constraints: [],
      textureKeys: item.texture ? [item.texture.key] : [],
      createdAt: engine.timing.timestamp,
    });
  }
}

export default function PhysicsWorld({ spawnRequests }: PhysicsWorldProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Matter.Engine | null>(null);
  const runnerRef = useRef<Matter.Runner | null>(null);
  const renderRef = useRef<Matter.Render | null>(null);
  const mouseConstraintRef = useRef<Matter.MouseConstraint | null>(null);
  const processedIdsRef = useRef<Set<string>>(new Set());
  const clearGenerationRef = useRef(0);
  const shakeTimeoutRef = useRef<number | undefined>(undefined);
  const settingsRef = useRef({ gravityOn: true, gravityDir: 'down' as GravityDirection, gravityStrength: 1 });
  const materialRef = useRef<MaterialName>('normal');
  const selectedBodyRef = useRef<Matter.Body | null>(null);
  const blackHoleRef = useRef<BlackHole | null>(null);
  const registryRef = useRef<ObjectRegistry | null>(null);
  const toolRef = useRef<ToolName>('grab');
  const defaultMaskRef = useRef<number>(-1);
  const shatterQueueRef = useRef<Set<number>>(new Set());
  const dustBurstsRef = useRef<ParticleBurst[]>([]);
  const ringsRef = useRef<RingFx[]>([]);
  const flamesRef = useRef<ParticleBurst[]>([]);
  const scaleInsRef = useRef<ScaleIn[]>([]);
  const burningRef = useRef<Burning[]>([]);
  const dustTimesRef = useRef<number[]>([]);
  const fragileRef = useRef(false);
  const explodeShatterRef = useRef(false);
  const spawnAsRef = useRef<SpawnKind>('solid');
  const pendingLinkRef = useRef<{
    obj: PhysObject;
    body: Matter.Body;
    point: { x: number; y: number };
    angle: number;
  } | null>(null);
  const soundRef = useRef<SoundEngine | null>(null);
  const fxListRef = useRef<ExplosionFx[]>([]);
  const trailUntilRef = useRef(0);
  const lastTickRef = useRef(0);
  const explodeBtnRef = useRef<HTMLButtonElement | null>(null);

  const [objectCount, setObjectCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [gravityOn, setGravityOn] = useState(true);
  const [gravityDir, setGravityDir] = useState<GravityDirection>('down');
  const [gravityStrength, setGravityStrength] = useState(1);
  const [material, setMaterial] = useState<MaterialName>('normal');
  const [tool, setToolState] = useState<ToolName>('grab');
  const [fragile, setFragile] = useState(false);
  const [explodeShatter, setExplodeShatter] = useState(false);
  const [slowMo, setSlowMo] = useState(false);
  const [spawnAs, setSpawnAs] = useState<SpawnKind>('solid');
  const [muted, setMuted] = useState(readStoredMuted);
  const [fxKey, setFxKey] = useState(0);
  const [fxReduced, setFxReduced] = useState(false);
  const [fxPos, setFxPos] = useState({ x: 0, y: 0 });
  const [boomPos, setBoomPos] = useState({ x: 0, y: 0 });
  const [boomRot, setBoomRot] = useState(0);
  const [scorchKey, setScorchKey] = useState(0);
  const [snapKey, setSnapKey] = useState(0);

  const updateCount = useCallback(() => {
    const registry = registryRef.current;
    if (registry) setObjectCount(registry.size);
  }, []);

  /** Clear the selection if its body is no longer in the world. */
  const syncSelection = useCallback(() => {
    const engine = engineRef.current;
    const sel = selectedBodyRef.current;
    if (engine && sel && !Matter.Composite.allBodies(engine.world).includes(sel)) {
      selectedBodyRef.current = null;
    }
  }, []);

  const setTool = useCallback((t: ToolName) => {
    toolRef.current = t;
    setToolState(t);
    pendingLinkRef.current = null;
    const mc = mouseConstraintRef.current;
    if (mc) {
      mc.collisionFilter.mask = t === 'grab' ? defaultMaskRef.current : 0;
    }
  }, []);

  /** Shatter a solid object: shards to world, object out, dust + crack. */
  const shatterObject = useCallback(
    (
      obj: PhysObject,
      impact: { x: number; y: number },
      shardCount?: number,
      opts?: { sound?: boolean; dust?: boolean; count?: boolean; tint?: 'ice' | 'ash' | null },
    ) => {
      const engine = engineRef.current;
      const render = renderRef.current;
      const registry = registryRef.current;
      if (!engine || !render || !registry || obj.kind !== 'solid') return;
      const frozen = (obj.root.plugin as Record<string, unknown> | undefined)?.frozen === true;
      const shards = shatterBody(obj.root, {
        world: engine.world,
        render,
        impact,
        shardCount,
        tint: opts?.tint !== undefined ? opts.tint : frozen ? 'ice' : null,
      });
      registry.remove(engine.world, render, obj);
      const now = engine.timing.timestamp;
      for (const s of shards) {
        tagShard(s, now);
        Matter.Composite.add(engine.world, s);
      }
      // shard cap: remove oldest beyond MAX_SHARDS
      const shardBodies = nonStaticBodies(engine).filter(
        (b) => (b.plugin as Record<string, unknown> | undefined)?.shard,
      );
      for (let i = 0; i < shardBodies.length - MAX_SHARDS; i++) {
        releaseBodyTexture(render, shardBodies[i]);
        Matter.Composite.remove(engine.world, shardBodies[i]);
      }
      if (opts?.dust !== false) dustBurstsRef.current.push(createDustBurst(impact.x, impact.y, opts?.tint ?? (frozen ? 'ice' : null)));
      if (opts?.sound !== false) soundRef.current?.crack(0.8);
      if (selectedBodyRef.current && obj.bodies.includes(selectedBodyRef.current)) {
        selectedBodyRef.current = null;
      }
      if (opts?.count !== false) updateCount();
    },
    [updateCount],
  );

  /** Dissolve a composite object (jelly): drop springs/registry entry but keep
   *  the bodies in the world as shards. */
  const dissolveObject = useCallback(
    (
      obj: PhysObject,
      impact: { x: number; y: number },
      opts?: { sound?: boolean; dust?: boolean; count?: boolean; tint?: 'ice' | 'ash' | null },
    ) => {
      const engine = engineRef.current;
      const render = renderRef.current;
      const registry = registryRef.current;
      if (!engine || !render || !registry || obj.kind === 'solid') return;
      const frozen = (obj.root.plugin as Record<string, unknown> | undefined)?.frozen === true;
      const tint = opts?.tint !== undefined ? opts.tint : frozen ? 'ice' : null;
      if (tint) tintJellyTextures(obj, render, tint);
      registry.drop(engine.world, obj);
      const now = engine.timing.timestamp;
      for (const b of obj.bodies) {
        b.collisionFilter.group = 0;
        Matter.Body.setStatic(b, false);
        tagShard(b, now);
        (b.plugin as Record<string, unknown>).shard = true;
      }
      // shard cap: remove oldest beyond MAX_SHARDS
      const shardBodies = nonStaticBodies(engine).filter(
        (b) => (b.plugin as Record<string, unknown> | undefined)?.shard,
      );
      for (let i = 0; i < shardBodies.length - MAX_SHARDS; i++) {
        releaseBodyTexture(render, shardBodies[i]);
        Matter.Composite.remove(engine.world, shardBodies[i]);
      }
      if (opts?.dust !== false) dustBurstsRef.current.push(createDustBurst(impact.x, impact.y, tint));
      if (opts?.sound !== false) soundRef.current?.crack(0.8);
      if (selectedBodyRef.current && obj.bodies.includes(selectedBodyRef.current)) {
        selectedBodyRef.current = null;
      }
      if (opts?.count !== false) updateCount();
    },
    [updateCount],
  );

  /** Crumble entry point: solids shatter, composites dissolve. */
  const crumbleObject = useCallback(
    (
      obj: PhysObject,
      impact: { x: number; y: number },
      shardCount?: number,
      opts?: { sound?: boolean; dust?: boolean; count?: boolean; tint?: 'ice' | 'ash' | null },
    ) => {
      if (obj.kind === 'solid') shatterObject(obj, impact, shardCount, opts);
      else dissolveObject(obj, impact, opts);
    },
    [shatterObject, dissolveObject],
  );

  /** Materialize feedback for a newly spawned body (ring + sparkles + scale-in). */
  const spawnFx = useCallback((body: Matter.Body, opts?: { sound?: boolean }) => {
    ringsRef.current.push(createGlowRing(body.position.x, body.position.y));
    dustBurstsRef.current.push(createMaterializeFx(body.position.x, body.position.y));
    const sp = body.render.sprite;
    scaleInsRef.current.push({
      body,
      t0: performance.now(),
      xs: sp?.xScale ?? 1,
      ys: sp?.yScale ?? 1,
    });
    body.render.opacity = 0;
    if (opts?.sound !== false) soundRef.current?.materialize();
  }, []);

  // effect-stable access without making the mount effect depend on callbacks
  const actionsRef = useRef({ crumbleObject, setTool });
  useEffect(() => {
    actionsRef.current = { crumbleObject, setTool };
  });

  // --- Engine lifecycle (runs once per mount; StrictMode-safe) ---------------
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const w = stage.clientWidth || 800;
    const h = stage.clientHeight || 600;

    const engine = createEngine();
    engine.constraintIterations = 8;
    const render = Matter.Render.create({
      element: stage,
      engine,
      options: {
        width: w,
        height: h,
        wireframes: false,
        background: 'transparent',
        pixelRatio: window.devicePixelRatio || 1,
      },
    });
    // Mouse created after Render so the canvas carries data-pixel-ratio.
    const mouse = Matter.Mouse.create(render.canvas) as MouseHandlers;
    const mouseConstraint = Matter.MouseConstraint.create(engine, {
      mouse,
      constraint: { stiffness: 0.2, render: { visible: false } },
    });
    Matter.Composite.add(engine.world, mouseConstraint);

    // Matter's wheel handler preventDefaults — drop it so the page scrolls.
    render.canvas.removeEventListener('wheel', mouse.mousewheel);

    const walls = createWalls(w, h);
    Matter.Composite.add(engine.world, walls);

    const runner = Matter.Runner.create();
    const sound = createSoundEngine(readStoredMuted());
    const registry = createObjectRegistry();
    soundRef.current = sound;
    registryRef.current = registry;
    defaultMaskRef.current = mouseConstraint.collisionFilter.mask ?? -1;
    const dustBursts = dustBurstsRef.current;
    const rings = ringsRef.current;
    const flames = flamesRef.current;
    const scaleIns = scaleInsRef.current;
    const burning = burningRef.current;
    const dustTimes = dustTimesRef.current;
    const shatterQueue = shatterQueueRef.current;
    const fxList = fxListRef.current;

    engineRef.current = engine;
    runnerRef.current = runner;
    renderRef.current = render;
    mouseConstraintRef.current = mouseConstraint;
    processedIdsRef.current = new Set();

    const { gravityOn: gOn, gravityDir: gDir, gravityStrength: gStr } = settingsRef.current;
    applyGravity(engine, gOn, gDir, gStr);

    const onWindowMouseUp = () => {
      mouse.button = -1;
    };
    window.addEventListener('mouseup', onWindowMouseUp);

    // pre-step velocities for collision impact sounds (collisionStart fires
    // after the solver, so post-solve speeds would mute low-restitution hits)
    const preVel = new WeakMap<Matter.Body, { x: number; y: number }>();
    const lastImpactAt = new WeakMap<Matter.Body, number>();

    const onBeforeUpdate = () => {
      const bodies = nonStaticBodies(engine);
      for (const b of bodies) {
        preVel.set(b, { x: b.velocity.x, y: b.velocity.y });
        // shard lifecycle: fade last 1.5s of life, remove + release texture
        if (shardExpired(b, engine.timing.timestamp)) {
          releaseBodyTexture(render, b);
          Matter.Composite.remove(engine.world, b);
        }
      }
      // burning objects: engine-time progress, then crumble to ash
      if (burning.length > 0) {
        const ts = engine.timing.timestamp;
        for (let i = burning.length - 1; i >= 0; i--) {
          const e = burning[i];
          if (registry.objectOf(e.obj.root) !== e.obj) {
            e.voice.stop();
            burning.splice(i, 1);
            continue;
          }
          if (ts - e.t0 >= BURN_MS) {
            e.voice.stop();
            burning.splice(i, 1);
            const c = e.obj.root.position;
            actionsRef.current.crumbleObject(e.obj, { x: c.x, y: c.y }, undefined, {
              tint: 'ash',
            });
            dustBursts.push(createDustBurst(c.x, c.y, 'ash'));
          }
        }
      }
      for (const obj of registry.list()) {
        if (obj.kind === 'ragdoll' && obj.joints) {
          enforceJointLimits(obj.joints as RagdollJoint[]);
          enforcePinPositions(obj.constraints);
        }
      }
      const hole = blackHoleRef.current;
      if (hole) {
        if (engine.timing.timestamp - hole.bornAt > BLACK_HOLE_LIFETIME) {
          blackHoleRef.current = null;
          sound.blackHoleStop();
        } else {
          const cw = render.options.width || 800;
          const ch = render.options.height || 600;
          applyBlackHole(bodies, hole, blackHoleRadius(cw, ch));
        }
      }
      limitVelocity(bodies, MAX_SPEED);
    };

    const onCollisionStart = (e: Matter.IEventCollision<Matter.Engine>) => {
      const tNow = performance.now();
      for (const pair of e.pairs) {
        const a = pair.bodyA.parent;
        const b = pair.bodyB.parent;
        const va = a.isStatic ? { x: 0, y: 0 } : preVel.get(a) || { x: 0, y: 0 };
        const vb = b.isStatic ? { x: 0, y: 0 } : preVel.get(b) || { x: 0, y: 0 };
        const n = pair.collision.normal;
        const relSpeed = Math.abs((va.x - vb.x) * n.x + (va.y - vb.y) * n.y);
        if (relSpeed < 1.2) continue;
        // fragile: hard hits queue a crumble BEFORE the sound cooldown
        if (fragileRef.current && relSpeed > 10) {
          for (const body of [a, b]) {
            if (body.isStatic) continue;
            const obj = registry.objectOf(body);
            if (obj && obj.kind === 'solid') shatterQueue.add(obj.id);
          }
        }
        // brittle: frozen bodies shatter on hard hits even with Fragile off
        if (relSpeed > 12) {
          for (const body of [a, b]) {
            if (!((body.plugin as Record<string, unknown> | undefined)?.frozen)) continue;
            const obj = registry.objectOf(body);
            if (obj && obj.kind === 'solid') shatterQueue.add(obj.id);
          }
        }
        // impact dust at the contact point, rate-limited to ~12 bursts/s;
        // shard hits only 1-in-4
        if (relSpeed > 4) {
          const shardHit =
            (a.plugin as Record<string, unknown> | undefined)?.shard ||
            (b.plugin as Record<string, unknown> | undefined)?.shard;
          if (!shardHit || Math.random() < 0.25) {
            while (dustTimes.length > 0 && tNow - dustTimes[0] > 1000) dustTimes.shift();
            if (dustTimes.length < 12) {
              dustTimes.push(tNow);
              const sup = pair.collision.supports;
              const supportCount = (pair.collision as { supportCount?: number }).supportCount;
              const n2 = Math.min(supportCount || sup.length, sup.length);
              let sx = 0;
              let sy = 0;
              for (let i = 0; i < n2; i++) {
                sx += sup[i].x;
                sy += sup[i].y;
              }
              dustBursts.push(createImpactDust(sx / n2, sy / n2));
            }
          }
        }
        const moving = a.isStatic ? b : b.isStatic ? a : a.speed >= b.speed ? a : b;
        const last = lastImpactAt.get(moving) || 0;
        if (tNow - last < 80) continue;
        lastImpactAt.set(moving, tNow);
        const matName = (moving.plugin as Record<string, unknown> | undefined)?.material;
        const material =
          typeof matName === 'string' && matName in MATERIALS
            ? (matName as MaterialName)
            : 'normal';
        sound.impact(Math.min(1, (relSpeed - 1.2) / 12), material);
      }
    };

    let lastCursor = '';
    const setCursor = (c: string) => {
      if (c !== lastCursor) {
        lastCursor = c;
        render.canvas.style.cursor = c;
      }
    };
    const onAfterUpdate = () => {
      // process queued crumbles (fragile impacts) — deduped by object id
      if (shatterQueue.size > 0) {
        const ids = new Set(shatterQueue);
        shatterQueue.clear();
        for (const obj of registry.list()) {
          if (ids.has(obj.id)) {
            actionsRef.current.crumbleObject(obj, {
              x: obj.root.position.x + (Math.random() - 0.5) * 20,
              y: obj.root.position.y + (Math.random() - 0.5) * 20,
            });
          }
        }
      }
      if (toolRef.current !== 'grab') {
        setCursor('crosshair');
      } else if (mouseConstraint.body) {
        setCursor('grabbing');
      } else if (Matter.Query.point(nonStaticBodies(engine), mouse.position).length > 0) {
        setCursor('grab');
      } else {
        setCursor('');
      }
    };
    Matter.Events.on(engine, 'beforeUpdate', onBeforeUpdate);
    Matter.Events.on(engine, 'afterUpdate', onAfterUpdate);
    Matter.Events.on(engine, 'collisionStart', onCollisionStart);

    const onStartDrag = (e: Matter.IEvent<Matter.MouseConstraint> & { body?: Matter.Body }) => {
      if (e.body) {
        selectedBodyRef.current = e.body;
        sound.grab();
      }
    };
    const onEndDrag = (e: Matter.IEvent<Matter.MouseConstraint> & { body?: Matter.Body }) => {
      const body = e.body;
      if (body && body.speed > 6) {
        sound.throwWhoosh(Math.min(1, body.speed / 25));
      }
    };
    Matter.Events.on(mouseConstraint, 'startdrag', onStartDrag);
    Matter.Events.on(mouseConstraint, 'enddrag', onEndDrag);

    // tool clicks — own DOM listener registered AFTER Mouse.create so
    // mouse.position is already updated; works while paused (unlike the
    // MouseConstraint 'mousedown' event which fires inside engine updates)
    const onCanvasMouseDown = () => {
      const tool = toolRef.current;
      const pos = { x: mouse.position.x, y: mouse.position.y };
      if (tool === 'blackhole') {
        blackHoleRef.current = { x: pos.x, y: pos.y, bornAt: engine.timing.timestamp };
        sound.blackHoleStart();
        return;
      }
      if (tool === 'crumble') {
        const hit = Matter.Query.point(registry.allBodies(), pos)[0];
        if (hit) {
          const obj = registry.objectOf(hit);
          if (obj) actionsRef.current.crumbleObject(obj, pos);
        }
        return;
      }
      if (tool === 'freeze') {
        const hit = Matter.Query.point(registry.allBodies(), pos)[0];
        if (hit) {
          const obj = registry.objectOf(hit);
          if (obj) {
            const frozen = (obj.root.plugin as Record<string, unknown>).frozen === true;
            for (const b of obj.bodies) {
              Matter.Body.setStatic(b, !frozen);
              if (frozen) delete (b.plugin as Record<string, unknown>).frozen;
              else (b.plugin as Record<string, unknown>).frozen = true;
            }
            if (frozen) sound.thaw();
            else sound.freeze();
          }
        }
        return;
      }
      if (tool === 'fire') {
        const hit = Matter.Query.point(registry.allBodies(), pos)[0];
        if (hit) {
          const obj = registry.objectOf(hit);
          if (obj) {
            if ((obj.root.plugin as Record<string, unknown>).frozen === true) {
              for (const b of obj.bodies) {
                Matter.Body.setStatic(b, false);
                delete (b.plugin as Record<string, unknown>).frozen;
              }
              dustBursts.push(createDustBurst(pos.x, pos.y, 'ice'));
              sound.thaw();
            } else if (!burning.some((e) => e.obj === obj)) {
              burning.push({ obj, t0: engine.timing.timestamp, voice: sound.fireStart() });
            }
          }
        }
        return;
      }
      if (tool === 'hang') {
        const hit = Matter.Query.point(registry.allBodies(), pos)[0];
        if (hit) {
          const obj = registry.objectOf(hit);
          if (obj) {
            // anchor on the stage edge opposite gravity
            const g = engine.gravity;
            const cw = render.options.width || 800;
            const ch = render.options.height || 600;
            const anchor =
              Math.abs(g.y) >= Math.abs(g.x)
                ? { x: pos.x, y: g.y > 0 ? 8 : ch - 8 }
                : { x: g.x > 0 ? 8 : cw - 8, y: pos.y };
            const { bodies: rb, constraints: rc } = createRope(anchor, pos, hit);
            registry.attach(engine.world, {
              id: registry.nextId(),
              kind: 'rope',
              objectIds: [obj.id],
              bodies: rb,
              constraints: rc,
              anchor,
            });
            const ropes = registry.attachments().filter((a) => a.kind === 'rope');
            for (let i = 0; i < ropes.length - MAX_ROPES; i++) {
              registry.detach(engine.world, ropes[i]);
            }
            sound.click();
          }
        }
        return;
      }
      if (tool === 'link') {
        const hit = Matter.Query.point(registry.allBodies(), pos)[0];
        const pending = pendingLinkRef.current;
        if (!hit) {
          pendingLinkRef.current = null;
          return;
        }
        const obj = registry.objectOf(hit);
        if (!obj) return;
        if (!pending) {
          pendingLinkRef.current = {
            obj,
            body: hit,
            point: { x: pos.x - hit.position.x, y: pos.y - hit.position.y },
            angle: hit.angle,
          };
          sound.click();
          return;
        }
        if (pending.obj === obj) {
          pendingLinkRef.current = null;
          return;
        }
        const pointB = { x: pos.x - hit.position.x, y: pos.y - hit.position.y };
        // A may have turned since it was picked: rotate its world-frame offset along
        const da = pending.body.angle - pending.angle;
        const pointA = {
          x: pending.point.x * Math.cos(da) - pending.point.y * Math.sin(da),
          y: pending.point.x * Math.sin(da) + pending.point.y * Math.cos(da),
        };
        const c = createSpringLink(pending.body, hit, pointA, pointB);
        registry.attach(engine.world, {
          id: registry.nextId(),
          kind: 'spring',
          objectIds: [pending.obj.id, obj.id],
          bodies: [],
          constraints: [c],
        });
        pendingLinkRef.current = null;
        sound.click();
        return;
      }
      // grab tool: deselect on empty-canvas click
      if (Matter.Query.point(registry.allBodies(), pos).length === 0) {
        selectedBodyRef.current = null;
      }
    };
    render.canvas.addEventListener('mousedown', onCanvasMouseDown);
    render.canvas.addEventListener('touchstart', onCanvasMouseDown);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      actionsRef.current.setTool('grab');
    };
    window.addEventListener('keydown', onKeyDown);

    let lastFrameT = performance.now();
    const fxMsLog: number[] = [];
    const onAfterRender = () => {
      const frameT = performance.now();
      const dtMs = Math.min(50, frameT - lastFrameT);
      lastFrameT = frameT;
      const ctx = render.context;
      const pr = render.options.pixelRatio || 1;
      ctx.save();
      ctx.setTransform(pr, 0, 0, pr, 0, 0);

      // explosion FX: body trails then particles (composited with bodies,
      // captured by snapshots)
      const sdtMs = dtMs * (engine.timing.timeScale || 1);
      const fxT0 = performance.now();
      if (dustBursts.length > 0) {
        stepAndDrawBursts(ctx, dustBursts, sdtMs, engine.gravity);
      }
      if (flames.length > 0) {
        stepAndDrawBursts(ctx, flames, sdtMs, engine.gravity);
      }
      if (rings.length > 0) {
        stepAndDrawRings(ctx, rings, sdtMs);
      }
      const trailLeft = trailUntilRef.current - frameT;
      if (trailLeft > 0) {
        drawBodyTrails(ctx, nonStaticBodies(engine), Math.min(1, trailLeft / EXPLOSION_TRAIL_MS));
      }
      if (fxList.length > 0) {
        stepAndDrawFx(ctx, fxList, sdtMs, engine.gravity);
      }
      // scale-ins + fade-ins (real time; drop entries whose body is gone)
      if (scaleIns.length > 0) {
        const worldBodies = Matter.Composite.allBodies(engine.world);
        for (let i = scaleIns.length - 1; i >= 0; i--) {
          const e = scaleIns[i];
          if (!worldBodies.includes(e.body)) {
            scaleIns.splice(i, 1);
            continue;
          }
          const t = Math.min(1, (frameT - e.t0) / 250);
          const c1 = 1.70158;
          const k = 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); // easeOutBack
          const sp = e.body.render.sprite;
          if (sp) {
            sp.xScale = e.xs * (0.3 + 0.7 * k);
            sp.yScale = e.ys * (0.3 + 0.7 * k);
          }
          e.body.render.opacity = Math.min(1, (frameT - e.t0) / 200);
          if (t >= 1) {
            if (sp) {
              sp.xScale = e.xs;
              sp.yScale = e.ys;
            }
            e.body.render.opacity = 1;
            scaleIns.splice(i, 1);
          }
        }
      }
      // flame emission (paused -> no new flames); cap ~300 particles
      if (runner.enabled && burning.length > 0) {
        let flameCount = 0;
        for (const b of flames) flameCount += b.particles.length;
        for (const e of burning) {
          if (flameCount > 300) break;
          // spawn points biased to the anti-gravity side of every tile
          const bodies2 = e.obj.bodies;
          const bb = bodies2[(Math.random() * bodies2.length) | 0];
          const verts = bb.vertices;
          const g = engine.gravity;
          let v = verts[(Math.random() * verts.length) | 0];
          for (let i = 0; i < 3; i++) {
            const c2 = verts[(Math.random() * verts.length) | 0];
            if ((c2.x - bb.position.x) * -g.x + (c2.y - bb.position.y) * -g.y >
                (v.x - bb.position.x) * -g.x + (v.y - bb.position.y) * -g.y) v = c2;
          }
          const b2 = createBurst(v.x, v.y, {
            count: 3 + ((Math.random() * 2) | 0),
            colors: ['rgba(255,140,20,0.9)', 'rgba(255,90,10,0.85)', 'rgba(255,200,60,0.9)'],
            speedMin: 40,
            speedMax: 120,
            dirAngle: Math.atan2(-g.y, -g.x || 0.001),
            spread: 0.55,
            r0: [4, 9],
            r1: [0, 2],
            life: [400, 900],
            drag: 2,
            additive: true,
          });
          flameCount += b2.particles.length;
          flames.push(b2);
          if (Math.random() < 0.12) {
            const emb = createBurst(v.x, v.y, {
              count: 1,
              colors: ['rgba(255,240,180,0.95)'],
              speedMin: 60,
              speedMax: 160,
              dirAngle: Math.atan2(-g.y, -g.x || 0.001),
              spread: 1.2,
              r0: [1, 2],
              r1: [0, 0.5],
              life: [700, 1200],
              drag: 1.2,
              additive: true,
            });
            flameCount += emb.particles.length;
            flames.push(emb);
          }
        }
      }
      // icy overlay on frozen bodies + burn overlay
      {
        const ts = engine.timing.timestamp;
        for (const b of registry.allBodies()) {
          if (!((b.plugin as Record<string, unknown> | undefined)?.frozen)) continue;
          const verts = b.vertices;
          ctx.beginPath();
          ctx.moveTo(verts[0].x, verts[0].y);
          for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
          ctx.closePath();
          ctx.fillStyle = 'rgba(160, 215, 255, 0.45)';
          ctx.fill();
          ctx.save();
          ctx.shadowColor = 'rgba(140, 210, 255, 0.9)';
          ctx.shadowBlur = 12;
          ctx.strokeStyle = 'rgba(200, 238, 255, 0.95)';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
          // 4-point sparkle glints at a few vertices
          ctx.strokeStyle = 'rgba(240, 250, 255, 0.9)';
          ctx.lineWidth = 1.2;
          const glints = Math.min(4, Math.max(3, verts.length >> 1));
          for (let i = 0; i < glints; i++) {
            const v = verts[(i * 2) % verts.length];
            ctx.beginPath();
            ctx.moveTo(v.x - 5, v.y);
            ctx.lineTo(v.x + 5, v.y);
            ctx.moveTo(v.x, v.y - 5);
            ctx.lineTo(v.x, v.y + 5);
            ctx.stroke();
          }
        }
        for (const e of burning) {
          const p = Math.min(1, (ts - e.t0) / BURN_MS);
          for (const bb of e.obj.bodies) {
            const verts = bb.vertices;
            ctx.beginPath();
            ctx.moveTo(verts[0].x, verts[0].y);
            for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
            ctx.closePath();
            ctx.fillStyle = 'rgba(10, 6, 4, ' + (0.55 * p).toFixed(3) + ')';
            ctx.fill();
          }
          const verts = e.obj.root.vertices;
          ctx.beginPath();
          ctx.moveTo(verts[0].x, verts[0].y);
          for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
          ctx.closePath();
          ctx.save();
          ctx.shadowColor = 'rgba(255, 120, 20, 0.9)';
          ctx.shadowBlur = 10;
          ctx.strokeStyle =
            'rgba(255, ' + Math.round(160 - 80 * p) + ', 30, ' + (0.4 + 0.6 * p).toFixed(3) + ')';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
        }
      }
      if (import.meta.env.DEV) {
        fxMsLog.push(performance.now() - fxT0);
        if (fxMsLog.length > 600) fxMsLog.splice(0, fxMsLog.length - 600);
      }

      // black hole visual
      const hole = blackHoleRef.current;
      if (hole) {
        const age = engine.timing.timestamp - hole.bornAt;
        const alpha = Math.min(1, age / 400, (BLACK_HOLE_LIFETIME - age) / 400);
        const cw = render.options.width || 800;
        const ch = render.options.height || 600;
        const R = blackHoleRadius(cw, ch);
        const pulse = 1 + 0.08 * Math.sin(engine.timing.timestamp / 180);

        ctx.globalAlpha = Math.max(0, alpha);
        // faint reach ring
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, R, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(139, 92, 246, 0.25)';
        ctx.setLineDash([6, 10]);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        // radial glow
        const glowR = 90 * pulse;
        const grad = ctx.createRadialGradient(hole.x, hole.y, 4, hole.x, hole.y, glowR);
        grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
        grad.addColorStop(0.35, 'rgba(88, 28, 135, 0.85)');
        grad.addColorStop(0.7, 'rgba(34, 211, 238, 0.3)');
        grad.addColorStop(1, 'rgba(34, 211, 238, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, glowR, 0, Math.PI * 2);
        ctx.fill();
        // dark core
        ctx.beginPath();
        ctx.arc(hole.x, hole.y, 14 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = '#05050a';
        ctx.fill();
        ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // attachments: ropes + link springs
      for (const att of registry.attachments()) {
        if (att.kind === 'rope') drawRope(ctx, att);
        else drawSpring(ctx, att);
      }
      // pending link pick: pulsing outline on A
      {
        const pend = pendingLinkRef.current;
        if (pend && registry.objectOf(pend.body)) {
          const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
          const verts = pend.body.vertices;
          ctx.beginPath();
          ctx.moveTo(verts[0].x, verts[0].y);
          for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
          ctx.closePath();
          ctx.save();
          ctx.shadowColor = 'rgba(34, 211, 238, 0.9)';
          ctx.shadowBlur = 10;
          ctx.strokeStyle = 'rgba(34, 211, 238, ' + (0.4 + 0.5 * pulse).toFixed(3) + ')';
          ctx.lineWidth = 2.5;
          ctx.stroke();
          ctx.restore();
        }
      }
      // selected body outline
      const sel = selectedBodyRef.current;
      if (sel && Matter.Composite.allBodies(engine.world).includes(sel)) {
        const matName = (sel.plugin as Record<string, unknown> | undefined)?.material;
        const color =
          typeof matName === 'string' && matName in MATERIALS
            ? MATERIALS[matName as MaterialName].color
            : '#22d3ee';
        ctx.beginPath();
        const verts = sel.vertices;
        ctx.moveTo(verts[0].x, verts[0].y);
        for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
        ctx.closePath();
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
    };
    Matter.Events.on(render, 'afterRender', onAfterRender);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width < 1 || height < 1) return;
      const rw = Math.round(width);
      const rh = Math.round(height);
      resizeRender(render, rw, rh);
      updateWalls(walls, rw, rh);
      clampBodiesInside(nonStaticBodies(engine), rw, rh);
    });
    resizeObserver.observe(stage);

    Matter.Runner.run(runner, engine);
    Matter.Render.run(render);

    addShowcase(engine, render, w, h, materialRef.current, registry, spawnAsRef.current);
    setObjectCount(registry.size);

    // debug hook for automated verification
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__pw = {
        engine,
        render,
        runner,
        refs: { blackHoleRef, selectedBodyRef, materialRef, burningRef, scaleInsRef },
        mouseConstraint,
        sound,
        fxMsLog,
        fxList: fxListRef,
        registry,
      };
    }

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('mouseup', onWindowMouseUp);
      window.clearTimeout(shakeTimeoutRef.current);
      Matter.Render.stop(render);
      Matter.Runner.stop(runner);
      Matter.Events.off(engine, 'beforeUpdate afterUpdate collisionStart');
      if ((render as { events?: unknown }).events) {
        Matter.Events.off(render, 'beforeRender afterRender');
      }
      if ((mouseConstraint as { events?: unknown }).events) {
        Matter.Events.off(mouseConstraint, 'startdrag enddrag mousedown');
      }
      Matter.Mouse.clearSourceEvents(mouse);
      for (const [domEvent, prop] of MOUSE_EVENTS) {
        render.canvas.removeEventListener(domEvent, mouse[prop]);
      }
      Matter.Composite.remove(engine.world, mouseConstraint);
      Matter.Composite.clear(engine.world, false);
      Matter.Engine.clear(engine);
      render.canvas.remove();
      render.textures = {};
      if ((window as unknown as Record<string, unknown>).__pw) {
        delete (window as unknown as Record<string, unknown>).__pw;
      }
      sound.dispose();
      fxList.length = 0;
      engineRef.current = null;
      runnerRef.current = null;
      renderRef.current = null;
      mouseConstraintRef.current = null;
      soundRef.current = null;
      selectedBodyRef.current = null;
      blackHoleRef.current = null;
      render.canvas.removeEventListener('mousedown', onCanvasMouseDown);
      render.canvas.removeEventListener('touchstart', onCanvasMouseDown);
      window.removeEventListener('keydown', onKeyDown);
      for (const e of burning) e.voice.stop();
      burning.length = 0;
      flames.length = 0;
      rings.length = 0;
      scaleIns.length = 0;
      dustBursts.length = 0;
      shatterQueue.clear();
      registryRef.current = null;
    };
  }, []);

  // --- Spawn requests ---------------------------------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    const registry = registryRef.current;
    if (!engine || !render || !registry) return;

    for (const request of spawnRequests) {
      if (processedIdsRef.current.has(request.id)) continue;
      processedIdsRef.current.add(request.id);
      const generation = clearGenerationRef.current;

      const img = new Image();
      img.onload = () => {
        if (engineRef.current !== engine || clearGenerationRef.current !== generation) return;
        const cw = render.options.width || 800;
        const ch = render.options.height || 600;
        const size = computeBodySize(request, img.naturalWidth, img.naturalHeight, cw, ch);
        const texture = rasterizeTexture(img, size.width, size.height);
        const pos = spawnPosition(cw, ch, size.height);
        if (spawnAsRef.current === 'ragdoll') {
          const rd = createRagdoll({
            x: pos.x,
            y: pos.y,
            w: size.width,
            h: size.height,
            texture,
            pose: request.pose,
            render,
            material: materialRef.current,
          });
          if (rd) {
            addRagdoll(engine, registry, rd);
            spawnFx(rd.root);
            enforceObjectCap(registry, engine.world, render);
            syncSelection();
            updateCount();
            return;
          }
        }
        if (spawnAsRef.current === 'jelly') {
          const jelly = createJelly({
            x: pos.x,
            y: pos.y,
            w: size.width,
            h: size.height,
            texture,
            render,
            material: materialRef.current,
          });
          if (jelly) {
            registry.add(engine.world, {
              id: registry.nextId(),
              kind: 'jelly',
              root: jelly.root,
              bodies: jelly.bodies,
              constraints: jelly.constraints,
              textureKeys: jelly.textureKeys,
              createdAt: engine.timing.timestamp,
            });
            spawnFx(jelly.root);
            enforceObjectCap(registry, engine.world, render);
            syncSelection();
            updateCount();
            return;
          }
        }
        const key = textureKey(request.id);
        registerTexture(render, key, texture);
        const body =
          createHullBody(pos.x, pos.y, size.width, size.height, key, texture) ??
          createImageBody(pos.x, pos.y, size.width, size.height, key, texture);
        applyMaterial(body, materialRef.current);
        Matter.Body.setAngle(body, (Math.random() - 0.5) * 0.6);
        Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.15);
        registry.add(engine.world, {
          id: registry.nextId(),
          kind: 'solid',
          root: body,
          bodies: [body],
          constraints: [],
          textureKeys: [key],
          createdAt: engine.timing.timestamp,
        });
        spawnFx(body);
        enforceObjectCap(registry, engine.world, render);
        syncSelection();
        updateCount();
      };
      img.onerror = () => {
        if (engineRef.current !== engine || clearGenerationRef.current !== generation) return;
        const cw = render.options.width || 800;
        const ch = render.options.height || 600;
        const size = computeBodySize(request, 0, 0, cw, ch);
        const pos = spawnPosition(cw, ch, size.height);
        const body = createPlaceholderBody(pos.x, pos.y, size.width, size.height);
        applyMaterial(body, materialRef.current);
        Matter.Body.setAngle(body, (Math.random() - 0.5) * 0.6);
        registry.add(engine.world, {
          id: registry.nextId(),
          kind: 'solid',
          root: body,
          bodies: [body],
          constraints: [],
          textureKeys: [],
          createdAt: engine.timing.timestamp,
        });
        soundRef.current?.spawn();
        spawnFx(body);
        enforceObjectCap(registry, engine.world, render);
        syncSelection();
        updateCount();
      };
      img.src = request.url;
    }
  }, [spawnRequests, updateCount, syncSelection, spawnFx]);

  // --- Gravity ----------------------------------------------------------------
  useEffect(() => {
    settingsRef.current = { gravityOn, gravityDir, gravityStrength };
    const engine = engineRef.current;
    if (engine) applyGravity(engine, gravityOn, gravityDir, gravityStrength);
  }, [gravityOn, gravityDir, gravityStrength]);

  const setDirection = useCallback((dir: GravityDirection) => {
    setGravityDir(dir);
    setGravityOn(true);
    soundRef.current?.gravityChange(dir);
  }, []);

  const toggleGravity = useCallback(() => {
    const next = !gravityOn;
    setGravityOn(next);
    soundRef.current?.gravityToggle(next);
  }, [gravityOn]);

  const handleSlider = useCallback((v: number) => {
    setGravityStrength(v);
    const t = performance.now();
    if (t - lastTickRef.current >= 80) {
      lastTickRef.current = t;
      soundRef.current?.tick();
    }
  }, []);

  const togglePause = useCallback(() => {
    const runner = runnerRef.current;
    if (!runner) return;
    const next = !paused;
    runner.enabled = !next;
    soundRef.current?.pause(next);
    setPaused(next);
  }, [paused]);

  const toggleSlowMo = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const next = !slowMo;
    engine.timing.timeScale = next ? 0.25 : 1;
    soundRef.current?.slowmo(next);
    setSlowMo(next);
  }, [slowMo]);

  const handleClear = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    if (!engine || !render) return;
    const registry = registryRef.current;
    if (!registry) return;
    clearGenerationRef.current += 1;
    registry.removeAll(engine.world, render);
    for (const b of nonStaticBodies(engine)) {
      releaseBodyTexture(render, b);
      Matter.Composite.remove(engine.world, b);
    }
    for (const e of burningRef.current) e.voice.stop();
    burningRef.current.length = 0;
    flamesRef.current.length = 0;
    blackHoleRef.current = null;
    selectedBodyRef.current = null;
    soundRef.current?.clear();
    updateCount();
  }, [updateCount]);

  const handleReset = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    const runner = runnerRef.current;
    if (!engine || !render) return;
    const registry = registryRef.current;
    if (!registry) return;
    clearGenerationRef.current += 1;
    registry.removeAll(engine.world, render);
    for (const b of nonStaticBodies(engine)) {
      releaseBodyTexture(render, b);
      Matter.Composite.remove(engine.world, b);
    }
    for (const e of burningRef.current) e.voice.stop();
    burningRef.current.length = 0;
    flamesRef.current.length = 0;
    selectedBodyRef.current = null;
    blackHoleRef.current = null;
    soundRef.current?.blackHoleStop();
    soundRef.current?.reset();
    setGravityOn(true);
    setGravityDir('down');
    setGravityStrength(1);
    engine.timing.timeScale = 1;
    setSlowMo(false);
    if (runner) {
      runner.enabled = true;
      setPaused(false);
    }
    addShowcase(
      engine,
      render,
      render.options.width || 800,
      render.options.height || 600,
      materialRef.current,
      registry,
      spawnAsRef.current,
      spawnFx,
    );
    updateCount();
  }, [updateCount, spawnFx]);

  const handleSpawnTest = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    if (!engine || !render) return;
    const registry = registryRef.current;
    if (!registry) return;
    addShowcase(
      engine,
      render,
      render.options.width || 800,
      render.options.height || 600,
      materialRef.current,
      registry,
      spawnAsRef.current,
      spawnFx,
    );
    soundRef.current?.spawnBatch();
    enforceObjectCap(registry, engine.world, render);
    syncSelection();
    updateCount();
  }, [updateCount, syncSelection, spawnFx]);

  const handleExplode = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    if (!engine || !render) return;
    const w = render.options.width || 800;
    const h = render.options.height || 600;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setFxReduced(reduced);
    setBoomRot(Math.random() * 24 - 12);
    const origin = explosionOrigin(nonStaticBodies(engine), w, h, engine.gravity);
    if (explodeShatterRef.current && registryRef.current) {
      const registry = registryRef.current;
      const objs = registry.list();
      const perObj = Math.max(3, Math.min(14, Math.floor(120 / Math.max(1, objs.length))));
      for (const obj of objs) {
        crumbleObject(
          obj,
          {
            x: obj.root.position.x + (Math.random() - 0.5) * 30,
            y: obj.root.position.y + (Math.random() - 0.5) * 30,
          },
          perObj,
          { sound: false, count: false },
        );
      }
      updateCount();
    }
    explode(nonStaticBodies(engine), origin, w, h, engine.gravity);
    soundRef.current?.explosion();
    setFxPos({ x: origin.x, y: origin.y });
    // BOOM floats 60px opposite the gravity vector, clamped inside the stage
    const gl = Math.hypot(engine.gravity.x, engine.gravity.y);
    const bx = origin.x - (gl > 0 ? (engine.gravity.x / gl) * 60 : 0);
    const by = origin.y - (gl > 0 ? (engine.gravity.y / gl) * 60 : 60);
    setBoomPos({
      x: Math.max(70, Math.min(w - 70, bx)),
      y: Math.max(70, Math.min(h - 70, by)),
    });

    const fxList = fxListRef.current;
    fxList.push(createExplosionFx(origin, w, h, reduced));
    if (fxList.length > MAX_EXPLOSION_FX) fxList.splice(0, fxList.length - MAX_EXPLOSION_FX);
    trailUntilRef.current = performance.now() + EXPLOSION_TRAIL_MS;

    setFxKey((k) => k + 1);
    setScorchKey((k) => k + 1);

    const stage = stageRef.current;
    if (stage && !reduced) {
      stage.classList.remove('physics-stage--shake');
      void stage.offsetWidth;
      stage.classList.add('physics-stage--shake');
      window.clearTimeout(shakeTimeoutRef.current);
      shakeTimeoutRef.current = window.setTimeout(() => {
        stage.classList.remove('physics-stage--shake');
      }, 700);
    }

    const btn = explodeBtnRef.current;
    if (btn) {
      btn.classList.remove('physics-btn--punch');
      void btn.offsetWidth;
      btn.classList.add('physics-btn--punch');
    }
  }, [crumbleObject, updateCount]);

  const handleMaterialChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value as MaterialName;
    if (!(name in MATERIALS)) return;
    setMaterial(name);
    materialRef.current = name;
    const sel = selectedBodyRef.current;
    if (sel) {
      const obj = registryRef.current?.objectOf(sel);
      for (const b of obj ? obj.bodies : [sel]) {
        if (!b.isStatic) applyMaterial(b, name);
      }
    }
    soundRef.current?.impact(0.7, name);
  }, []);



  const handleSnapshot = useCallback(() => {
    const render = renderRef.current;
    if (!render) return;
    try {
      const src = render.canvas;
      const pr = render.options.pixelRatio || 1;
      const off = document.createElement('canvas');
      off.width = src.width;
      off.height = src.height;
      const ctx = off.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#0b0d14';
      ctx.fillRect(0, 0, off.width, off.height);
      const step = 40 * pr;
      ctx.strokeStyle = 'rgba(230, 232, 240, 0.045)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = step; x < off.width; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, off.height);
      }
      for (let y = step; y < off.height; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(off.width, y);
      }
      ctx.stroke();
      ctx.drawImage(src, 0, 0);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      off.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `physicslab-snapshot-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      }, 'image/png');
      soundRef.current?.snapshot();
      if (!reduced) setSnapKey((k) => k + 1);
    } catch (err) {
      console.warn('Snapshot failed', err);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    soundRef.current?.setMuted(next);
    if (!next) soundRef.current?.click();
  }, [muted]);

  const gravityLabel = gravityOn
    ? `Gravity ${
        gravityDir === 'down' ? '↓' : gravityDir === 'up' ? '↑' : gravityDir === 'left' ? '←' : '→'
      } ${gravityStrength.toFixed(1)}×`
    : 'Zero-G';

  return (
    <div className="physics" onPointerDownCapture={() => soundRef.current?.unlock()}>
      <div ref={stageRef} className="physics-stage">
        <div className="physics-tools" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`physics-tools__btn${tool === t.id ? ' is-active' : ''}`}
              aria-label={t.label}
              title={t.label}
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              {t.icon}
            </button>
          ))}
        </div>
        {scorchKey > 0 && (
          <div
            key={`scorch-${scorchKey}`}
            className="physics-scorch"
            style={{ left: fxPos.x, top: fxPos.y }}
            onAnimationEnd={() => setScorchKey(0)}
          />
        )}
        <div className="physics-overlay">
          <div className="physics-status">
            <span className="physics-status__title">Physics World</span>
            <span className="physics-status__chip">
              {objectCount} {objectCount === 1 ? 'object' : 'objects'}
            </span>
            <span className="physics-status__chip">{gravityLabel}</span>
            <span className="physics-status__chip">Material: {MATERIALS[material].label}</span>
            {spawnAs !== 'solid' && (
              <span className="physics-status__chip">
                Spawn: {spawnAs === 'jelly' ? 'Jelly' : 'Ragdoll'}
              </span>
            )}
            {paused && <span className="physics-status__chip physics-status__chip--paused">Paused</span>}
            {slowMo && <span className="physics-status__chip physics-status__chip--slowmo">Slow-mo</span>}
          </div>

          <div className="physics-gravity">
            <button
              type="button"
              className={`physics-gravity__toggle${gravityOn ? ' is-on' : ''}`}
              aria-pressed={gravityOn}
              onClick={toggleGravity}
            >
              Gravity {gravityOn ? 'ON' : 'OFF'}
            </button>
            <label className="physics-gravity__slider">
              <span>{gravityStrength.toFixed(1)}×</span>
              <input
                type="range"
                min={0}
                max={GRAVITY_MAX}
                step={0.1}
                value={gravityStrength}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) {
                    handleSlider(Math.max(0, Math.min(GRAVITY_MAX, v)));
                  }
                }}
              />
            </label>
            <div className="physics-gravity__dpad">
              <button
                type="button"
                aria-label="Gravity up"
                aria-pressed={gravityDir === 'up'}
                className={gravityDir === 'up' ? 'is-active' : ''}
                onClick={() => setDirection('up')}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                aria-label="Gravity left"
                aria-pressed={gravityDir === 'left'}
                className={gravityDir === 'left' ? 'is-active' : ''}
                onClick={() => setDirection('left')}
              >
                <ArrowLeft size={14} />
              </button>
              <button
                type="button"
                aria-label="Gravity down"
                aria-pressed={gravityDir === 'down'}
                className={gravityDir === 'down' ? 'is-active' : ''}
                onClick={() => setDirection('down')}
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                aria-label="Gravity right"
                aria-pressed={gravityDir === 'right'}
                className={gravityDir === 'right' ? 'is-active' : ''}
                onClick={() => setDirection('right')}
              >
                <ArrowRight size={14} />
              </button>
            </div>
          </div>
        </div>

        {slowMo && <div className="physics-slowmo" />}
        {objectCount === 0 && (
          <div className="physics-hint">Drag &amp; throw objects • Bring a cutout to life from the studio</div>
        )}

        {fxKey > 0 && (
          <div
            key={`fx-${fxKey}`}
            className="physics-fx"
            style={
              {
                '--fx-x': `${fxPos.x}px`,
                '--fx-y': `${fxPos.y}px`,
                '--boom-x': `${boomPos.x}px`,
                '--boom-y': `${boomPos.y}px`,
              } as React.CSSProperties
            }
            onAnimationEnd={(e) => {
              if (e.animationName === (fxReduced ? 'physics-blast' : 'physics-boom')) setFxKey(0);
            }}
          >
            <div className="physics-fx__blast" />
            {!fxReduced && (
              <div
                className="physics-fx__boom"
                style={{ '--boom-rot': `${boomRot}deg` } as React.CSSProperties}
              >
                BOOM!
              </div>
            )}
          </div>
        )}

        {snapKey > 0 && (
          <div
            key={`snap-${snapKey}`}
            className="physics-snapflash"
            onAnimationEnd={() => setSnapKey(0)}
          />
        )}
      </div>

      <div className="physics-toolbar">
        <button
          type="button"
          className="physics-btn"
          aria-label={paused ? 'Resume' : 'Pause'}
          title={paused ? 'Resume' : 'Pause'}
          onClick={togglePause}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
          <span>{paused ? 'Resume' : 'Pause'}</span>
        </button>
        <button
          type="button"
          className={`physics-btn${slowMo ? ' is-armed' : ''}`}
          aria-label="Slow-mo"
          title="Slow-mo — bullet time at 25% speed"
          aria-pressed={slowMo}
          onClick={toggleSlowMo}
        >
          <Timer size={15} />
          <span>Slow-mo</span>
        </button>
        <button type="button" className="physics-btn" aria-label="Clear" title="Clear" onClick={handleClear}>
          <Trash2 size={15} />
          <span>Clear</span>
        </button>
        <button type="button" className="physics-btn" aria-label="Reset" title="Reset" onClick={handleReset}>
          <RotateCcw size={15} />
          <span>Reset</span>
        </button>
        <button
          type="button"
          className="physics-btn"
          aria-label="Spawn Test Objects"
          title="Spawn Test Objects"
          onClick={handleSpawnTest}
        >
          <Shapes size={15} />
          <span>Spawn Test Objects</span>
        </button>
        <button
          type="button"
          className="physics-btn"
          aria-label="Snapshot"
          title="Snapshot"
          onClick={handleSnapshot}
        >
          <Camera size={15} />
          <span>Snapshot</span>
        </button>
        <div className="physics-spawnas" role="group" aria-label="Spawn as">
          <span className="physics-spawnas__label">Spawn</span>
          {(['solid', 'jelly', 'ragdoll'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`physics-spawnas__btn${spawnAs === k ? ' is-active' : ''}`}
              aria-pressed={spawnAs === k}
              onClick={() => {
                spawnAsRef.current = k;
                setSpawnAs(k);
                soundRef.current?.click();
              }}
            >
              {k === 'solid' ? 'Solid' : k === 'jelly' ? 'Jelly' : 'Ragdoll'}
            </button>
          ))}
        </div>
        <label className="physics-material" title="Material for new objects">
          <span className="physics-material__dot" style={{ background: MATERIALS[material].color }} />
          <span className="physics-material__label">Material</span>
          <select value={material} onChange={handleMaterialChange} aria-label="Material">
            {Object.entries(MATERIALS).map(([name, m]) => (
              <option key={name} value={name}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`physics-btn${fragile ? ' is-armed' : ''}`}
          aria-label="Fragile"
          title="Fragile — hard impacts shatter objects"
          aria-pressed={fragile}
          onClick={() => {
            fragileRef.current = !fragile;
            setFragile(!fragile);
            soundRef.current?.click();
          }}
        >
          <Hammer size={15} />
          <span>Fragile</span>
        </button>
        <button
          type="button"
          className={`physics-btn${explodeShatter ? ' is-armed' : ''}`}
          aria-label="Explode Shatter"
          title="Explode → Shatter — explosions crumble objects first"
          aria-pressed={explodeShatter}
          onClick={() => {
            explodeShatterRef.current = !explodeShatter;
            setExplodeShatter(!explodeShatter);
            soundRef.current?.click();
          }}
        >
          <Bomb size={15} />
          <span>Shatter</span>
        </button>
        <button
          type="button"
          className="physics-btn"
          aria-label={muted ? 'Unmute sound' : 'Mute sound'}
          title={muted ? 'Unmute sound' : 'Mute sound'}
          aria-pressed={muted}
          onClick={toggleMute}
        >
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          <span>{muted ? 'Muted' : 'Sound'}</span>
        </button>
        <button
          type="button"
          ref={explodeBtnRef}
          className="physics-btn physics-btn--explode"
          onClick={handleExplode}
        >
          <Bomb size={17} />
          <span>EXPLODE</span>
        </button>
      </div>
    </div>
  );
}
