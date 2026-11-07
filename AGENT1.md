# DEVIN AGENT A — PhotoRoom-Inspired Photo Studio

## Mission

Build the photo-editing half of **PhysicsLab**, a web application that recreates the core image cutout experience of PhotoRoom and sends isolated objects into a separate physics playground.

You are collaborating with another Devin agent in the same GitHub repository. Your branch is `feat/photo-editor`.

**Time limit: 3 hours total, including integration and testing. Target a working feature branch within 100 minutes.**

## Tech stack

- React + TypeScript + Vite
- CSS for styling
- `@imgly/background-removal` for background removal
- `lucide-react` for icons
- The base scaffold on `master` already contains every dependency (`@imgly/background-removal`, `onnxruntime-web`, `lucide-react`, `matter-js`). Run `npm install` then `npm run dev`. Do not add, remove, or upgrade packages.

## Git and file ownership

You own ONLY these files:

- `src/components/StudioPanel.tsx` (currently a placeholder on `master` — replace it)
- `src/components/StudioPanel.css`
- `src/lib/removeBackground.ts`
- `public/demo/` for original demo SVG/PNG assets

Do not modify `src/App.tsx`, `src/App.css`, `src/index.css`, `src/main.tsx`, `vite.config.ts`, `index.html`, `package.json`, `package-lock.json`, `src/types/asset.ts`, or any physics file. Do not push directly to `master`. If a shared file seems to need a change, stop and report it instead.

## Integration contract

Import the existing `CutoutAsset` interface (and the spawn size constants) from `src/types/asset.ts`:

```ts
export interface CutoutAsset {
  id: string;          // unique per spawn event
  assetId: string;     // stable library item id, same across re-spawns
  name: string;
  url: string;         // blob: URL or /demo/<file>, with real transparency
  width: number;       // natural pixel width of the image at url
  height: number;      // natural pixel height of the image at url
  source: 'upload' | 'demo';
  spawnSize?: number;  // optional max rendered dimension (px)
}
// also exported: DEFAULT_SPAWN_SIZE = 160, MIN_SPAWN_SIZE = 40, MAX_SPAWN_SIZE = 320
```

`src/App.tsx` (already on `master`) keeps a `spawnRequests: CutoutAsset[]` state, appends to it in `onSpawn`, and passes it to `PhysicsWorld`. Entries are never removed or mutated.

Export a default React component:

`StudioPanel({ onSpawn }: { onSpawn: (asset: CutoutAsset) => void })`

When the user clicks "Bring to Life", call `onSpawn(asset)`. Rules:

- `id`: a fresh `crypto.randomUUID()` on every click, including repeated spawns of the same cutout.
- `assetId`: stable for a library item; the same for every spawn of that item.
- `width` / `height`: the natural pixel size of the image at `url` (after trimming, if you trim).
- `url`: must remain valid for the whole session. Never call `URL.revokeObjectURL` on a cutout that may have been spawned — the physics world keeps using it as a texture.
- `spawnSize`: set it only if you implement the size slider (clamp to `MIN_SPAWN_SIZE`–`MAX_SPAWN_SIZE`); otherwise omit it and the physics world uses `DEFAULT_SPAWN_SIZE`.
- `source`: `'upload'` for background-removed photos, `'demo'` for the demo objects.

## Features to implement

### P0 — Required

**1. Image upload**
- Drag-and-drop image upload.
- File picker.
- Accept PNG, JPG, and WebP.
- Reject unsupported types and files over 10 MB with a clear message.
- Downscale images to at most 2048 px on the longest side before background removal (keeps processing fast).
- Show the uploaded image immediately.

**2. AI background removal**
- Remove the background with `@imgly/background-removal`.
- Implement this in the dedicated library file.
- Display processing state and error messages.
- Output a transparent PNG Blob URL.
- Show the original and processed image.
- Avoid re-running background removal when the user only changes preview settings.

**3. Photo editor interface**
- Attractive, modern dark UI inspired by professional image-editing tools.
- Clear upload area.
- Checkerboard transparent background behind isolated subjects.
- Before/after toggle.
- White, black, and transparent preview backgrounds.
- Download processed PNG button.

**4. Asset library**
- Store processed images in component state.
- Display small thumbnails.
- Clicking a thumbnail selects the cutout.
- "Bring to Life" sends the selected cutout to the physics world through `onSpawn`.
- Allow adding the same image multiple times with a new ID each time.

**5. Reliable demo fallback**
- Create 3 original demo objects in `public/demo/`, ideally a rocket, rubber duck, and planet or similarly recognisable silhouettes.
- They must have genuine transparent backgrounds.
- SVGs must have explicit `width` and `height` attributes on the root `<svg>` (not just `viewBox`), otherwise browsers may report a 0×0 natural size. PNG is also fine.
- Provide "Try Demo Objects" so the playground is usable even if AI background removal fails.
- Ensure the demo objects can be spawned through the same integration contract.

### P1 — Only if time permits

- Automatically trim transparent padding around cutouts.
- Simple size slider to control initial spawn size.
- More polished micro-interactions and processing animations.

## Design direction

Use a dark professional editor aesthetic with purple/cyan accents.

- Use the shared CSS variables from `src/index.css` (`--bg`, `--panel`, `--panel-2`, `--border`, `--text`, `--muted`, `--accent-purple`, `--accent-cyan`, `--danger`, `--radius`) so both halves match.
- Prefix all your CSS classes with `studio-` to avoid collisions with the physics component.
- The component is rendered inside `.app__studio` (left column on wide screens, stacked on top below 1100 px). Its root should be `width: 100%` and may grow taller; the parent scrolls.

Studio layout should include:
- Header: "PhysicsLab — Photo Studio"
- Large upload and preview section
- Side-by-side or toggleable before/after preview
- Background options
- Asset thumbnail strip
- Prominent "Bring to Life" CTA

No authentication, database, paid integrations, or unnecessary routing.

## Constraints

- Never use PhotoRoom proprietary code, logos, or bundled assets.
- Do not expose credentials or require a secret API key.
- First-run background removal downloads model files (tens of MB). Show real progress using the library's `progress` callback, and start loading the model in the background when the panel mounts (the library's `preload` export) so the first removal in a live demo doesn't stall.
- Do not create external network dependencies beyond the approved background removal model.
- Prioritise working functionality over elaborate styling.

## Acceptance criteria

1. I can upload a photo.
2. Its background can be removed.
3. I can preview the transparent result.
4. I can download the PNG.
5. I can send it to the other agent's physics component.
6. I can send it again as a second independent object.
7. I can load demo objects without the AI model.
8. `npm run build` passes.

## Delivery

Commit to `feat/photo-editor`, push the branch, and create a pull request to `master`.

Report:
- Implemented features
- Exact files changed
- How to test
- Known limitations

Do not modify the other agent's files, even to fix an apparent integration issue. Report the issue instead.

## Integration and merge

- The base scaffold (dependencies, `CutoutAsset`, `App.tsx` wiring, layout, theme variables, placeholder components) is already on `master`. Branch from the latest `master`.
- Your branch should only touch the files you own, so merging both PRs into `master` is conflict-free.
- `npm run build` and `npm run lint` must pass on your branch before you open the PR.
- After both PRs are merged, one developer runs the end-to-end check on `master`: upload → remove background → Bring to Life → object falls, can be dragged/thrown; spawn the same cutout twice; demo objects spawn; gravity/explode/reset still work.
