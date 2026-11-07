import { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { PoseKeypoint } from '../types/asset';
import type { CropRect } from './library';
import type { RemovalProgress } from './removeBackground';
import { encodePng, prepareImage, removeBackgroundFullFrame } from './removeBackground';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

export interface SegmentedCutout {
  blob: Blob;
  width: number;
  height: number;
  kind: 'person' | 'object';
  pose?: PoseKeypoint[];
  crop: CropRect;
  label: string;
}

export interface SegmentResult {
  original: { blob: Blob; width: number; height: number };
  cutouts: SegmentedCutout[];
  peopleDetected: number;
  method: 'pose' | 'components' | 'single';
}

const MODEL_PATH = '/models/pose_landmarker_lite.task';
const ALPHA_THRESHOLD = 8;
const MASK_THRESHOLD = 0.2;
const LOW_MASK_THRESHOLD = 0.05;
const BBOX_EXPAND = 0.08;
const GRID_MAX = 1024;
const MIN_PERSON_PART = 0.02;
const MIN_PERSON_SHARE = 0.015;
const MIN_LEFTOVER_SHARE = 0.03;
const MIN_COMPONENT_SHARE = 0.03;
const CROP_PADDING = 2;
const TILE_ASPECT = 1.3;
const TILE_STRIDE = 0.5;
const MAX_PEOPLE = 12;
const TORSO_DIST_FACTOR = 0.6;
const MIN_TORSO_DIST = 0.03;

const LEFTOVER = -1;
const DISCARDED = -2;

interface NormRect {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

interface PersonDetection {
  landmarks: NormalizedLandmark[];
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
  rect: NormRect;
  bbox: { left: number; top: number; right: number; bottom: number };
  torsoX: number;
  torsoY: number;
  torsoMeanVisibility: number;
  shoulderPx: number;
  fromTile: boolean;
}

interface FinalRegion {
  labelId: number;
  kind: 'person' | 'object';
  personIndex: number;
}

let landmarkerPromise: Promise<PoseLandmarker> | undefined;

function createLandmarker(delegate: 'GPU' | 'CPU'): Promise<PoseLandmarker> {
  return PoseLandmarker.createFromOptions(
    { wasmLoaderPath, wasmBinaryPath },
    {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
      runningMode: 'IMAGE',
      numPoses: 8,
      minPoseDetectionConfidence: 0.35,
      minPosePresenceConfidence: 0.35,
      outputSegmentationMasks: true,
    },
  );
}

function getLandmarker(): Promise<PoseLandmarker> {
  landmarkerPromise ??= (async () => {
    try {
      return await createLandmarker('GPU');
    } catch {
      return await createLandmarker('CPU');
    }
  })().then(
    (landmarker) => landmarker,
    (error) => {
      landmarkerPromise = undefined;
      throw error;
    },
  );
  return landmarkerPromise;
}

export function preloadPoseModel(): Promise<void> {
  return getLandmarker().then(() => undefined);
}

interface DecodedSource {
  source: CanvasImageSource;
  close?: () => void;
}

function decodeSource(blob: Blob): Promise<DecodedSource> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob).then((bitmap) => ({
      source: bitmap,
      close: () => bitmap.close(),
    }));
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ source: image });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode the image.'));
    };
    image.src = url;
  });
}

interface RawDetection {
  landmarks: NormalizedLandmark[];
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
  rect: NormRect;
}

function collectDetections(
  result: ReturnType<PoseLandmarker['detect']>,
  rect: NormRect,
  scaleX: number,
  scaleY: number,
): RawDetection[] {
  const detections: RawDetection[] = [];
  try {
    const masks = result.segmentationMasks ?? [];
    for (let i = 0; i < result.landmarks.length; i += 1) {
      const landmarks = result.landmarks[i];
      if (landmarks.length === 0) continue;
      detections.push({
        landmarks: landmarks.map((lm) => ({
          x: rect.x0 + lm.x * scaleX,
          y: rect.y0 + lm.y * scaleY,
          z: lm.z,
          visibility: lm.visibility,
          presence: lm.presence,
        })),
        mask: masks[i] ? masks[i].getAsFloat32Array() : new Float32Array(0),
        maskWidth: masks[i]?.width ?? 0,
        maskHeight: masks[i]?.height ?? 0,
        rect,
      });
    }
  } finally {
    result.close();
  }
  return detections;
}

function toPersonDetection(raw: RawDetection, w: number, h: number, fromTile: boolean): PersonDetection {
  const { landmarks } = raw;
  let left = 1;
  let top = 1;
  let right = 0;
  let bottom = 0;
  for (const lm of landmarks) {
    left = Math.min(left, lm.x);
    top = Math.min(top, lm.y);
    right = Math.max(right, lm.x);
    bottom = Math.max(bottom, lm.y);
  }
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const torsoX = (landmarks[11].x + landmarks[12].x + landmarks[23].x + landmarks[24].x) / 4;
  const torsoY = (landmarks[11].y + landmarks[12].y + landmarks[23].y + landmarks[24].y) / 4;
  const torsoMeanVisibility =
    (landmarks[11].visibility +
      landmarks[12].visibility +
      landmarks[23].visibility +
      landmarks[24].visibility) / 4;
  const shoulderPx = Math.hypot(
    (landmarks[11].x - landmarks[12].x) * w,
    (landmarks[11].y - landmarks[12].y) * h,
  );
  return {
    ...raw,
    bbox: {
      left: Math.max(0, left - width * BBOX_EXPAND),
      top: Math.max(0, top - height * BBOX_EXPAND),
      right: Math.min(1, right + width * BBOX_EXPAND),
      bottom: Math.min(1, bottom + height * BBOX_EXPAND),
    },
    torsoX,
    torsoY,
    torsoMeanVisibility,
    shoulderPx,
    fromTile,
  };
}

async function detectPeople(
  source: CanvasImageSource,
  w: number,
  h: number,
): Promise<{ people: PersonDetection[]; fullCount: number; tileCount: number }> {
  const landmarker = await getLandmarker();
  const raws: { det: RawDetection; fromTile: boolean }[] = [];

  const fullResult = landmarker.detect(source as HTMLCanvasElement);
  const fullDetections = collectDetections(fullResult, { x0: 0, y0: 0, w: 1, h: 1 }, 1, 1);
  for (const det of fullDetections) raws.push({ det, fromTile: false });

  let tileCount = 0;
  const aspect = Math.max(w, h) / Math.min(w, h);
  if (aspect >= TILE_ASPECT) {
    const horizontal = w >= h;
    const s = Math.min(w, h);
    const span = Math.max(w, h);
    const positions: number[] = [];
    for (let p = 0; p + s <= span; p += Math.round(s * TILE_STRIDE)) positions.push(p);
    const last = span - s;
    if (positions.length === 0 || positions[positions.length - 1] !== last) positions.push(last);

    for (const pos of positions) {
      const tx = horizontal ? pos : 0;
      const ty = horizontal ? 0 : pos;
      const tile = document.createElement('canvas');
      tile.width = s;
      tile.height = s;
      const ctx = tile.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(source as CanvasImageSource, tx, ty, s, s, 0, 0, s, s);
      const rect: NormRect = { x0: tx / w, y0: ty / h, w: s / w, h: s / h };
      const result = landmarker.detect(tile);
      const detections = collectDetections(result, rect, rect.w, rect.h);
      tileCount += detections.length;
      for (const det of detections) raws.push({ det, fromTile: true });
    }
  }

  const merged: PersonDetection[] = [];
  for (const { det, fromTile } of raws) {
    const person = toPersonDetection(det, w, h, fromTile);
    let duplicate = -1;
    for (let i = 0; i < merged.length; i += 1) {
      const other = merged[i];
      const dist = Math.hypot(
        (person.torsoX - other.torsoX) * w,
        (person.torsoY - other.torsoY) * h,
      );
      const limit =
        TORSO_DIST_FACTOR *
        Math.max(person.shoulderPx, other.shoulderPx, MIN_TORSO_DIST * Math.min(w, h));
      if (dist < limit) {
        duplicate = i;
        break;
      }
    }
    if (duplicate === -1) {
      merged.push(person);
    } else {
      const existing = merged[duplicate];
      const preferNew =
        person.torsoMeanVisibility > existing.torsoMeanVisibility ||
        (person.torsoMeanVisibility === existing.torsoMeanVisibility &&
          person.fromTile &&
          !existing.fromTile);
      if (preferNew) merged[duplicate] = person;
    }
  }

  return {
    people: merged.slice(0, MAX_PEOPLE),
    fullCount: fullDetections.length,
    tileCount,
  };
}

function labelComponents(
  grid: Int32Array,
  gw: number,
  gh: number,
  match: (label: number) => boolean,
): { compId: Int32Array; sizes: Map<number, number> } {
  const compId = new Int32Array(gw * gh).fill(-1);
  const sizes = new Map<number, number>();
  const stack = new Int32Array(gw * gh);
  let next = 0;

  for (let start = 0; start < gw * gh; start += 1) {
    if (compId[start] !== -1 || !match(grid[start])) continue;
    let top = 0;
    let count = 0;
    compId[start] = next;
    stack[top] = start;
    top += 1;

    while (top > 0) {
      top -= 1;
      const cell = stack[top];
      count += 1;
      const cx = cell % gw;
      const cy = (cell - cx) / gw;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const neighbor = ny * gw + nx;
          if (compId[neighbor] !== -1 || !match(grid[neighbor])) continue;
          compId[neighbor] = next;
          stack[top] = neighbor;
          top += 1;
        }
      }
    }
    sizes.set(next, count);
    next += 1;
  }
  return { compId, sizes };
}

function buildRegions(
  grid: Int32Array,
  gw: number,
  gh: number,
  foregroundCells: number,
  people: PersonDetection[],
): { regions: FinalRegion[]; survivingPeople: number; survivorIdxs: number[] } {
  const personCells = people.map(
    (_, personIndex) => grid.reduce((n, v) => n + (v === personIndex ? 1 : 0), 0),
  );

  const survivorIdxs = people
    .map((_, i) => i)
    .filter((i) => personCells[i] >= MIN_PERSON_SHARE * foregroundCells);

  const regions: FinalRegion[] = [];

  for (const personIndex of survivorIdxs) {
    const { compId, sizes } = labelComponents(grid, gw, gh, (v) => v === personIndex);
    const threshold = MIN_PERSON_PART * personCells[personIndex];
    const labelId = regions.length;
    regions.push({ labelId, kind: 'person', personIndex });
    for (const [comp, size] of sizes) {
      if (size < threshold) continue;
      for (let i = 0; i < gw * gh; i += 1) {
        if (compId[i] === comp) grid[i] = labelId;
      }
    }
  }

  const { compId, sizes } = labelComponents(grid, gw, gh, (v) => v === LEFTOVER);
  for (const [comp, size] of sizes) {
    if (size < MIN_LEFTOVER_SHARE * foregroundCells) continue;
    const labelId = regions.length;
    regions.push({ labelId, kind: 'object', personIndex: -1 });
    for (let i = 0; i < gw * gh; i += 1) {
      if (compId[i] === comp) grid[i] = labelId;
    }
  }

  for (let i = 0; i < gw * gh; i += 1) {
    if (grid[i] < 0 && grid[i] !== DISCARDED) grid[i] = DISCARDED;
  }

  return { regions, survivingPeople: survivorIdxs.length, survivorIdxs };
}

function fallbackRegions(
  grid: Int32Array,
  gw: number,
  gh: number,
  foregroundCells: number,
  people: PersonDetection[],
  survivorIdxs: number[],
): { regions: FinalRegion[]; method: 'components' | 'single' } {
  const personIndex =
    survivorIdxs.length === 1
      ? survivorIdxs[0]
      : survivorIdxs.length === 0 && people.length === 1
        ? 0
        : -1;

  const { compId, sizes } = labelComponents(grid, gw, gh, (v) => v === 0);
  const kept: number[] = [];
  for (const [comp, size] of sizes) {
    if (size >= MIN_COMPONENT_SHARE * foregroundCells) kept.push(comp);
  }

  if (kept.length <= 1) {
    for (let i = 0; i < gw * gh; i += 1) {
      grid[i] = grid[i] === 0 ? 0 : DISCARDED;
    }
    return {
      regions: [{ labelId: 0, kind: personIndex === -1 ? 'object' : 'person', personIndex }],
      method: 'single',
    };
  }

  const regions: FinalRegion[] = [];
  const compToLabel = new Map<number, number>();
  for (const comp of kept) {
    compToLabel.set(comp, regions.length);
    regions.push({ labelId: regions.length, kind: 'object', personIndex: -1 });
  }
  for (let i = 0; i < gw * gh; i += 1) {
    const label = compToLabel.get(compId[i]);
    grid[i] = label === undefined ? DISCARDED : label;
  }

  if (personIndex >= 0) {
    const person = people[personIndex];
    const tx = person.torsoX * gw;
    const ty = person.torsoY * gh;
    const torsoCell =
      Math.min(gh - 1, Math.max(0, Math.floor(ty))) * gw +
      Math.min(gw - 1, Math.max(0, Math.floor(tx)));
    const torsoLabel = grid[torsoCell];

    let bestIndex = -1;
    if (torsoLabel >= 0) {
      bestIndex = torsoLabel;
    } else {
      const bounds = regions.map(() => ({ sx: 0, sy: 0, n: 0 }));
      for (let y = 0; y < gh; y += 1) {
        for (let x = 0; x < gw; x += 1) {
          const label = grid[y * gw + x];
          if (label < 0) continue;
          bounds[label].sx += x;
          bounds[label].sy += y;
          bounds[label].n += 1;
        }
      }
      let bestDist = Infinity;
      for (let i = 0; i < regions.length; i += 1) {
        const b = bounds[i];
        if (b.n === 0) continue;
        const dx = b.sx / b.n - tx;
        const dy = b.sy / b.n - ty;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
      }
    }
    if (bestIndex >= 0) {
      regions[bestIndex].kind = 'person';
      regions[bestIndex].personIndex = personIndex;
    }
  }

  return { regions, method: 'components' };
}

function extractCutout(
  fg: ImageData,
  grid: Int32Array,
  gw: number,
  gh: number,
  labelId: number,
): { canvas: HTMLCanvasElement; crop: CropRect } | null {
  const { width: w, height: h, data } = fg;

  let gxMin = gw;
  let gyMin = gh;
  let gxMax = -1;
  let gyMax = -1;
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      if (grid[gy * gw + gx] !== labelId) continue;
      if (gx < gxMin) gxMin = gx;
      if (gy < gyMin) gyMin = gy;
      if (gx > gxMax) gxMax = gx;
      if (gy > gyMax) gyMax = gy;
    }
  }
  if (gxMax < gxMin || gyMax < gyMin) return null;

  const cellW = w / gw;
  const cellH = h / gh;
  const x0 = Math.max(0, Math.floor(gxMin * cellW - cellW));
  const y0 = Math.max(0, Math.floor(gyMin * cellH - cellH));
  const x1 = Math.min(w, Math.ceil((gxMax + 1) * cellW + cellW));
  const y1 = Math.min(h, Math.ceil((gyMax + 1) * cellH + cellH));
  const rw = x1 - x0;
  const rh = y1 - y0;

  const out = new Uint8ClampedArray(rw * rh * 4);
  let left = rw;
  let top = rh;
  let right = -1;
  let bottom = -1;

  for (let y = y0; y < y1; y += 1) {
    const gy = Math.min(gh - 1, (y * gh) / h | 0);
    const rowGrid = gy * gw;
    for (let x = x0; x < x1; x += 1) {
      const gx = Math.min(gw - 1, (x * gw) / w | 0);
      if (grid[rowGrid + gx] !== labelId) continue;
      const src = (y * w + x) * 4;
      const dst = ((y - y0) * rw + (x - x0)) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
      if (data[src + 3] > ALPHA_THRESHOLD) {
        const lx = x - x0;
        const ly = y - y0;
        if (lx < left) left = lx;
        if (ly < top) top = ly;
        if (lx > right) right = lx;
        if (ly > bottom) bottom = ly;
      }
    }
  }
  if (right < left || bottom < top) return null;

  const cropLeft = Math.max(0, left - CROP_PADDING);
  const cropTop = Math.max(0, top - CROP_PADDING);
  const cropRight = Math.min(rw - 1, right + CROP_PADDING);
  const cropBottom = Math.min(rh - 1, bottom + CROP_PADDING);
  const cropW = cropRight - cropLeft + 1;
  const cropH = cropBottom - cropTop + 1;

  const rectCanvas = document.createElement('canvas');
  rectCanvas.width = rw;
  rectCanvas.height = rh;
  const rectContext = rectCanvas.getContext('2d');
  if (!rectContext) throw new Error('Could not build the cutout image.');
  rectContext.putImageData(new ImageData(out, rw, rh), 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not crop the cutout image.');
  context.drawImage(rectCanvas, cropLeft, cropTop, cropW, cropH, 0, 0, cropW, cropH);

  return {
    canvas,
    crop: { x: x0 + cropLeft, y: y0 + cropTop, width: cropW, height: cropH },
  };
}

export async function segmentPeople(
  file: Blob,
  onProgress?: (p: RemovalProgress) => void,
): Promise<SegmentResult> {
  const prepared = await prepareImage(file);
  const { width: w, height: h } = prepared;

  const decoded = await decodeSource(prepared.blob);

  let fg: ImageData;
  let people: PersonDetection[] = [];
  let fullCount = 0;
  let tileCount = 0;

  try {
    const poseSource = decoded.source;
    const detectTask = (async () => {
      try {
        return await detectPeople(poseSource, w, h);
      } catch (error) {
        console.warn('Pose detection failed; continuing without people.', error);
        return { people: [] as PersonDetection[], fullCount: 0, tileCount: 0 };
      }
    })();

    fg = await removeBackgroundFullFrame(prepared.blob, onProgress);

    onProgress?.({ phase: 'detecting', ratio: 0, label: 'Detecting people…' });
    const detection = await detectTask;
    people = detection.people;
    fullCount = detection.fullCount;
    tileCount = detection.tileCount;
  } finally {
    decoded.close?.();
  }

  console.debug(
    `[segmentPeople] detections full=${fullCount} tiles=${tileCount} merged=${people.length}` +
      ` masks=${people.map((p) => `${p.maskWidth}x${p.maskHeight}@${p.rect.w.toFixed(2)}x${p.rect.h.toFixed(2)}`).join(',')}`,
  );

  onProgress?.({ phase: 'separating', ratio: 0, label: 'Separating characters…' });

  const scale = Math.min(1, GRID_MAX / Math.max(w, h));
  const gw = Math.max(1, Math.round(w * scale));
  const gh = Math.max(1, Math.round(h * scale));
  const grid = new Int32Array(gw * gh).fill(DISCARDED);
  let foregroundCells = 0;

  for (let gy = 0; gy < gh; gy += 1) {
    const fy = Math.min(h - 1, (gy * h) / gh | 0);
    for (let gx = 0; gx < gw; gx += 1) {
      const fx = Math.min(w - 1, (gx * w) / gw | 0);
      const alpha = fg.data[(fy * w + fx) * 4 + 3];
      if (alpha > ALPHA_THRESHOLD) {
        grid[gy * gw + gx] = LEFTOVER;
        foregroundCells += 1;
      }
    }
  }

  let regions: FinalRegion[] = [];
  let method: SegmentResult['method'] = 'pose';

  if (foregroundCells === 0) {
    method = 'single';
  } else {
    if (people.length > 0) {
      for (let gy = 0; gy < gh; gy += 1) {
        const ny = (gy + 0.5) / gh;
        for (let gx = 0; gx < gw; gx += 1) {
          const cell = gy * gw + gx;
          if (grid[cell] !== LEFTOVER) continue;
          const nx = (gx + 0.5) / gw;

          let maxPerson = -1;
          let maxValue = 0;
          const candidates: number[] = [];
          const noMaskCandidates: number[] = [];

          for (let p = 0; p < people.length; p += 1) {
            const person = people[p];
            const r = person.rect;
            if (
              person.maskWidth > 0 &&
              nx >= r.x0 &&
              nx <= r.x0 + r.w &&
              ny >= r.y0 &&
              ny <= r.y0 + r.h
            ) {
              const lx = (nx - r.x0) / r.w;
              const ly = (ny - r.y0) / r.h;
              const mx = Math.min(person.maskWidth - 1, Math.floor(lx * person.maskWidth));
              const my = Math.min(person.maskHeight - 1, Math.floor(ly * person.maskHeight));
              const value = person.mask[my * person.maskWidth + mx];
              if (value > maxValue) {
                maxValue = value;
                maxPerson = p;
              }
            }
            const b = person.bbox;
            if (nx >= b.left && nx <= b.right && ny >= b.top && ny <= b.bottom) {
              candidates.push(p);
              if (person.maskWidth === 0) noMaskCandidates.push(p);
            }
          }

          const nearestOf = (pool: number[]): number => {
            let nearest = -1;
            let nearestDist = Infinity;
            for (const p of pool) {
              const dx = (people[p].torsoX - nx) * gw;
              const dy = (people[p].torsoY - ny) * gh;
              const dist = dx * dx + dy * dy;
              if (dist < nearestDist) {
                nearestDist = dist;
                nearest = p;
              }
            }
            return nearest;
          };

          if (maxValue >= MASK_THRESHOLD) {
            grid[cell] = maxPerson;
          } else if (maxValue >= LOW_MASK_THRESHOLD) {
            grid[cell] = candidates.length > 0 ? nearestOf(candidates) : maxPerson;
          } else if (noMaskCandidates.length > 0) {
            grid[cell] = nearestOf(noMaskCandidates);
          }
        }
      }
    }

    const built = buildRegions(grid, gw, gh, foregroundCells, people);

    if (built.survivingPeople >= 2) {
      regions = built.regions;
      method = 'pose';
    } else {
      for (let i = 0; i < gw * gh; i += 1) {
        grid[i] = grid[i] === DISCARDED ? DISCARDED : 0;
      }
      const fallback = fallbackRegions(
        grid,
        gw,
        gh,
        foregroundCells,
        people,
        built.survivorIdxs,
      );
      regions = fallback.regions;
      method = fallback.method;
    }
  }

  const produced: { region: FinalRegion; pixels: { canvas: HTMLCanvasElement; crop: CropRect } }[] = [];
  for (const region of regions) {
    const pixels = extractCutout(fg, grid, gw, gh, region.labelId);
    if (pixels) produced.push({ region, pixels });
  }

  const centreX = (item: { pixels: { crop: CropRect } }) =>
    item.pixels.crop.x + item.pixels.crop.width / 2;
  const peopleCutouts = produced
    .filter((p) => p.region.kind === 'person')
    .sort((a, b) => centreX(a) - centreX(b));
  const objectCutouts = produced
    .filter((p) => p.region.kind === 'object')
    .sort((a, b) => centreX(a) - centreX(b));

  const single = peopleCutouts.length + objectCutouts.length === 1;
  const cutouts: SegmentedCutout[] = [];
  let peopleDetected = 0;

  for (const item of [...peopleCutouts, ...objectCutouts]) {
    const { region, pixels } = item;
    const blob = await encodePng(pixels.canvas);
    const isPerson = region.kind === 'person';
    if (isPerson) peopleDetected += 1;

    let pose: PoseKeypoint[] | undefined;
    if (isPerson && region.personIndex >= 0) {
      const person = people[region.personIndex];
      if (person && person.landmarks.length === 33) {
        pose = person.landmarks.map((lm) => ({
          x: (lm.x * w - pixels.crop.x) / pixels.crop.width,
          y: (lm.y * h - pixels.crop.y) / pixels.crop.height,
          visibility: lm.visibility,
        }));
      }
    }

    let label: string;
    if (single) {
      label = '';
    } else if (isPerson) {
      label = `Person ${peopleCutouts.indexOf(item) + 1}`;
    } else {
      label = `Object ${objectCutouts.indexOf(item) + 1}`;
    }

    cutouts.push({
      blob,
      width: pixels.canvas.width,
      height: pixels.canvas.height,
      kind: region.kind,
      pose,
      crop: pixels.crop,
      label,
    });
  }

  return {
    original: { blob: prepared.blob, width: w, height: h },
    cutouts,
    peopleDetected,
    method,
  };
}
