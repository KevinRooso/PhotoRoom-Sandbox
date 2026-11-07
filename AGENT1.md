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
- Use the existing repository and installed dependencies.

## Git and file ownership

You own ONLY these files:

- `src/components/StudioPanel.tsx`
- `src/components/StudioPanel.css`
- `src/lib/removeBackground.ts`
- `public/demo/` for original demo SVG/PNG assets

Do not modify `App.tsx`, `package.json`, `package-lock.json`, shared types, or the physics component. Do not push directly to main.

## Integration contract

Import the existing `CutoutAsset` interface from `src/types/asset.ts`.

Export a default React component:

`StudioPanel({ onSpawn }: { onSpawn: (asset: CutoutAsset) => void })`

When the user clicks "Bring to Life", call `onSpawn(asset)`.

Every spawn event MUST have a fresh unique ID, including when adding the same cutout repeatedly. Preserve the image's original dimensions and a valid accessible URL.

## Features to implement

### P0 — Required

**1. Image upload**
- Drag-and-drop image upload.
- File picker.
- Accept PNG, JPG, and WebP.
- Validate unsupported files and excessive file sizes.
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
- Provide "Try Demo Objects" so the playground is usable even if AI background removal fails.
- Ensure the demo objects can be spawned through the same integration contract.

### P1 — Only if time permits

- Automatically trim transparent padding around cutouts.
- Simple size slider to control initial spawn size.
- More polished micro-interactions and processing animations.

## Design direction

Use a dark professional editor aesthetic with purple/cyan accents.

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
- First-run background removal may require loading model files, so show a meaningful loading state.
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

Commit to `feat/photo-editor`, push the branch, and create a pull request to main.

Report:
- Implemented features
- Exact files changed
- How to test
- Known limitations

Do not modify the other agent's files, even to fix an apparent integration issue. Report the issue instead.