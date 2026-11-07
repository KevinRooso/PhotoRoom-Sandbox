/**
 * Shared contract between StudioPanel (photo editor) and PhysicsWorld (physics playground).
 * Owned by the base scaffold — do not edit on a feature branch.
 */
export interface CutoutAsset {
  /** Unique per spawn event. Generate a fresh crypto.randomUUID() on every "Bring to Life" click. */
  id: string;
  /** Stable id of the library item; identical across repeated spawns of the same cutout. */
  assetId: string;
  /** Human-readable label, e.g. the uploaded file name or "Rocket". */
  name: string;
  /** Transparent image URL: a blob: URL from background removal, or /demo/<file>. Must stay valid for the whole session. */
  url: string;
  /** Natural pixel width of the image at `url`. */
  width: number;
  /** Natural pixel height of the image at `url`. */
  height: number;
  source: 'upload' | 'demo';
  /** Optional max rendered dimension (px) of the physics body. PhysicsWorld uses DEFAULT_SPAWN_SIZE when omitted. */
  spawnSize?: number;
}

export const DEFAULT_SPAWN_SIZE = 160;
export const MIN_SPAWN_SIZE = 40;
export const MAX_SPAWN_SIZE = 320;
