// ============================================================================
// Generic particle bursts — lightweight, reusable by crumble dust, impact
// dust, materialize sparkles, flames, frost. Stepped/drawn from the render
// 'afterRender' handler like the explosion FX; real-time dt (ms).
// ============================================================================

export interface FxParticle {
  x: number; y: number; vx: number; vy: number;
  r0: number; r1: number; age: number; life: number; color: string;
}

export interface ParticleBurst {
  particles: FxParticle[];
  /** seconds of gravity applied to particles (0 for weightless dust) */
  gravityScale: number;
  /** velocity drag factor per second (exp decay) */
  drag: number;
  additive: boolean;
  done: boolean;
}

export interface BurstOptions {
  count: number;
  colors: string[];
  speedMin: number;
  speedMax: number;
  /** emit direction bias (radians); NaN = omni */
  dirAngle?: number;
  /** spread around dirAngle (radians, half-width) */
  spread?: number;
  r0?: [number, number];
  r1?: [number, number];
  life?: [number, number];
  gravityScale?: number;
  drag?: number;
  additive?: boolean;
  /** spawn radius jitter (px) */
  spawnRadius?: number;
}

export function createBurst(x: number, y: number, opts: BurstOptions): ParticleBurst {
  const particles: FxParticle[] = [];
  const dir = opts.dirAngle ?? NaN;
  const spread = opts.spread ?? Math.PI;
  for (let i = 0; i < opts.count; i++) {
    const a = Number.isNaN(dir) ? Math.random() * Math.PI * 2 : dir + (Math.random() - 0.5) * 2 * spread;
    const speed = opts.speedMin + Math.random() * (opts.speedMax - opts.speedMin);
    const sr = opts.spawnRadius ?? 0;
    particles.push({
      x: x + (sr ? (Math.random() - 0.5) * 2 * sr : 0),
      y: y + (sr ? (Math.random() - 0.5) * 2 * sr : 0),
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      r0: (opts.r0?.[0] ?? 2) + Math.random() * ((opts.r0?.[1] ?? 2) - (opts.r0?.[0] ?? 2)),
      r1: (opts.r1?.[0] ?? 0) + Math.random() * ((opts.r1?.[1] ?? 0) - (opts.r1?.[0] ?? 0)),
      age: 0,
      life: (opts.life?.[0] ?? 500) + Math.random() * ((opts.life?.[1] ?? 500) - (opts.life?.[0] ?? 500)),
      color: opts.colors[(Math.random() * opts.colors.length) | 0],
    });
  }
  return {
    particles,
    gravityScale: opts.gravityScale ?? 0,
    drag: opts.drag ?? 2.5,
    additive: opts.additive ?? false,
    done: false,
  };
}

/**
 * Advance and draw every live burst; removes finished entries in place.
 * `dtMs` real frame delta (caller clamps), `gravity` the engine gravity vector.
 */
export function stepAndDrawBursts(
  ctx: CanvasRenderingContext2D,
  bursts: ParticleBurst[],
  dtMs: number,
  gravity: { x: number; y: number },
): void {
  const dt = dtMs / 1000;
  for (let bi = bursts.length - 1; bi >= 0; bi--) {
    const b = bursts[bi];
    let alive = 0;
    if (b.additive) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
    }
    const dragF = Math.exp(-dt * b.drag);
    for (const p of b.particles) {
      p.age += dtMs;
      if (p.age > p.life) continue;
      alive += 1;
      p.vx = p.vx * dragF + gravity.x * b.gravityScale * dt * 1000;
      p.vy = p.vy * dragF + gravity.y * b.gravityScale * dt * 1000;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const t = p.age / p.life;
      const r = p.r0 + (p.r1 - p.r0) * t;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.3, r), 0, Math.PI * 2);
      ctx.fill();
    }
    if (b.additive) ctx.restore();
    if (alive === 0) bursts.splice(bi, 1);
  }
  ctx.globalAlpha = 1;
}

/** Crumble dust: greyish puffs at the break point. */
export function createDustBurst(x: number, y: number, tint?: 'ice' | 'ash' | null): ParticleBurst {
  const colors =
    tint === 'ice'
      ? ['rgba(165,220,255,0.55)', 'rgba(200,235,255,0.5)', 'rgba(140,190,240,0.45)']
      : tint === 'ash'
        ? ['rgba(60,50,45,0.5)', 'rgba(90,80,70,0.45)', 'rgba(40,35,32,0.5)']
        : ['rgba(150,140,160,0.45)', 'rgba(120,110,135,0.4)', 'rgba(180,170,195,0.35)'];
  return createBurst(x, y, {
    count: 22,
    colors,
    speedMin: 40,
    speedMax: 260,
    r0: [4, 10],
    r1: [16, 34],
    life: [550, 1100],
    drag: 2.0,
    gravityScale: 0.15,
    spawnRadius: 14,
  });
}

/** Impact dust: tiny puff at a hard contact point. */
export function createImpactDust(x: number, y: number): ParticleBurst {
  return createBurst(x, y, {
    count: 8,
    colors: ['rgba(170,160,180,0.5)', 'rgba(140,130,155,0.45)'],
    speedMin: 30,
    speedMax: 140,
    r0: [2, 5],
    r1: [8, 14],
    life: [300, 600],
    drag: 3.0,
    gravityScale: 0.1,
    spawnRadius: 6,
  });
}

/** Spawn materialize: expanding sparkle ring + glints. */
export function createMaterializeFx(x: number, y: number): ParticleBurst {
  return createBurst(x, y, {
    count: 26,
    colors: ['rgba(139,92,246,0.9)', 'rgba(34,211,238,0.9)', 'rgba(255,255,255,0.9)'],
    speedMin: 120,
    speedMax: 420,
    r0: [1.5, 3],
    r1: [0, 1],
    life: [350, 800],
    drag: 3.5,
    additive: true,
    spawnRadius: 8,
  });
}

export type { ParticleBurst as Burst };

// ============================================================================
// Glow rings — expanding stroke rings (spawn materialize)
// ============================================================================

export interface RingFx {
  x: number; y: number; r0: number; r1: number;
  age: number; life: number; color: string; width: number;
}

export function createGlowRing(
  x: number,
  y: number,
  color = 'rgba(34,211,238,0.9)',
  r1 = 90,
): RingFx {
  return { x, y, r0: 4, r1, age: 0, life: 420, color, width: 3 };
}

/** Advance and draw live rings; removes finished entries in place. */
export function stepAndDrawRings(
  ctx: CanvasRenderingContext2D,
  rings: RingFx[],
  dtMs: number,
): void {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.age += dtMs;
    if (r.age > r.life) {
      rings.splice(i, 1);
      continue;
    }
    const t = r.age / r.life;
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = r.width * (1 - t) + 0.5;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * e, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
