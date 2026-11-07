# DEVIN AGENT B — Interactive Physics Playground

## Mission

Build the original differentiating feature of **PhysicsLab**: a live 2D physics sandbox where images extracted from photographs become draggable, throwable, collidable objects.

Another Devin agent is building the photo editor. Both features will be connected through a shared React interface.

Your branch is `feat/physics-world`.

**Time limit: 3 hours total, including integration and testing. Target a working feature branch within 100 minutes.**

## Tech stack

- React + TypeScript + Vite
- Matter.js for 2D physics
- HTML Canvas via Matter.js renderer
- CSS for controls and visual effects
- `lucide-react` for icons

Do not build a physics engine from scratch.

## Git and file ownership

You own ONLY:

- `src/components/PhysicsWorld.tsx`
- `src/components/PhysicsWorld.css`
- `src/lib/physics.ts`

Do not edit `App.tsx`, the photo studio, shared types, package files, or the other agent's components. Do not push directly to main.

## Integration contract

Import `CutoutAsset` from `src/types/asset.ts`.

Export a default component:

`PhysicsWorld({ spawnRequests }: { spawnRequests: CutoutAsset[] })`

The parent passes an array of spawn requests.

- Every request has a unique ID.
- For each unseen ID, load the image texture and create one Matter.js body.
- Objects should appear near the upper-middle of the canvas and fall due to gravity.
- Preserve aspect ratio.
- Limit oversized objects to reasonable canvas dimensions, for example 160 px maximum width or height.
- Track processed IDs to avoid spawning duplicates on React re-renders.
- On image-loading failure, render a visible coloured placeholder body rather than crashing.
- Clearing the world must not cause old requests to respawn.

## Features to implement

### P0 — Required

**1. Physics arena**
- Large visually appealing responsive canvas.
- Dark background with subtle grid lines.
- Static floor and side walls.
- Objects bounce realistically.
- Objects rotate when falling or colliding.
- Objects stack on top of one another.
- Render actual transparent image textures, not just rectangular placeholders.

**2. Real object interaction**
- Click and drag objects.
- Throw objects with mouse movement.
- Objects retain momentum when released.
- Multiple objects must interact through collisions.
- Use Matter.js mouse constraints.

**3. Gravity controls**
- Gravity ON/OFF.
- Gravity strength slider.
- Gravity direction buttons: down, up, left, right.
- Changes should immediately affect active objects.
- Prevent extreme settings from crashing the simulation.

**4. Explosion button**
- A large prominent "EXPLODE" button.
- Apply outward forces to all non-static objects.
- Add a short visual shockwave and optional screen shake.
- All objects should scatter, hit boundaries, and settle again.

**5. Simulation controls**
- Pause/resume physics.
- Reset or clear objects.
- Object counter.
- Visible indication of current gravity state.

**6. Initial showcase**
- Ensure the physics world is visibly functional without requiring an uploaded photograph.
- Include a built-in "Spawn Test Objects" action using simple Matter.js primitives or original placeholder textures.
- Do not depend on the other agent's implementation for local testing.

### P1 — Only if time permits

**Material properties**
- Rubber: high bounce.
- Metal: heavier, lower bounce.
- Feather: low mass and slower falling.

Provide a material selector that affects newly created objects or the currently selected body.

**Black hole**
- Click somewhere in the canvas to place a temporary black hole.
- Nearby objects get pulled toward it.
- Show a glowing radial effect.
- Remove the black hole after a short duration.

**Snapshot**
- Save the current canvas as an image.

## Design direction

The visual style should feel like a modern science experiment crossed with an arcade sandbox.

Suggested layout:
- Large central physics canvas
- Floating status bar with number of objects
- Compact gravity control panel
- Bottom toolbar for pause, reset, gravity, and explosion
- Large visually distinct explosion action

The app must feel interactive even before an image is uploaded.

## Engineering requirements

- Initialise Matter.js once per component mount.
- Use refs for the engine, runner, renderer, and processed request IDs.
- Clean up renderer, runner, events, and mouse listeners on unmount.
- Avoid re-creating the engine when new props arrive.
- Handle canvas resizing and update boundaries.
- Ensure image sprites scale correctly to their physics bodies.
- Keep the animation smooth with approximately 20 objects.
- Prefer simple stable physics over complex effects.

## Acceptance criteria

1. Bodies fall under gravity.
2. Images render as textures on physics bodies.
3. I can drag and throw them.
4. Objects collide and stack.
5. Gravity controls work.
6. Explosions scatter objects.
7. Pause and reset work.
8. New `spawnRequests` create objects exactly once.
9. There are no persistent animation loops after unmount.
10. `npm run build` passes.

## Delivery

Commit to `feat/physics-world`, push the branch, and create a pull request to main.

Report:
- Implemented features
- Exact files changed
- How to test
- Known limitations

Do not modify the shared application files or the other agent's implementation.