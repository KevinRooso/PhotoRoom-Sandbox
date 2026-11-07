# PHASE 2 — DEVIN AGENT A — Group Photos, Persistent Library & App Redesign

## Mission

Phase 1 shipped the Photo Studio (`src/components/StudioPanel.tsx`, `src/lib/removeBackground.ts`): upload, AI background removal, preview, download, demo objects, "Bring to Life".

Phase 2 makes the studio demo-ready:

1. **Group photo → separate characters**: upload a photo of several people and get one cutout per person (with a skeleton for ragdoll physics).
2. **Persistent library**: everything you processed survives a reload; re-uploading the same photo opens it instantly instead of reprocessing.
3. **Whole-app redesign**: the current UI looks sloppy — new app shell and a cleaner, more professional studio.

You are collaborating with another Devin agent (Agent B, physics) in the same repository. Your branch is `feat/p2-studio`.

**Time limit: ~2.5 hours total including testing. Have a working, pushed branch within 90 minutes. Build in the P0 order below and commit after each item.**

## Setup

```bash
git checkout master && git pull
npm install          # Phase 2 added @mediapipe/tasks-vision@1.2.0
git checkout -b feat/p2-studio
npm run dev
```

The Phase 2 scaffold on `master` already contains every dependency (`@imgly/background-removal`, `@mediapipe/tasks-vision` 1.2.0, `lucide-react`). Do not add, remove, or upgrade packages.

## Git and file ownership

You own ONLY:

- `src/App.tsx` — **layout only** (see rules below)
- `src/App.css`
- `src/components/StudioPanel.tsx`, `src/components/StudioPanel.css`
- `src/components/studio/*` (new, optional sub-components)
- `src/lib/removeBackground.ts`
- `src/lib/segmentPeople.ts` (new)
- `src/lib/library.ts` (new)
- `public/demo/`, `public/models/` (new)

Do not modify `src/index.css`, `src/main.tsx`, `src/types/asset.ts`, `vite.config.ts`, `index.html`, `package.json`, `package-lock.json`, or any physics file (`src/components/PhysicsWorld.*`, `src/components/physics/*`, `src/lib/physics*`). Do not push to `master`. If a shared file seems to need a change, stop and report it.

**`App.tsx` rules:** keep the `spawnRequests: CutoutAsset[]` state, the append-only `handleSpawn`, `<StudioPanel onSpawn={handleSpawn} />` and `<PhysicsWorld spawnRequests={spawnRequests} />` exactly as they are. You may change the surrounding markup and class names. The element wrapping `PhysicsWorld` must have a **definite width and height** and `position: relative` (PhysicsWorld sizes its canvas from its container with a `ResizeObserver`).

## Integration contract

`src/types/asset.ts` (frozen):

```ts
export interface PoseKeypoint { x: number; y: number; visibility: number } // normalised to the cutout image

export interface CutoutAsset {
  id: string;          // fresh crypto.randomUUID() on every spawn
  assetId: string;     // stable library item id
  name: string;
  url: string;         // blob: URL or /demo/<file>; must stay valid for the whole session
  width: number;       // natural pixel size of the image at url
  height: number;
  source: 'upload' | 'demo';
  spawnSize?: number;  // MIN_SPAWN_SIZE..MAX_SPAWN_SIZE
  kind?: 'person' | 'object';   // NEW (optional)
  pose?: PoseKeypoint[];        // NEW (optional): 33 BlazePose keypoints
}
// also exported: DEFAULT_SPAWN_SIZE, MIN_SPAWN_SIZE, MAX_SPAWN_SIZE, POSE_KEYPOINT_COUNT = 33, POSE (joint indices)
```

Rules (Phase 1 rules still apply):

- `kind: 'person'` for cutouts produced from a detected person, `'object'` for any other separated piece, omit for demo objects.
- `pose`: only on person cutouts with a detected skeleton; **exactly 33 points** in MediaPipe order, converted from full-image coordinates to the **trimmed cutout**: `x = (lm.x * imageW - cropLeft) / cropW`, `y = (lm.y * imageH - cropTop) / cropH`, `visibility = lm.visibility`.
- Library items restored from IndexedDB are `source: 'upload'` and keep their `kind`/`pose`.
- Never `URL.revokeObjectURL` a cutout URL that may have been spawned (including after deleting it from the library).

## Verified MediaPipe 1.2.0 API (from `node_modules/@mediapipe/tasks-vision/vision.d.ts`)

```ts
import { PoseLandmarker, type PoseLandmarkerResult, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

const landmarker = await PoseLandmarker.createFromOptions(
  { wasmLoaderPath, wasmBinaryPath },                 // WasmFileset — verified: Vite emits both assets, tsc passes
  {
    baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'GPU' }, // 'CPU' | 'GPU'
    runningMode: 'IMAGE',                             // 'IMAGE' | 'VIDEO'
    numPoses: 8,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.35,
    outputSegmentationMasks: true,
  },
);
const result: PoseLandmarkerResult = landmarker.detect(imageSource); // sync IMAGE-mode overload (copies masks)
// result.landmarks: NormalizedLandmark[][]   (per person: 33 × {x, y, z, visibility, presence?}, x/y normalised to the input image)
// result.segmentationMasks?: MPMask[]        (per person; MPMask has width, height, getAsFloat32Array(), close())
// result.close(); landmarker.close();
```

- The wasm binary is ~14.5 MB (bundled by Vite from `node_modules`, no CDN).
- Model: download once and commit it at `public/models/pose_landmarker_lite.task` from the version-pinned URL `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task` (5,777,746 bytes, Apache-2.0).
- If creating with `delegate: 'GPU'` throws, retry once with `'CPU'`.
- If a mask's `width/height` differ from the input image size, scale mask coordinates accordingly.

## Features to implement

### P0 — Required (build in this order)

**1. Persistent library** (`src/lib/library.ts`)
- IndexedDB database `physicslab`, version 1, no extra dependency (small promise wrapper around the raw API).
  - Store `uploads`, keyPath `hash`: `{ hash, name, createdAt, originalBlob, assetIds: string[] }` (`originalBlob` = the downscaled original, used for before/after).
  - Store `cutouts`, keyPath `assetId`, index `uploadHash`: `{ assetId, uploadHash, name, blob, width, height, kind, pose?, createdAt }`.
- API (suggested): `hashFile(file)` (SHA-256 hex via `crypto.subtle.digest`), `findUpload(hash)`, `saveUpload(upload, cutouts)` (one transaction), `listAll()`, `deleteUpload(hash)`, `deleteCutout(assetId)`.
- On mount: restore every cutout and create one blob URL per item for the session (the preview original too).
- On upload: hash first; if the hash exists, **skip processing**, show "Already in your library — N characters" and select that upload's characters.
- Delete: removes from IndexedDB and the UI only (never revoke spawned URLs).
- If IndexedDB is unavailable (private mode, quota), fall back to in-memory state and show a small notice; the rest of the app must keep working.
- Demo objects are not stored.

**2. Group photo → separate characters** (`src/lib/segmentPeople.ts`, plus changes in `removeBackground.ts`)
- Preload both models in the background when the panel mounts (imgly via existing `preloadModel`, MediaPipe via a similar cached promise). Show real progress for imgly as today, and a "Detecting people…" phase.
- Pipeline for each upload:
  1. Downscale to ≤ 2048 px on the longest side (existing logic).
  2. Run in parallel on the **same downscaled image**: imgly background removal returning the **untrimmed, full-frame** RGBA, and MediaPipe pose detection.
  3. For every foreground pixel (imgly alpha > 8): assign it to the person whose mask value is highest if that value ≥ 0.2; otherwise to the person whose landmark bounding box (expanded by 8%) contains it and whose torso centre (mean of shoulders + hips) is nearest; otherwise mark it "leftover".
  4. Per person: keep connected pieces ≥ 2% of that person's pixel area (removes speckles). Leftover connected pieces ≥ 3% of all foreground pixels become extra `kind: 'object'` cutouts; smaller leftovers are dropped.
  5. Trim transparent padding per cutout, encode PNG, convert landmarks to cutout-normalised `pose` (formula above).
  6. Close every `MPMask` and the result.
- Fallback when pose detection fails or finds **0 or 1** people: split the imgly cutout into connected pieces (8-connectivity; pieces ≥ 3% of foreground). One piece = one cutout exactly like Phase 1; attach `kind: 'person'` + `pose` if exactly one person was detected.
- Naming: `<file name without extension> · Person 1..N`, numbered left to right (`· Object 1..M` for leftovers). A single cutout keeps the file name.
- Performance: keep the per-pixel work in typed arrays; it is fine to run the assignment on a ≤ 1024 px grid and upscale labels. Target < 3 s after the models are loaded.
- UI: after processing, show **"Found N characters"** with the original photo and a coloured overlay/outline per character, and character cards below. Selecting a card previews it. **"Bring all to life"** spawns every character of the group (fresh `id` each, ~120 ms stagger). Spawned assets carry `kind` and `pose`.

**3. Whole-app redesign** (`App.tsx` / `App.css` / studio files)
- App shell:
  - Top bar (56 px): brand mark (gradient tile with an icon), "PhysicsLab" wordmark, tagline "Photo → Physics". Optional right side: a small "AI ready" status.
  - Body: a **studio sidebar** (400–420 px, its own vertical scroll) and the **physics stage** filling the rest — the physics world is the hero.
  - Below 1100 px: stack (studio on top, stage ≥ 480 px tall).
- Studio restructure:
  - Tabs: **Create** (drop zone, preview with before/after toggle and background swatches, "Found N characters" result) and **Library** (persistent grid grouped by upload: group header with original thumbnail + count, cards with thumbnail/name/size, delete, per-item spawn, per-group "Bring all").
  - Sticky bottom action bar in the sidebar: size slider + primary **Bring to Life** button (and "Bring all" when a group is selected).
  - Keep "Try Demo Objects" (secondary button in Create or Library).
- Look and feel:
  - Use the tokens in `src/index.css` only (Phase 1 names + Phase 2 additions: `--surface-3`, `--border-strong`, `--text-2`, `--accent-pink`, `--success`, `--warning`, `--accent-gradient`, `--glass-bg`, `--glass-blur`, `--radius-sm/lg/pill`, `--space-1..6`, `--fs-xs..2xl`, `--shadow-1/2`, `--glow-purple/cyan`, `--ease-out`, `--dur-fast`, `--dur`, `--font-sans`, `--font-mono`).
  - Minimum text size 11 px; 8 px spacing grid; consistent card style; fewer borders, more spacing.
  - Remove noise: the tiny uppercase eyebrows, the "STUDIO" pill, and the duplicated hints.
  - Micro-interactions: card hover lift, progress shimmer, subtle pulse on the primary CTA, skeleton placeholders while the library loads. Respect `prefers-reduced-motion`.
- Prefix all classes with `studio-` (shell classes in `App.css` may use `app-`).

**4. No regressions**
- Phase 1 behaviour keeps working: drag-and-drop + file picker, PNG/JPG/WebP only, 10 MB limit, progress + errors, before/after, white/black/transparent previews, download PNG, demo objects without the AI model, size slider, repeated spawns with new IDs.

### P1 — Only if time permits

- Per-character "exclude" toggle before saving a group.
- Library search/filter by name.
- A demo "person" PNG in `public/demo/` with a hand-authored `pose`, so Agent B's ragdoll can be shown without the model.

## Constraints

- No PhotoRoom code, logos, or assets. No secrets or API keys. No server or database beyond the browser's IndexedDB.
- Network: only the existing imgly model download. MediaPipe wasm comes from `node_modules` via Vite and the pose model from `public/models/`.
- Licences: `@imgly/background-removal` is AGPL-3.0 (see README); MediaPipe and its model are Apache-2.0.

## Acceptance criteria

1. Uploading a group photo of 3–5 people produces one cutout per person (plus optional object pieces), each spawnable individually and via "Bring all to life".
2. Person cutouts carry `kind: 'person'` and a 33-point `pose` aligned with the cutout.
3. A single-subject photo still produces one cutout (Phase 1 behaviour).
4. After a page reload the library is still there; re-uploading the same file skips processing.
5. Demo objects still work without the AI models.
6. The new shell + studio design is in place; the physics stage is the largest area.
7. `npm run build` and `npm run lint` pass.

## Delivery

Commit to `feat/p2-studio`, push the branch, and open a pull request to `master`. Report: implemented features, exact files changed, how to test, known limitations. Do not modify the other agent's files, even to fix an apparent integration issue — report it instead.

## Integration and merge

- Branch from the latest `master` (Phase 2 scaffold). Your branch only touches the files you own, so merging both PRs is conflict-free.
- After both PRs merge, one developer runs the end-to-end check on `master`: group photo → separate characters → Bring all → objects fall and interact (crumble / jelly / hang from Agent B); reload keeps the library; demo objects still spawn.
