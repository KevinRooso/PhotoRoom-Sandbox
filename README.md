# PhysicsLab

A PhotoRoom-inspired photo studio with a twist: upload a photo, remove its background, click **Bring to Life**, and the cutout drops into a live 2D physics playground where you can grab, throw, stack and explode it.

## Run

```bash
nvm use        # Node 22 (see .nvmrc)
npm install
npm run dev
npm run build  # must pass on every branch
```

## How the work is split

### Phase 2 (current)

| Part | Brief | Branch | Owns |
| --- | --- | --- | --- |
| Photo Studio + app shell | [PHASE2-AGENT1.md](PHASE2-AGENT1.md) | `feat/p2-studio` | `src/App.tsx` (layout only), `src/App.css`, `src/components/StudioPanel.*`, `src/components/studio/*`, `src/lib/removeBackground.ts`, `src/lib/segmentPeople.ts`, `src/lib/library.ts`, `public/demo/`, `public/models/` |
| Physics World | [PHASE2-AGENT2.md](PHASE2-AGENT2.md) | `feat/p2-physics` | `src/components/PhysicsWorld.*`, `src/components/physics/*`, `src/lib/physics.ts`, `src/lib/physics/*` |

Frozen shared files in Phase 2: `src/index.css`, `src/types/asset.ts`, `src/main.tsx`, `vite.config.ts`, `index.html`, `package.json`, `package-lock.json`. After pulling the Phase 2 scaffold, run `npm install` (it adds `@mediapipe/tasks-vision`).

### Phase 1 (done)

| Part | Brief | Branch | Owns |
| --- | --- | --- | --- |
| Photo Studio | [AGENT1.md](AGENT1.md) | `feat/photo-editor` | `src/components/StudioPanel.*`, `src/lib/removeBackground.ts`, `public/demo/` |
| Physics World | [AGENT2.md](AGENT2.md) | `feat/physics-world` | `src/components/PhysicsWorld.*`, `src/lib/physics.ts` |

## Integration contract

`src/types/asset.ts` defines `CutoutAsset`. `StudioPanel` calls `onSpawn(asset)` with a fresh `id` for every spawn. `App` appends it to `spawnRequests`. `PhysicsWorld` creates one body per unseen `id`. Phase 2 adds two optional fields: `kind` (`'person' | 'object'`) and `pose` (33 MediaPipe BlazePose keypoints normalised to the cutout image).

## Licence note

`@imgly/background-removal` is AGPL-3.0. Publicly hosting the app means making its source available.
