# PHASE 2 — DEVIN AGENT B — Physics Effects, Crumble & Joints

## Mission

Phase 1 shipped a working Matter.js playground (`src/components/PhysicsWorld.tsx`, `src/lib/physics.ts`): image bodies, drag/throw, gravity controls, explode with FX, materials, black hole, snapshot, synthesized sound.

Phase 2 makes it a **demo-ready effects sandbox**: objects crumble into textured shards, new visual effects, outline-accurate collisions, jointed bodies (jelly, ropes, springs), and a cleaner physics UI. **We demo in a few hours — every feature must be visible and fun, and stability beats ambition.**

You are collaborating with another Devin agent (Agent A, photo studio) in the same repository. Your branch is `feat/p2-physics`.

**Time limit: ~2.5 hours total including testing. Have a working, pushed branch within 90 minutes. Build in the P0 order below and commit after each item so something demo-able always exists.**

## Setup

```bash
git checkout master && git pull
npm install          # Phase 2 added a dependency (used by Agent A only)
git checkout -b feat/p2-physics
npm run dev
```

The Phase 2 scaffold on `master` already contains everything you need. Do not add, remove, or upgrade packages. Everything below is buildable with `matter-js` 0.20 + Canvas 2D.

## Git and file ownership

You own ONLY:

- `src/components/PhysicsWorld.tsx`, `src/components/PhysicsWorld.css`
- `src/components/physics/*` (new, optional sub-components)
- `src/lib/physics.ts`
- `src/lib/physics/*` (new, optional — e.g. `fracture.ts`, `softbody.ts`, `ropes.ts`, `ragdoll.ts`, `hull.ts`, `fx.ts`)

Do not modify `src/App.tsx`, `src/App.css`, `src/index.css`, `src/main.tsx`, `src/types/asset.ts`, `vite.config.ts`, `index.html`, `package.json`, `package-lock.json`, `public/`, or any studio file. Agent A owns the app shell layout in Phase 2. Do not push to `master`. If a shared file seems to need a change, stop and report it.

## Integration contract (unchanged API, two new optional fields)

`PhysicsWorld({ spawnRequests }: { spawnRequests: CutoutAsset[] })` — same as Phase 1. `src/types/asset.ts` now also exports:

```ts
export interface PoseKeypoint { x: number; y: number; visibility: number } // normalised to the cutout image (0..1, may fall slightly outside)

export interface CutoutAsset {
  // ...all Phase 1 fields unchanged (id, assetId, name, url, width, height, source, spawnSize?)
  kind?: 'person' | 'object';   // omitted = unknown, treat as 'object'
  pose?: PoseKeypoint[];        // 33 MediaPipe BlazePose keypoints, only for person cutouts with a detected skeleton
}

export const POSE_KEYPOINT_COUNT = 33;
export const POSE = { NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28 } as const;
```

- Pixel position of keypoint `k` in the cutout image: `(k.x * asset.width, k.y * asset.height)`. Ignore points with `visibility < 0.3`.
- Agent A will start sending `kind: 'person'` + `pose` for each person separated from a group photo. Demo objects send neither. Your code must work with and without them.
- All Phase 1 rules still hold: one body (or one composite) per unseen `id`, never revoke/modify `url`, clearing must not respawn old requests, fall back to a placeholder on image load failure.
- The component is rendered inside a container with a definite size (Agent A is redesigning the shell — do not depend on any parent class name). Root stays `width: 100%; height: 100%`, sized by `ResizeObserver`.

## What already exists (build on it, don't rewrite it)

- `createImageBody` makes a chamfered **rectangle** with a sprite texture registered in `render.textures` under a unique key (`textureKey(id)`); textures are offscreen canvases from `rasterizeTexture` (≤ 512 px).
- `onAfterRender` in `PhysicsWorld.tsx` already draws explosion particles, trails, the black hole and the selection outline on `render.context` with the pixel-ratio transform — add new FX there.
- `enforceBodyCap` evicts the oldest non-static bodies beyond `MAX_BODIES = 60`; `nonStaticBodies(engine).length` feeds the object counter; `clearBodies` removes every non-static body and its texture.
- Sound: `createSoundEngine` (Web Audio synth) — add new sounds in the same style (noise bursts + oscillators, short-lived nodes).
- DEV debug hook `window.__pw` exposes the engine/render for verification.

## Verified Matter.js facts (0.20, checked in `node_modules/matter-js/src`)

- Sprite drawing (`Render.js` ~786–800): the texture is drawn at `(-texture.width * sprite.xOffset * sprite.xScale, -texture.height * sprite.yOffset * sprite.yScale)` relative to `part.position`, rotated by the body angle. Default offsets are 0.5 (texture centred on the body position).
- `Bodies.fromVertices` re-centres the body on its **centroid**. For a body made from a polygon whose bounding box is `[minX, minY, w, h]` with centroid `(cx, cy)`, use a texture covering that bbox and set `xOffset = (cx - minX) / w`, `yOffset = (cy - minY) / h` so the texture stays aligned.
- `Bodies.fromVertices` needs `poly-decomp` only for **concave** shapes. Convex polygons (Voronoi cells, convex hulls) work without it — keep every polygon you pass convex.
- Available: `Constraint` (pin when `length: 0`, spring via `stiffness`/`damping`), `Composites.chain`, `Composites.mesh`, `Composites.softBody`, `Body.nextGroup(true)` (negative group ⇒ members never collide with each other).
- Not available: joint angle limits and motors. Clamp relative angles yourself in `beforeUpdate` if needed.
- `Composite.allBodies(engine.world)` (and therefore `nonStaticBodies`) includes bodies nested in composites. Once you add composites, the counter, cap, clear and selection must work in terms of **objects** (a jelly or ragdoll = 1 object), not raw bodies.

## Features to implement

### P0 — Required (build in this order)

**1. Crumble / shatter** (`src/lib/physics/fracture.ts` suggested)
- Break an image body into **8–14 convex shards** (fewer for small bodies): Voronoi cells computed by **half-plane clipping** of the body polygon (for each seed, start from the body polygon and clip by the perpendicular bisector against every other seed — O(n²), no library). Bias seeds toward the impact point for a radial look.
- Each shard is a `Bodies.fromVertices` body whose sprite is the parent texture **clipped to the shard polygon** (offscreen canvas ≤ 128 px per shard), aligned with the offset rule above, in the parent's world position and angle.
- Drop shards whose texture is < 15% opaque (transparent padding around cutouts).
- Shard velocity = parent velocity + angular contribution (ω × r) + a small outward impulse from the impact point.
- Shards fade out and are removed after 6–8 s. Keep a separate shard cap (~120); shards must not count toward `MAX_BODIES`, the object counter, or `enforceBodyCap` (tag them, e.g. `body.plugin.shard = true`). Release shard textures on removal.
- Triggers:
  - **Crumble tool**: click a body to shatter it at the click point.
  - **Fragile toggle**: when on, impacts with relative speed above a threshold shatter the hit body (reuse the pre-step velocity logic in `onCollisionStart`; debounce so one hit = one shatter).
  - **Explode → Shatter mode**: a toggle next to EXPLODE; when on, the explosion crumbles every image body and flings the shards.
- Dust burst at the break point + a synthesized "crack" sound.

**2. Visual effects pack**
- **Slow-mo / bullet time** toggle: `engine.timing.timeScale = 0.25` with a subtle tinted vignette over the stage; off restores 1.
- **Spawn materialize**: expanding glow ring + sparkle particles where a new object appears (and a quick scale-in if feasible).
- **Impact dust**: small puff particles at contact points on hard hits (reuse the threshold from impact sounds).
- **Freeze tool**: click a body → it becomes static with an icy overlay (blue tint + frost highlight); click again to thaw. Crumbling a frozen body produces ice-tinted shards.
- **Fire tool**: click a body → flame particles rise from it and it darkens over ~3 s, then it crumbles into dark "ash" shards.

**3. Silhouette collisions** (`hull.ts`)
- For image bodies, compute the **convex hull of the opaque pixels** (sample the texture alpha on a ~64 px grid, alpha > 32, monotone-chain hull), simplify to ≤ 16 vertices, build the body with `Bodies.fromVertices`, and realign the sprite with the centroid offset rule. People and objects should rest and stack on their outline, not their bounding rectangle.
- Fall back to the current chamfered rectangle if the hull is degenerate (< 3 points or tiny area).

**4. Joints**
- **"Spawn as" selector** (Solid | Jelly | Ragdoll) for new spawns (spawn requests and test objects), like the material selector.
- **Jelly**: split the texture into a grid (~4×5, adapted to aspect ratio); each non-transparent tile becomes a small body rendering its own texture slice; connect neighbours (and diagonals) with springs (stiffness ≈ 0.3, damping ≈ 0.05); all tiles share one negative collision group. Dragging any tile drags the jelly. Counts as one object.
- **Hang tool**: click a body → a rope of 8–12 small links (`Composites.chain`) from a ceiling anchor above it to the body; draw the rope as a smooth line (hide link bodies). Clear/reset removes ropes.
- **Link tool**: click body A then body B → spring constraint between them, drawn as a zig-zag spring.

**5. Physics UI redesign**
- Vertical **tool rail** inside the stage (left edge): Grab (default), Crumble, Freeze, Fire, Hang, Link, Black hole. The active tool is highlighted; Esc returns to Grab; the cursor reflects the tool.
- Top **glass status bar**: object count, gravity state, material, spawn-as mode, slow-mo/paused badges.
- Bottom **dock**: Pause, Slow-mo, Clear, Reset, Spawn Test Objects, Snapshot, Sound | Spawn-as segmented control | Material | Gravity popover (toggle, strength, direction pad) | big **EXPLODE** with Shatter toggle.
- Keyboard shortcuts: Space = pause, S = slow-mo, E = explode, C = crumble tool, Esc = grab tool (ignore when focus is in an input).

### P1 — Stretch (only after all P0 items are committed)

- **Ragdoll** (the "Ragdoll" spawn-as mode):
  - If `asset.pose` is present: build parts along the bones — head (around NOSE), torso (shoulders→hips quad), upper/lower arms, upper/lower legs. Assign each opaque texture pixel to its nearest bone segment to create per-part textures. Connect with pin constraints (`length: 0`, stiffness ≈ 0.9) at neck, shoulders, elbows, hips, knees; all parts in one negative collision group; soft relative-angle clamping in `beforeUpdate`; raise `engine.constraintIterations` if it jitters.
  - Without a pose: template proportions (head = top ~15% centre, torso = 15–55% centre, arms = sides of the torso band, legs = bottom 45% split left/right).
  - Must be testable without Agent A: add a procedurally drawn stick figure with a synthetic 33-point pose to "Spawn Test Objects".
  - If ragdoll isn't ready, the Ragdoll option is hidden or falls back to Jelly — never crash.
- Water tank: a toggleable water region at the bottom with buoyancy (force ∝ submerged fraction), drag, splash particles and a wavy surface.
- Wind / fan zone; tornado or implode variant of the black hole.

## Research notes (decided scope — no separate research phase)

Precedents: People Playground (ragdoll sandbox built around people), Algodoo (hinges, springs, water), matter.js Voronoi-breakable demos (topaz1008/voronoi-breakable, DOMolition).

| Feature | Demo impact | Effort | Notes |
|---|---|---|---|
| Crumble / shatter | Very high | Medium | Half-plane Voronoi, convex shards, texture-mapped |
| Slow-mo | High | Small | `engine.timing.timeScale` |
| Silhouette hull collisions | High | Small–Med | Convex ⇒ no poly-decomp |
| Jelly | High | Small–Med | Grid tiles + springs |
| Hang / Link tools | Med–High | Small | Built-in constraints |
| Freeze / Fire | High | Medium | Reuse fracture + particles |
| Materialize / impact dust | Medium | Small | `afterRender` particles |
| Ragdoll | Very high | Large | Stretch; needs `pose` for accurate joints |
| Water / wind | High | Medium | Stretch |

## Design direction

- Use the tokens in `src/index.css` (Phase 1 names still exist; Phase 2 added `--surface-3`, `--border-strong`, `--text-2`, `--accent-pink`, `--success`, `--warning`, `--accent-gradient`, `--glass-bg`, `--glass-blur`, `--radius-sm/lg/pill`, `--space-1..6`, `--fs-xs..2xl`, `--shadow-1/2`, `--glow-purple/cyan`, `--ease-out`, `--dur-fast`, `--dur`, `--font-sans`, `--font-mono`). No hard-coded colours except inside canvas drawing code.
- Minimum text size 11px (`--fs-xs`). Glass panels: `background: var(--glass-bg); backdrop-filter: var(--glass-blur); border: 1px solid var(--border)`.
- Prefix all classes with `physics-`. Keep the stage the hero: controls float over or dock around it; nothing should cover more than ~15% of the canvas.
- Respect `prefers-reduced-motion` for screen shake and large flashes.

## Engineering requirements

- Keep the Phase 1 invariants: engine/runner/render created once per mount, refs for mutable state, full cleanup on unmount (no leftover loops, listeners, or audio), processed-id set, clear generation.
- Composites (jelly, rope, ragdoll) are added/removed as a whole; clear/reset/cap remove their bodies, constraints and textures.
- Keep the simulation smooth with ~20 objects + ~100 shards. Shard/tile textures stay small; avoid per-frame allocations in `afterRender`.
- `npm run build` and `npm run lint` must pass.

## Acceptance criteria

1. Crumble tool shatters a cutout into textured shards that tumble and fade.
2. Fragile impacts and Explode → Shatter both crumble objects.
3. Slow-mo, materialize, impact dust, freeze and fire are visible and work.
4. Cutouts collide on their silhouette hull.
5. Jelly spawns wobble; Hang and Link tools work; clear/reset remove everything.
6. New `spawnRequests` still create exactly one object each; demo objects (no `pose`/`kind`) still work.
7. No animation loops or audio survive unmount.
8. `npm run build` and `npm run lint` pass.

## Delivery

Commit to `feat/p2-physics`, push the branch, and open a pull request to `master`. Report: implemented features, exact files changed, how to test, known limitations. Do not modify the other agent's files, even to fix an apparent integration issue — report it instead.

## Integration and merge

- Branch from the latest `master` (Phase 2 scaffold). Your branch only touches the files you own, so merging both PRs is conflict-free.
- After both PRs merge, one developer runs the end-to-end check on `master`: group photo → separate characters → Bring all → crumble / jelly / hang / link / explode-shatter / slow-mo; demo objects still spawn; gravity, pause, reset still work.
