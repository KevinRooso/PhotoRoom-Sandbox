import Matter from 'matter-js';
import type { Attachment } from './objects';

// ============================================================================
// Ropes (Hang tool) and springs (Link tool). Bodies/constraints live on the
// attachment; all constraint rendering is disabled — we draw them ourselves.
// ============================================================================

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Rope from a fixed world anchor to `attach` on `body`. */
export function createRope(
  anchor: { x: number; y: number },
  attach: { x: number; y: number },
  body: Matter.Body,
): { bodies: Matter.Body[]; constraints: Matter.Constraint[] } {
  const dist = Math.hypot(attach.x - anchor.x, attach.y - anchor.y);
  const n = clamp(Math.round(dist / 28), 8, 12);
  const seg = dist / n;
  const bodies: Matter.Body[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n;
    bodies.push(
      Matter.Bodies.circle(anchor.x + (attach.x - anchor.x) * t, anchor.y + (attach.y - anchor.y) * t, 4, {
        density: 0.0002,
        frictionAir: 0.02,
        collisionFilter: { mask: 0 },
        render: { visible: false },
      }),
    );
  }
  const constraints: Matter.Constraint[] = [
    Matter.Constraint.create({
      pointA: { x: anchor.x, y: anchor.y },
      bodyB: bodies[0],
      pointB: { x: 0, y: 0 },
      length: 0,
      stiffness: 0.9,
      damping: 0.1,
      render: { visible: false },
    }),
  ];
  for (let i = 1; i < n; i++) {
    constraints.push(
      Matter.Constraint.create({
        bodyA: bodies[i - 1],
        bodyB: bodies[i],
        length: seg,
        stiffness: 0.9,
        damping: 0.1,
        render: { visible: false },
      }),
    );
  }
  // last link → the body at the click offset (rotates with the body)
  constraints.push(
    Matter.Constraint.create({
      bodyA: bodies[n - 1],
      bodyB: body,
      pointB: { x: attach.x - body.position.x, y: attach.y - body.position.y },
      length: seg,
      stiffness: 0.9,
      damping: 0.1,
      render: { visible: false },
    }),
  );
  return { bodies, constraints };
}

/** Zig-zag spring constraint between two bodies at world click points. */
export function createSpringLink(
  bodyA: Matter.Body,
  bodyB: Matter.Body,
  pointA: { x: number; y: number },
  pointB: { x: number; y: number },
): Matter.Constraint {
  const aw = worldPoint(bodyA, pointA);
  const bw = worldPoint(bodyB, pointB);
  return Matter.Constraint.create({
    bodyA,
    bodyB,
    pointA,
    pointB,
    length: Math.hypot(bw.x - aw.x, bw.y - aw.y),
    stiffness: 0.03,
    damping: 0.05,
    render: { visible: false },
  });
}

/**
 * World position of a constraint point. Matter keeps pointA/pointB as
 * world-frame offsets and rotates them in place as the body turns, so the
 * world point is simply position + offset (rotating again would double it).
 */
export function worldPoint(body: Matter.Body, p: { x: number; y: number }): { x: number; y: number } {
  return { x: body.position.x + p.x, y: body.position.y + p.y };
}

/** Smooth rope curve through anchor → links → attach point, plus anchor plate. */
export function drawRope(ctx: CanvasRenderingContext2D, att: Attachment): void {
  if (!att.anchor || att.bodies.length === 0) return;
  const last = att.constraints[att.constraints.length - 1];
  const end = last?.bodyB && last.pointB ? worldPoint(last.bodyB, last.pointB) : att.bodies[att.bodies.length - 1].position;
  const pts = [att.anchor, ...att.bodies.map((b) => b.position), end];

  // anchor plate
  ctx.fillStyle = '#3a4157';
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(att.anchor.x, att.anchor.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  ctx.lineTo(end.x, end.y);
  ctx.strokeStyle = 'rgba(20, 24, 38, 0.9)';
  ctx.lineWidth = 4.5;
  ctx.stroke();
  ctx.strokeStyle = '#8a90a6';
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

/** Zig-zag spring between the two attach points (~10 coils, fixed count). */
export function drawSpring(ctx: CanvasRenderingContext2D, att: Attachment): void {
  const c = att.constraints[0];
  if (!c?.bodyA || !c.bodyB || !c.pointA || !c.pointB) return;
  const a = worldPoint(c.bodyA, c.pointA);
  const b = worldPoint(c.bodyB, c.pointB);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 2) return;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const coils = 10;
  const amp = 6;
  const lead = Math.min(8, len * 0.15);

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(a.x + ux * lead, a.y + uy * lead);
  const span = len - 2 * lead;
  for (let i = 1; i < coils; i++) {
    const t = i / coils;
    const off = (i % 2 === 0 ? 1 : -1) * amp;
    ctx.lineTo(a.x + ux * (lead + span * t) + px * off, a.y + uy * (lead + span * t) + py * off);
  }
  ctx.lineTo(b.x - ux * lead, b.y - uy * lead);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = 'rgba(20, 24, 38, 0.85)';
  ctx.lineWidth = 3.5;
  ctx.stroke();
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1.8;
  ctx.stroke();
}
