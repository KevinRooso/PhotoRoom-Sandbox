import { useCallback, useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bomb,
  Camera,
  Orbit,
  Pause,
  Play,
  RotateCcw,
  Shapes,
  Trash2,
} from 'lucide-react';
import type { CutoutAsset } from '../types/asset';
import {
  applyBlackHole,
  applyGravity,
  applyMaterial,
  BLACK_HOLE_LIFETIME,
  blackHoleRadius,
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
  MATERIALS,
  MAX_SPEED,
  nonStaticBodies,
  rasterizeTexture,
  registerTexture,
  resizeRender,
  spawnPosition,
  textureKey,
  updateWalls,
  type BlackHole,
  type GravityDirection,
  type MaterialName,
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

function addShowcase(
  engine: Matter.Engine,
  render: Matter.Render,
  w: number,
  h: number,
  material: MaterialName,
): void {
  for (const item of createTestObjects(w, h)) {
    if (item.texture) registerTexture(render, item.texture.key, item.texture.canvas);
    applyMaterial(item.body, material);
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
  const materialRef = useRef<MaterialName>('normal');
  const selectedBodyRef = useRef<Matter.Body | null>(null);
  const blackHoleRef = useRef<BlackHole | null>(null);
  const blackHoleArmedRef = useRef(false);
  const savedMaskRef = useRef<number | undefined>(undefined);

  const [objectCount, setObjectCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [gravityOn, setGravityOn] = useState(true);
  const [gravityDir, setGravityDir] = useState<GravityDirection>('down');
  const [gravityStrength, setGravityStrength] = useState(1);
  const [material, setMaterial] = useState<MaterialName>('normal');
  const [blackHoleArmed, setBlackHoleArmed] = useState(false);
  const [fxKey, setFxKey] = useState(0);
  const [snapKey, setSnapKey] = useState(0);

  const updateCount = useCallback(() => {
    const engine = engineRef.current;
    if (engine) setObjectCount(nonStaticBodies(engine).length);
  }, []);

  /** Clear the selection if its body is no longer in the world. */
  const syncSelection = useCallback(() => {
    const engine = engineRef.current;
    const sel = selectedBodyRef.current;
    if (engine && sel && !Matter.Composite.allBodies(engine.world).includes(sel)) {
      selectedBodyRef.current = null;
    }
  }, []);

  const disarmBlackHole = useCallback(() => {
    blackHoleArmedRef.current = false;
    setBlackHoleArmed(false);
    const mc = mouseConstraintRef.current;
    if (mc && savedMaskRef.current !== undefined) {
      mc.collisionFilter.mask = savedMaskRef.current;
      savedMaskRef.current = undefined;
    }
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

    const onBeforeUpdate = () => {
      const bodies = nonStaticBodies(engine);
      const hole = blackHoleRef.current;
      if (hole) {
        if (engine.timing.timestamp - hole.bornAt > BLACK_HOLE_LIFETIME) {
          blackHoleRef.current = null;
        } else {
          const cw = render.options.width || 800;
          const ch = render.options.height || 600;
          applyBlackHole(bodies, hole, blackHoleRadius(cw, ch));
        }
      }
      limitVelocity(bodies, MAX_SPEED);
    };

    let lastCursor = '';
    const setCursor = (c: string) => {
      if (c !== lastCursor) {
        lastCursor = c;
        render.canvas.style.cursor = c;
      }
    };
    const onAfterUpdate = () => {
      if (blackHoleArmedRef.current) {
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

    const onStartDrag = (e: Matter.IEvent<Matter.MouseConstraint> & { body?: Matter.Body }) => {
      if (e.body) selectedBodyRef.current = e.body;
    };
    const onMouseDown = () => {
      if (blackHoleArmedRef.current) {
        blackHoleRef.current = {
          x: mouse.position.x,
          y: mouse.position.y,
          bornAt: engine.timing.timestamp,
        };
        blackHoleArmedRef.current = false;
        setBlackHoleArmed(false);
        if (savedMaskRef.current !== undefined) {
          mouseConstraint.collisionFilter.mask = savedMaskRef.current;
          savedMaskRef.current = undefined;
        }
      } else if (Matter.Query.point(nonStaticBodies(engine), mouse.position).length === 0) {
        selectedBodyRef.current = null;
      }
    };
    Matter.Events.on(mouseConstraint, 'startdrag', onStartDrag);
    Matter.Events.on(mouseConstraint, 'mousedown', onMouseDown);

    const onAfterRender = () => {
      const ctx = render.context;
      const pr = render.options.pixelRatio || 1;
      ctx.save();
      ctx.setTransform(pr, 0, 0, pr, 0, 0);

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

    addShowcase(engine, render, w, h, materialRef.current);
    setObjectCount(nonStaticBodies(engine).length);

    // debug hook for automated verification
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__pw = {
        engine,
        render,
        runner,
        refs: { blackHoleRef, selectedBodyRef, materialRef },
        mouseConstraint,
      };
    }

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
      engineRef.current = null;
      runnerRef.current = null;
      renderRef.current = null;
      mouseRef.current = null;
      mouseConstraintRef.current = null;
      wallsRef.current = [];
      selectedBodyRef.current = null;
      blackHoleRef.current = null;
      blackHoleArmedRef.current = false;
      savedMaskRef.current = undefined;
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
        const texture = rasterizeTexture(img, size.width, size.height);
        const key = textureKey(request.id);
        registerTexture(render, key, texture);
        const pos = spawnPosition(cw, ch, size.height);
        const body = createImageBody(pos.x, pos.y, size.width, size.height, key, texture);
        applyMaterial(body, materialRef.current);
        Matter.Body.setAngle(body, (Math.random() - 0.5) * 0.6);
        Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.15);
        Matter.Composite.add(engine.world, body);
        enforceBodyCap(engine, render);
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
        Matter.Composite.add(engine.world, body);
        enforceBodyCap(engine, render);
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
  }, []);

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
    selectedBodyRef.current = null;
    updateCount();
  }, [updateCount]);

  const handleReset = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    const runner = runnerRef.current;
    if (!engine || !render) return;
    clearGenerationRef.current += 1;
    clearBodies(engine, render);
    selectedBodyRef.current = null;
    blackHoleRef.current = null;
    disarmBlackHole();
    setGravityOn(true);
    setGravityDir('down');
    setGravityStrength(1);
    if (runner) {
      runner.enabled = true;
      setPaused(false);
    }
    addShowcase(engine, render, render.options.width || 800, render.options.height || 600, materialRef.current);
    updateCount();
  }, [updateCount, disarmBlackHole]);

  const handleSpawnTest = useCallback(() => {
    const engine = engineRef.current;
    const render = renderRef.current;
    if (!engine || !render) return;
    addShowcase(engine, render, render.options.width || 800, render.options.height || 600, materialRef.current);
    enforceBodyCap(engine, render);
    syncSelection();
    updateCount();
  }, [updateCount, syncSelection]);

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

  const handleMaterialChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const name = e.target.value as MaterialName;
    if (!(name in MATERIALS)) return;
    setMaterial(name);
    materialRef.current = name;
    const sel = selectedBodyRef.current;
    if (sel) applyMaterial(sel, name);
  }, []);

  const toggleBlackHoleArm = useCallback(() => {
    if (blackHoleArmedRef.current) {
      disarmBlackHole();
      return;
    }
    const mc = mouseConstraintRef.current;
    if (!mc) return;
    savedMaskRef.current = mc.collisionFilter.mask;
    mc.collisionFilter.mask = 0;
    blackHoleArmedRef.current = true;
    setBlackHoleArmed(true);
  }, [disarmBlackHole]);

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
      off.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `physicslab-snapshot-${Date.now()}.png`;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      }, 'image/png');
      setSnapKey((k) => k + 1);
    } catch (err) {
      console.warn('Snapshot failed', err);
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
            key={fxKey}
            className="physics-fx"
            onAnimationEnd={(e) => {
              if (e.animationName === 'physics-shockwave') setFxKey(0);
            }}
          >
            <div className="physics-fx__ring" />
            <div className="physics-fx__flash" />
          </div>
        )}

        {snapKey > 0 && (
          <div key={snapKey} className="physics-snapflash" onAnimationEnd={() => setSnapKey(0)} />
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
          className={`physics-btn${blackHoleArmed ? ' is-armed' : ''}`}
          aria-label="Black Hole"
          title="Black Hole — click the canvas to place"
          aria-pressed={blackHoleArmed}
          onClick={toggleBlackHoleArm}
        >
          <Orbit size={15} />
          <span>Black Hole</span>
        </button>
        <button type="button" className="physics-btn physics-btn--explode" onClick={handleExplode}>
          <Bomb size={17} />
          <span>EXPLODE</span>
        </button>
      </div>
    </div>
  );
}
