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

| Part | Brief | Branch | Owns |
| --- | --- | --- | --- |
| Photo Studio | [AGENT1.md](AGENT1.md) | `feat/photo-editor` | `src/components/StudioPanel.*`, `src/lib/removeBackground.ts`, `public/demo/` |
| Physics World | [AGENT2.md](AGENT2.md) | `feat/physics-world` | `src/components/PhysicsWorld.*`, `src/lib/physics.ts` |

Shared files on `master` (`src/App.tsx`, `src/App.css`, `src/index.css`, `src/main.tsx`, `src/types/asset.ts`, `vite.config.ts`, `package.json`) are frozen. Feature branches must not edit them.

## Integration contract

`src/types/asset.ts` defines `CutoutAsset`. `StudioPanel` calls `onSpawn(asset)` with a fresh `id` for every spawn. `App` appends it to `spawnRequests`. `PhysicsWorld` creates one body per unseen `id`.

## Licence note

`@imgly/background-removal` is AGPL-3.0. Publicly hosting the app means making its source available.
