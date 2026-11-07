import { useCallback, useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bomb,
  Camera,
  Hammer,
  Hand,
  Orbit,
  Pause,
  Play,
  RotateCcw,
  Shapes,
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
  MAX_SHARDS,
  shatterBody,
  shardExpired,
  tagShard,
} from '../lib/physics/fracture';
import {
  createDustBurst,
  stepAndDrawBursts,
  type ParticleBurst,
} from '../lib/physics/fx';
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

type ToolName = 'grab' | 'crumble' | 'blackhole';

const TOOLS: Array<{ id: ToolName; label: string; icon: React.ReactNode }> = [
  { id: 'grab', label: 'Grab', icon: <Hand size={16} /> },
  { id: 'crumble', label: 'Crumble', icon: <Hammer size={16} /> },
  { id: 'blackhole', label: 'Black Hole', icon: <Orbit size={16} /> },
];

function addShowcase(
  engine: Matter.Engine,
  render: Matter.Render,
  w: number,
  h: number,
  material: MaterialName,
  registry: ObjectRegistry,
): void {
  for (const item of createTestObjects(w, h)) {
    if (item.texture) registerTexture(render, item.texture.key, item.texture.canvas);
    applyMaterial(item.body, material);
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
  const fragileRef = useRef(false);
  const explodeShatterRef = useRef(false);
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
      opts?: { sound?: boolean; dust?: boolean; count?: boolean },
    ) => {
      const engine = engineRef.current;
      const render = renderRef.current;
      const registry = registryRef.current;
      if (!engine || !render || !registry || obj.kind !== 'solid') return;
      const shards = shatterBody(obj.root, {
        world: engine.world,
        render,
        impact,
        shardCount,
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
      if (opts?.dust !== false) dustBurstsRef.current.push(createDustBurst(impact.x, impact.y));
      if (opts?.sound !== false) soundRef.current?.crack(0.8);
      if (selectedBodyRef.current && obj.bodies.includes(selectedBodyRef.current)) {
        selectedBodyRef.current = null;
      }
      if (opts?.count !== false) updateCount();
    },
    [updateCount],
  );

  // effect-stable access without making the mount effect depend on callbacks
  const actionsRef = useRef({ shatterObject, setTool });
  useEffect(() => {
    actionsRef.current = { shatterObject, setTool };
  });

  // --- Engine lifecycle (runs once per mount; StrictMode-safe) ---------------
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const w = stage.clientWidth || 800;
    const h = stage.clientHeight || 600;

    const engine = createEngine();
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
            actionsRef.current.shatterObject(obj, {
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
        const hit = Matter.Query.point(nonStaticBodies(engine), pos).find(
          (b) => !(b.plugin as Record<string, unknown> | undefined)?.shard,
        );
        if (hit) {
          const obj = registry.objectOf(hit);
          if (obj && obj.kind === 'solid') actionsRef.current.shatterObject(obj, pos);
        }
        return;
      }
      // grab tool: deselect on empty-canvas click
      if (Matter.Query.point(nonStaticBodies(engine), pos).length === 0) {
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
      const fxT0 = performance.now();
      if (dustBursts.length > 0) {
        stepAndDrawBursts(ctx, dustBursts, dtMs, engine.gravity);
      }
      const trailLeft = trailUntilRef.current - frameT;
      if (trailLeft > 0) {
        drawBodyTrails(ctx, nonStaticBodies(engine), Math.min(1, trailLeft / EXPLOSION_TRAIL_MS));
      }
      if (fxList.length > 0) {
        stepAndDrawFx(ctx, fxList, dtMs, engine.gravity);
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

    addShowcase(engine, render, w, h, materialRef.current, registry);
    setObjectCount(registry.size);

    // debug hook for automated verification
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__pw = {
        engine,
        render,
        runner,
        refs: { blackHoleRef, selectedBodyRef, materialRef },
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
        const key = textureKey(request.id);
        registerTexture(render, key, texture);
        const pos = spawnPosition(cw, ch, size.height);
        const body = createImageBody(pos.x, pos.y, size.width, size.height, key, texture);
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
        soundRef.current?.spawn();
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
        enforceObjectCap(registry, engine.world, render);
        syncSelection();
        updateCount();
      };
      img.src = request.url;
    }
  }, [spawnRequests, updateCount, syncSelection]);

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
    selectedBodyRef.current = null;
    blackHoleRef.current = null;
    soundRef.current?.blackHoleStop();
    soundRef.current?.reset();
    setGravityOn(true);
    setGravityDir('down');
    setGravityStrength(1);
    if (runner) {
      runner.enabled = true;
      setPaused(false);
    }
    addShowcase(engine, render, render.options.width || 800, render.options.height || 600, materialRef.current, registry);
    updateCount();
  }, [updateCount]);

  const handleSpawnTest = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    if (!engine || !render) return;
    const registry = registryRef.current;
    if (!registry) return;
    addShowcase(engine, render, render.options.width || 800, render.options.height || 600, materialRef.current, registry);
    soundRef.current?.spawnBatch();
    enforceObjectCap(registry, engine.world, render);
    syncSelection();
    updateCount();
  }, [updateCount, syncSelection]);

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
      const solids = registry.list().filter((o) => o.kind === 'solid');
      const perObj = Math.max(3, Math.min(14, Math.floor(120 / Math.max(1, solids.length))));
      for (const obj of solids) {
        shatterObject(
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
  }, [shatterObject, updateCount]);

  const handleMaterialChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value as MaterialName;
    if (!(name in MATERIALS)) return;
    setMaterial(name);
    materialRef.current = name;
    const sel = selectedBodyRef.current;
    if (sel) applyMaterial(sel, name);
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
            {paused && <span className="physics-status__chip physics-status__chip--paused">Paused</span>}
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
