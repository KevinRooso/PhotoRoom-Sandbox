import Matter from 'matter-js';
import { applyMaterial, registerTexture, type MaterialName } from '../physics';
import { POSE, type PoseKeypoint } from '../../types/asset';

// ============================================================================
// Ragdoll — 10 parts (head, torso, 2×upper/lower arms, 2×upper/lower legs)
// pinned at 9 joints, built from pose keypoints or a standing template.
// ============================================================================

export interface RagdollJoint {
  a: Matter.Body;
  b: Matter.Body;
  rest: number;
  min: number;
  max: number;
}

type V = { x: number; y: number };

// template keypoints in normalized rect coords (u,v)
const TEMPLATE: Record<string, [number, number]> = {
  NOSE: [0.5, 0.08],
  L_SHOULDER: [0.68, 0.22],
  R_SHOULDER: [0.32, 0.22],
  L_ELBOW: [0.8, 0.38],
  R_ELBOW: [0.2, 0.38],
  L_WRIST: [0.85, 0.52],
  R_WRIST: [0.15, 0.52],
  L_HIP: [0.6, 0.55],
  R_HIP: [0.4, 0.55],
  L_KNEE: [0.62, 0.75],
  R_KNEE: [0.38, 0.75],
  L_ANKLE: [0.63, 0.95],
  R_ANKLE: [0.37, 0.95],
};

const KEYS = Object.keys(TEMPLATE);

const mid = (a: V, b: V): V => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: V, b: V): number => Math.hypot(b.x - a.x, b.y - a.y);

/** distance from p to segment ab */
function segDist(p: V, a: V, b: V): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** bone-aligned rectangle polygon (local coords, centred near the segment) */
function bonePoly(a: V, b: V, thickness: number, pad = 4): V[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const px = -uy;
  const py = ux;
  const h = thickness / 2;
  return [
    { x: a.x - ux * pad + px * h, y: a.y - uy * pad + py * h },
    { x: b.x + ux * pad + px * h, y: b.y + uy * pad + py * h },
    { x: b.x + ux * pad - px * h, y: b.y + uy * pad - py * h },
    { x: a.x - ux * pad - px * h, y: a.y - uy * pad - py * h },
  ];
}

function circlePoly(c: V, r: number, n = 10): V[] {
  const out: V[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return out;
}

let ragTexSeq = 0;

export function createRagdoll(opts: {
  x: number;
  y: number;
  w: number;
  h: number;
  texture: HTMLCanvasElement;
  pose?: PoseKeypoint[];
  render: Matter.Render;
  material: MaterialName;
}): {
  bodies: Matter.Body[];
  constraints: Matter.Constraint[];
  textureKeys: string[];
  root: Matter.Body;
  joints: RagdollJoint[];
} | null {
  const { x, y, w, h, texture, render, material } = opts;

  // 1. keypoints in local px (rect centred at 0)
  const pt: Record<string, V> = {};
  for (const k of KEYS) {
    const idx = POSE[k as keyof typeof POSE];
    const kp = opts.pose?.[idx];
    if (kp && kp.visibility >= 0.3) {
      pt[k] = { x: kp.x * w - w / 2, y: kp.y * h - h / 2 };
    } else {
      pt[k] = { x: TEMPLATE[k][0] * w - w / 2, y: TEMPLATE[k][1] * h - h / 2 };
    }
  }

  const neck = mid(pt.L_SHOULDER, pt.R_SHOULDER);
  const midShoulder = neck;
  const midHip = mid(pt.L_HIP, pt.R_HIP);
  const shoulderW = dist(pt.L_SHOULDER, pt.R_SHOULDER);
  const limbT = Math.max(8, 0.13 * w);

  // 2. part definitions: polygons + assignment segments in local coords
  const noseDir = dist(pt.NOSE, neck) || 1;
  const headC = {
    x: pt.NOSE.x + ((pt.NOSE.x - neck.x) / noseDir) * noseDir * 0.3,
    y: pt.NOSE.y + ((pt.NOSE.y - neck.y) / noseDir) * noseDir * 0.3,
  };
  const headR = Math.max(6, 0.55 * noseDir);
  interface Part {
    name: string;
    poly: V[];
    seg: [V, V]; // assignment segment
  }
  const parts: Part[] = [
    { name: 'head', poly: circlePoly(headC, headR), seg: [neck, headC] },
    { name: 'torso', poly: bonePoly(midShoulder, midHip, shoulderW), seg: [midShoulder, midHip] },
    { name: 'uarmL', poly: bonePoly(pt.L_SHOULDER, pt.L_ELBOW, limbT), seg: [pt.L_SHOULDER, pt.L_ELBOW] },
    { name: 'uarmR', poly: bonePoly(pt.R_SHOULDER, pt.R_ELBOW, limbT), seg: [pt.R_SHOULDER, pt.R_ELBOW] },
    { name: 'larmL', poly: bonePoly(pt.L_ELBOW, pt.L_WRIST, limbT), seg: [pt.L_ELBOW, pt.L_WRIST] },
    { name: 'larmR', poly: bonePoly(pt.R_ELBOW, pt.R_WRIST, limbT), seg: [pt.R_ELBOW, pt.R_WRIST] },
    { name: 'ulegL', poly: bonePoly(pt.L_HIP, pt.L_KNEE, limbT), seg: [pt.L_HIP, pt.L_KNEE] },
    { name: 'ulegR', poly: bonePoly(pt.R_HIP, pt.R_KNEE, limbT), seg: [pt.R_HIP, pt.R_KNEE] },
    { name: 'llegL', poly: bonePoly(pt.L_KNEE, pt.L_ANKLE, limbT), seg: [pt.L_KNEE, pt.L_ANKLE] },
    { name: 'llegR', poly: bonePoly(pt.R_KNEE, pt.R_ANKLE, limbT), seg: [pt.R_KNEE, pt.R_ANKLE] },
  ];

  // 3. assign opaque texture pixels to nearest part segment (texture px space)
  const tctx = texture.getContext('2d', { willReadFrequently: true });
  if (!tctx) return null;
  const tw = texture.width;
  const th = texture.height;
  const img = tctx.getImageData(0, 0, tw, th);
  const sx = w / tw;
  const sy = h / th;
  const map = new Uint8Array(tw * th);
  const hasPx = new Array<boolean>(parts.length).fill(false);
  for (let i = 0; i < tw * th; i++) {
    if (img.data[i * 4 + 3] <= 32) continue;
    const lx = (i % tw) * sx - w / 2;
    const ly = ((i / tw) | 0) * sy - h / 2;
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < parts.length; p++) {
      const d = segDist({ x: lx, y: ly }, parts[p].seg[0], parts[p].seg[1]);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    map[i] = best + 1;
    hasPx[best] = true;
  }
  if (hasPx.filter(Boolean).length < 4) return null;

  // 4. per-part texture (bbox of assigned pixels, ≤128px)
  const partTex: (HTMLCanvasElement | null)[] = parts.map(() => null);
  const partBBox: ({ minX: number; minY: number; w: number; h: number } | null)[] = parts.map(() => null);
  for (let p = 0; p < parts.length; p++) {
    if (!hasPx[p]) continue;
    let mnx = tw;
    let mny = th;
    let mxx = 0;
    let mxy = 0;
    for (let i = 0; i < tw * th; i++) {
      if (map[i] !== p + 1) continue;
      const px = i % tw;
      const py = (i / tw) | 0;
      if (px < mnx) mnx = px;
      if (px > mxx) mxx = px;
      if (py < mny) mny = py;
      if (py > mxy) mxy = py;
    }
    const pw = mxx - mnx + 1;
    const ph = mxy - mny + 1;
    const ts = Math.min(1, 128 / Math.max(pw, ph));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(pw * ts));
    c.height = Math.max(1, Math.round(ph * ts));
    const cctx = c.getContext('2d');
    if (!cctx) continue;
    const out = cctx.createImageData(c.width, c.height);
    for (let i = 0; i < tw * th; i++) {
      if (map[i] !== p + 1) continue;
      const px = i % tw;
      const py = (i / tw) | 0;
      const ox = Math.round((px - mnx) * ts);
      const oy = Math.round((py - mny) * ts);
      if (ox < 0 || oy < 0 || ox >= c.width || oy >= c.height) continue;
      const di = (oy * c.width + ox) * 4;
      out.data[di] = img.data[i * 4];
      out.data[di + 1] = img.data[i * 4 + 1];
      out.data[di + 2] = img.data[i * 4 + 2];
      out.data[di + 3] = img.data[i * 4 + 3];
    }
    cctx.putImageData(out, 0, 0);
    partTex[p] = c;
    // texture bbox in LOCAL px
    partBBox[p] = { minX: mnx * sx - w / 2, minY: mny * sy - h / 2, w: pw * sx, h: ph * sy };
  }

  // 5. bodies
  const group = Matter.Body.nextGroup(true);
  const bodies: Matter.Body[] = [];
  const textureKeys: string[] = [];
  for (let p = 0; p < parts.length; p++) {
    const c = Matter.Vertices.centre(parts[p].poly);
    const body = Matter.Bodies.fromVertices(c.x, c.y, [parts[p].poly as Matter.Vector[]], {
      collisionFilter: { group },
      restitution: 0.2,
      friction: 0.5,
    });
    if (!body) continue;
    const tex = partTex[p];
    const bb = partBBox[p];
    if (tex && bb) {
      ragTexSeq += 1;
      const key = `physics-tex-rag-${ragTexSeq}`;
      registerTexture(render, key, tex);
      textureKeys.push(key);
      body.render.sprite = {
        texture: key,
        xScale: bb.w / tex.width,
        yScale: bb.h / tex.height,
      };
      (body.render.sprite as { xOffset?: number }).xOffset = (c.x - bb.minX) / bb.w;
      (body.render.sprite as { yOffset?: number }).yOffset = (c.y - bb.minY) / bb.h;
    } else {
      body.render.visible = false;
    }
    bodies.push(body);
  }

  // indices after possible nulls — bodies were pushed in part order; find them
  // by matching poly centroid distance to each part's expected centre
  const partOf = (name: string): Matter.Body => bodies[parts.findIndex((pp) => pp.name === name)];
  // (fromVertices never returns null for our convex polys, so indices align)

  // 6. pin joints + limits
  const constraints: Matter.Constraint[] = [];
  const joints: RagdollJoint[] = [];
  const pin = (a: Matter.Body, b: Matter.Body, joint: V, lim: number) => {
    constraints.push(
      Matter.Constraint.create({
        bodyA: a,
        bodyB: b,
        pointA: { x: joint.x - a.position.x, y: joint.y - a.position.y },
        pointB: { x: joint.x - b.position.x, y: joint.y - b.position.y },
        length: 0,
        stiffness: 1,
        damping: 0.1,
        render: { visible: false },
      }),
    );
    joints.push({ a, b, rest: 0, min: -lim, max: lim });
  };
  const head = partOf('head');
  const torso = partOf('torso');
  pin(torso, head, neck, 0.6);
  pin(torso, partOf('uarmL'), pt.L_SHOULDER, 2.6);
  pin(torso, partOf('uarmR'), pt.R_SHOULDER, 2.6);
  pin(partOf('uarmL'), partOf('larmL'), pt.L_ELBOW, 2.4);
  pin(partOf('uarmR'), partOf('larmR'), pt.R_ELBOW, 2.4);
  pin(torso, partOf('ulegL'), pt.L_HIP, 1.6);
  pin(torso, partOf('ulegR'), pt.R_HIP, 1.6);
  pin(partOf('ulegL'), partOf('llegL'), pt.L_KNEE, 2.2);
  pin(partOf('ulegR'), partOf('llegR'), pt.R_KNEE, 2.2);

  for (const b of bodies) {
    applyMaterial(b, material);
    // a little air drag on the light limb parts damps residual jitter
    b.frictionAir = Math.max(b.frictionAir, 0.02);
  }
  // translate everything into world position
  for (const b of bodies) Matter.Body.translate(b, { x, y });

  return { bodies, constraints, textureKeys, root: head, joints };
}

/** Wrap an angle to (−π, π] — Matter body angles accumulate without bound. */
const wrapAngle = (a: number) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

/**
 * Soft relative-angle clamp. Only acts past a limit: first removes the part of
 * the relative spin that pushes further out (damping, no bounce-back), then
 * adds a small capped correction toward the limit. The angle is wrapped so a
 * limb that has turned a full revolution isn't "corrected" forever.
 */
export function enforceJointLimits(joints: RagdollJoint[]): void {
  for (const j of joints) {
    const rel = wrapAngle(j.b.angle - j.a.angle - j.rest);
    const over = rel > j.max ? rel - j.max : rel < j.min ? rel - j.min : 0;
    if (over === 0) continue;
    const tot = j.a.inertia + j.b.inertia || 1;
    const wa = j.b.inertia / tot;
    const wb = j.a.inertia / tot;
    const relW = j.b.angularVelocity - j.a.angularVelocity;
    const outward = (over > 0 && relW > 0) || (over < 0 && relW < 0) ? relW : 0;
    const fix = Math.max(-0.04, Math.min(0.04, over * 0.05));
    const dw = outward + fix;
    Matter.Body.setAngularVelocity(j.a, j.a.angularVelocity + dw * wa);
    Matter.Body.setAngularVelocity(j.b, j.b.angularVelocity - dw * wb);
  }
}

// ============================================================================
// Stick figure test object (canvas + synthetic 33-point pose)
// ============================================================================

export function createStickFigure(): { canvas: HTMLCanvasElement; pose: PoseKeypoint[] } {
  const W = 110;
  const H = 200;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const u = (v: [number, number]): V => ({ x: v[0] * W, y: v[1] * H });
  const line = (a: V, b: V, wdt = 14) => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = wdt;
    ctx.lineCap = 'round';
    ctx.stroke();
  };
  line(u([0.68, 0.22]), u([0.8, 0.38]));
  line(u([0.8, 0.38]), u([0.85, 0.52]));
  line(u([0.32, 0.22]), u([0.2, 0.38]));
  line(u([0.2, 0.38]), u([0.15, 0.52]));
  line(u([0.5, 0.22]), u([0.5, 0.55]), 18);
  line(u([0.6, 0.55]), u([0.62, 0.75]));
  line(u([0.62, 0.75]), u([0.63, 0.95]));
  line(u([0.4, 0.55]), u([0.38, 0.75]));
  line(u([0.38, 0.75]), u([0.37, 0.95]));
  const nose = u([0.5, 0.08]);
  ctx.beginPath();
  ctx.arc(nose.x, nose.y + 4, 15, 0, Math.PI * 2);
  ctx.fillStyle = '#a78bfa';
  ctx.fill();

  const pose: PoseKeypoint[] = new Array(33).fill(null).map(() => ({
    x: 0.5,
    y: 0.08,
    visibility: 0,
  }));
  for (const k of KEYS) {
    pose[POSE[k as keyof typeof POSE]] = { x: TEMPLATE[k][0], y: TEMPLATE[k][1], visibility: 1 };
  }
  return { canvas: c, pose };
}
