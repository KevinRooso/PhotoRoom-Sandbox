import { useCallback, useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bomb,
  Pause,
  Play,
  RotateCcw,
  Shapes,
  Trash2,
} from 'lucide-react';
import type { CutoutAsset } from '../types/asset';
import {
  applyGravity,
  clampBodiesInside,
  clearBodies,
  computeBodySize,
  createEngine,
  createImageBody,
  createPlaceholderBody,
  createTestObjects,
  createWalls,
  enforceBodyCap,
  explode,
  GRAVITY_MAX,
  limitVelocity,
  MAX_SPEED,
  nonStaticBodies,
  rasterizeTexture,
  registerTexture,
  resizeRender,
  spawnPosition,
  textureKey,
  updateWalls,
  type GravityDirection,
} from '../lib/physics';
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

function addShowcase(engine: Matter.Engine, render: Matter.Render, w: number, h: number): void {
  for (const item of createTestObjects(w, h)) {
    if (item.texture) registerTexture(render, item.texture.key, item.texture.canvas);
    Matter.Composite.add(engine.world, item.body);
  }
}

export default function PhysicsWorld({ spawnRequests }: PhysicsWorldProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Matter.Engine | null>(null);
  const runnerRef = useRef<Matter.Runner | null>(null);
  const renderRef = useRef<Matter.Render | null>(null);
  const mouseRef = useRef<Matter.Mouse | null>(null);
  const mouseConstraintRef = useRef<Matter.MouseConstraint | null>(null);
  const wallsRef = useRef<Matter.Body[]>([]);
  const processedIdsRef = useRef<Set<string>>(new Set());
  const clearGenerationRef = useRef(0);
  const shakeTimeoutRef = useRef<number | undefined>(undefined);
  const settingsRef = useRef({ gravityOn: true, gravityDir: 'down' as GravityDirection, gravityStrength: 1 });

  const [objectCount, setObjectCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [gravityOn, setGravityOn] = useState(true);
  const [gravityDir, setGravityDir] = useState<GravityDirection>('down');
  const [gravityStrength, setGravityStrength] = useState(1);
  const [fxKey, setFxKey] = useState(0);

  const updateCount = useCallback(() => {
    const engine = engineRef.current;
    if (engine) setObjectCount(nonStaticBodies(engine).length);
  }, []);

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

    engineRef.current = engine;
    runnerRef.current = runner;
    renderRef.current = render;
    mouseRef.current = mouse;
    mouseConstraintRef.current = mouseConstraint;
    wallsRef.current = walls;
    processedIdsRef.current = new Set();

    const { gravityOn: gOn, gravityDir: gDir, gravityStrength: gStr } = settingsRef.current;
    applyGravity(engine, gOn, gDir, gStr);

    const onWindowMouseUp = () => {
      mouse.button = -1;
    };
    window.addEventListener('mouseup', onWindowMouseUp);

    const onBeforeUpdate = () => limitVelocity(nonStaticBodies(engine), MAX_SPEED);
    const onAfterUpdate = () => {
      const canvas = render.canvas;
      if (mouseConstraint.body) {
        canvas.style.cursor = 'grabbing';
      } else if (Matter.Query.point(nonStaticBodies(engine), mouse.position).length > 0) {
        canvas.style.cursor = 'grab';
      } else {
        canvas.style.cursor = '';
      }
    };
    Matter.Events.on(engine, 'beforeUpdate', onBeforeUpdate);
    Matter.Events.on(engine, 'afterUpdate', onAfterUpdate);

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

    addShowcase(engine, render, w, h);
    setObjectCount(nonStaticBodies(engine).length);

    // debug hook for automated verification
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__pw = { engine, render, runner };

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('mouseup', onWindowMouseUp);
      window.clearTimeout(shakeTimeoutRef.current);
      Matter.Render.stop(render);
      Matter.Runner.stop(runner);
      Matter.Events.off(engine, 'beforeUpdate afterUpdate');
      if ((render as { events?: unknown }).events) {
        Matter.Events.off(render, 'beforeRender afterRender');
      }
      if ((mouseConstraint as { events?: unknown }).events) {
        Matter.Events.off(mouseConstraint, 'startdrag enddrag');
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
      engineRef.current = null;
      runnerRef.current = null;
      renderRef.current = null;
      mouseRef.current = null;
      mouseConstraintRef.current = null;
      wallsRef.current = [];
    };
  }, []);

  // --- Spawn requests ---------------------------------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    if (!engine || !render) return;

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
        const texture = rasterizeTexture(img, Math.max(size.width, size.height));
        const key = textureKey(request.id);
        registerTexture(render, key, texture);
        const pos = spawnPosition(cw, ch, size.height);
        const body = createImageBody(pos.x, pos.y, size.width, size.height, key, texture);
        Matter.Body.setAngle(body, (Math.random() - 0.5) * 0.6);
        Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.15);
        Matter.Composite.add(engine.world, body);
        enforceBodyCap(engine, render);
        updateCount();
      };
      img.onerror = () => {
        if (engineRef.current !== engine || clearGenerationRef.current !== generation) return;
        const cw = render.options.width || 800;
        const ch = render.options.height || 600;
        const size = computeBodySize(request, 0, 0, cw, ch);
        const pos = spawnPosition(cw, ch, size.height);
        const body = createPlaceholderBody(pos.x, pos.y, size.width, size.height);
        Matter.Body.setAngle(body, (Math.random() - 0.5) * 0.6);
        Matter.Composite.add(engine.world, body);
        enforceBodyCap(engine, render);
        updateCount();
      };
      img.src = request.url;
    }
  }, [spawnRequests, updateCount]);

  // --- Gravity ----------------------------------------------------------------
  useEffect(() => {
    settingsRef.current = { gravityOn, gravityDir, gravityStrength };
    const engine = engineRef.current;
    if (engine) applyGravity(engine, gravityOn, gravityDir, gravityStrength);
  }, [gravityOn, gravityDir, gravityStrength]);

  const togglePause = useCallback(() => {
    const runner = runnerRef.current;
    if (!runner) return;
    const next = !paused;
    runner.enabled = !next;
    setPaused(next);
  }, [paused]);

  const handleClear = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    if (!engine || !render) return;
    clearGenerationRef.current += 1;
    clearBodies(engine, render);
    updateCount();
  }, [updateCount]);

  const handleReset = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    const runner = runnerRef.current;
    if (!engine || !render) return;
    clearGenerationRef.current += 1;
    clearBodies(engine, render);
    setGravityOn(true);
    setGravityDir('down');
    setGravityStrength(1);
    if (runner) {
      runner.enabled = true;
      setPaused(false);
    }
    addShowcase(engine, render, render.options.width || 800, render.options.height || 600);
    updateCount();
  }, [updateCount]);

  const handleSpawnTest = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    if (!engine || !render) return;
    addShowcase(engine, render, render.options.width || 800, render.options.height || 600);
    enforceBodyCap(engine, render);
    updateCount();
  }, [updateCount]);

  const handleExplode = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    if (!engine || !render) return;
    const w = render.options.width || 800;
    const h = render.options.height || 600;
    explode(nonStaticBodies(engine), { x: w / 2, y: h / 2 }, w, h);
    setFxKey((k) => k + 1);

    const stage = stageRef.current;
    if (stage) {
      stage.classList.remove('physics-stage--shake');
      void stage.offsetWidth;
      stage.classList.add('physics-stage--shake');
      window.clearTimeout(shakeTimeoutRef.current);
      shakeTimeoutRef.current = window.setTimeout(() => {
        stage.classList.remove('physics-stage--shake');
      }, 450);
    }
  }, []);

  const gravityLabel = gravityOn
    ? `Gravity ${
        gravityDir === 'down' ? '↓' : gravityDir === 'up' ? '↑' : gravityDir === 'left' ? '←' : '→'
      } ${gravityStrength.toFixed(1)}×`
    : 'Zero-G';

  return (
    <div className="physics">
      <div ref={stageRef} className="physics-stage">
        <div className="physics-status">
          <span className="physics-status__title">Physics World</span>
          <span className="physics-status__chip">{objectCount} objects</span>
          <span className="physics-status__chip">{gravityLabel}</span>
          {paused && <span className="physics-status__chip physics-status__chip--paused">Paused</span>}
        </div>

        <div className="physics-gravity">
          <button
            type="button"
            className={`physics-gravity__toggle${gravityOn ? ' is-on' : ''}`}
            onClick={() => setGravityOn((v) => !v)}
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
                  setGravityStrength(Math.max(0, Math.min(GRAVITY_MAX, v)));
                }
              }}
            />
          </label>
          <div className="physics-gravity__dpad">
            <button
              type="button"
              aria-label="Gravity up"
              className={gravityDir === 'up' ? 'is-active' : ''}
              onClick={() => setGravityDir('up')}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              aria-label="Gravity left"
              className={gravityDir === 'left' ? 'is-active' : ''}
              onClick={() => setGravityDir('left')}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              aria-label="Gravity down"
              className={gravityDir === 'down' ? 'is-active' : ''}
              onClick={() => setGravityDir('down')}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              aria-label="Gravity right"
              className={gravityDir === 'right' ? 'is-active' : ''}
              onClick={() => setGravityDir('right')}
            >
              <ArrowRight size={14} />
            </button>
          </div>
        </div>

        {objectCount === 0 && (
          <div className="physics-hint">Drag &amp; throw objects • Bring a cutout to life from the studio</div>
        )}

        {fxKey > 0 && (
          <div key={fxKey} className="physics-fx" onAnimationEnd={() => setFxKey(0)}>
            <div className="physics-fx__ring" />
            <div className="physics-fx__flash" />
          </div>
        )}
      </div>

      <div className="physics-toolbar">
        <button type="button" className="physics-btn" onClick={togglePause}>
          {paused ? <Play size={15} /> : <Pause size={15} />}
          <span>{paused ? 'Resume' : 'Pause'}</span>
        </button>
        <button type="button" className="physics-btn" onClick={handleClear}>
          <Trash2 size={15} />
          <span>Clear</span>
        </button>
        <button type="button" className="physics-btn" onClick={handleReset}>
          <RotateCcw size={15} />
          <span>Reset</span>
        </button>
        <button type="button" className="physics-btn" onClick={handleSpawnTest}>
          <Shapes size={15} />
          <span>Spawn Test Objects</span>
        </button>
        <button type="button" className="physics-btn physics-btn--explode" onClick={handleExplode}>
          <Bomb size={17} />
          <span>EXPLODE</span>
        </button>
      </div>
    </div>
  );
}
