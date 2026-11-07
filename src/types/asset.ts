/**
 * Shared contract between StudioPanel (photo editor) and PhysicsWorld (physics playground).
 * Owned by the base scaffold — do not edit on a feature branch.
 */

/**
 * One skeleton keypoint, normalised to the cutout image at `CutoutAsset.url`:
 * x = 0 is the left edge, x = 1 the right edge; y = 0 the top, y = 1 the bottom.
 * Points may fall slightly outside 0..1 (e.g. a hand that was trimmed off).
 */
export interface PoseKeypoint {
  x: number;
  y: number;
  /** Detector confidence that the point is visible, 0..1. Treat < 0.3 as unreliable. */
  visibility: number;
}

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
  /** Optional: what the cutout depicts. Omitted means unknown — treat it like 'object'. */
  kind?: 'person' | 'object';
  /**
   * Optional skeleton for person cutouts: exactly 33 keypoints in MediaPipe BlazePose order
   * (see POSE for the indices that matter for joints). Omitted when no skeleton was detected.
   */
  pose?: PoseKeypoint[];
}

export const DEFAULT_SPAWN_SIZE = 160;
export const MIN_SPAWN_SIZE = 40;
export const MAX_SPAWN_SIZE = 320;

/** Number of keypoints in a `CutoutAsset.pose` array. */
export const POSE_KEYPOINT_COUNT = 33;

/** BlazePose indices into `CutoutAsset.pose` used for ragdoll joints. L/R are the person's own left/right. */
export const POSE = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
  L_ANKLE: 27,
  R_ANKLE: 28,
} as const;
