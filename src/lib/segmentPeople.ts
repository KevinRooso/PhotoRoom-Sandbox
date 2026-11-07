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
const BBOX_EXPAND = 0.08;
const GRID_MAX = 1024;
const MIN_PERSON_PART = 0.02;
const MIN_PERSON_SHARE = 0.015;
const MIN_LEFTOVER_SHARE = 0.03;
const MIN_COMPONENT_SHARE = 0.03;
const CROP_PADDING = 2;

const LEFTOVER = -1;
const DISCARDED = -2;

interface PersonDetection {
  landmarks: NormalizedLandmark[];
  mask: Float32Array;
  maskWidth: number;
  maskHeight: number;
  bbox: { left: number; top: number; right: number; bottom: number };
  torsoX: number;
  torsoY: number;
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

export function preloadPoseModel(): Promise<void> {
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
  return landmarkerPromise.then(() => undefined);
}

function decodeToImageData(
  blob: Blob,
  width: number,
  height: number,
): Promise<{ imageData: ImageData; source: CanvasImageSource; close?: () => void }> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob).then((bitmap) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Could not inspect the image.');
      context.drawImage(bitmap, 0, 0, width, height);
      return {
        imageData: context.getImageData(0, 0, width, height),
        source: bitmap,
        close: () => bitmap.close(),
      };
    });
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        reject(new Error('Could not inspect the image.'));
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      resolve({
        imageData: context.getImageData(0, 0, width, height),
        source: image,
      });
    };
    image.onerror = () => reject(new Error('Could not decode the image.'));
    image.src = URL.createObjectURL(blob);
  });
}

async function detectPeople(source: CanvasImageSource): Promise<PersonDetection[]> {
  const landmarker = await (landmarkerPromise ?? preloadPoseModel().then(() => landmarkerPromise!));
  const result = landmarker.detect(source as HTMLCanvasElement);

  try {
    const detections: PersonDetection[] = [];
    const masks = result.segmentationMasks ?? [];

    for (let i = 0; i < result.landmarks.length; i += 1) {
      const landmarks = result.landmarks[i];
      if (landmarks.length === 0) continue;

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
      const expandX = width * BBOX_EXPAND;
      const expandY = height * BBOX_EXPAND;
      const torsoX =
        (landmarks[11].x + landmarks[12].x + landmarks[23].x + landmarks[24].x) / 4;
      const torsoY =
        (landmarks[11].y + landmarks[12].y + landmarks[23].y + landmarks[24].y) / 4;

      detections.push({
        landmarks,
        mask: masks[i] ? masks[i].getAsFloat32Array() : new Float32Array(0),
        maskWidth: masks[i]?.width ?? 0,
        maskHeight: masks[i]?.height ?? 0,
        bbox: {
          left: Math.max(0, left - expandX),
          top: Math.max(0, top - expandY),
          right: Math.min(1, right + expandX),
          bottom: Math.min(1, bottom + expandY),
        },
        torsoX,
        torsoY,
      });
    }
    return detections;
  } finally {
    result.close();
  }
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
): { regions: FinalRegion[]; survivingPeople: number } {
  const personCells = people.map(
    (_, personIndex) => grid.reduce((n, v) => n + (v === personIndex ? 1 : 0), 0),
  );

  const surviving = new Set<number>();
  people.forEach((_, personIndex) => {
    if (personCells[personIndex] >= MIN_PERSON_SHARE * foregroundCells) {
      surviving.add(personIndex);
    }
  });

  const regions: FinalRegion[] = [];

  for (const personIndex of surviving) {
    const { compId, sizes } = labelComponents(grid, gw, gh, (v) => v === personIndex);
    const threshold = MIN_PERSON_PART * personCells[personIndex];
    for (const [comp, size] of sizes) {
      if (size < threshold) continue;
      const labelId = regions.length;
      regions.push({ labelId, kind: 'person', personIndex });
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

  return { regions, survivingPeople: surviving.size };
}

function fallbackRegions(
  grid: Int32Array,
  gw: number,
  gh: number,
  foregroundCells: number,
  people: PersonDetection[],
): { regions: FinalRegion[]; method: 'components' | 'single' } {
  const { compId, sizes } = labelComponents(grid, gw, gh, (v) => v === 0);
  const kept: number[] = [];
  for (const [comp, size] of sizes) {
    if (size >= MIN_COMPONENT_SHARE * foregroundCells) kept.push(comp);
  }

  if (kept.length <= 1) {
    for (let i = 0; i < gw * gh; i += 1) {
      grid[i] = grid[i] === 0 ? 0 : DISCARDED;
    }
    const personIndex = people.length === 1 ? 0 : -1;
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

  if (people.length === 1) {
    const person = people[0];
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
      regions[bestIndex].personIndex = 0;
    }
  }

  return { regions, method: 'components' };
}

interface CutoutPixels {
  canvas: HTMLCanvasElement;
  crop: CropRect;
}

function extractCutout(
  fg: ImageData,
  grid: Int32Array,
  gw: number,
  gh: number,
  labelId: number,
): CutoutPixels | null {
  const { width: w, height: h, data } = fg;
  const out = new Uint8ClampedArray(w * h * 4);
  let left = w;
  let top = h;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < h; y += 1) {
    const gy = Math.min(gh - 1, (y * gh) / h | 0);
    for (let x = 0; x < w; x += 1) {
      const gx = Math.min(gw - 1, (x * gw) / w | 0);
      if (grid[gy * gw + gx] !== labelId) continue;
      const idx = (y * w + x) * 4;
      out[idx] = data[idx];
      out[idx + 1] = data[idx + 1];
      out[idx + 2] = data[idx + 2];
      out[idx + 3] = data[idx + 3];
      if (data[idx + 3] > ALPHA_THRESHOLD) {
        if (x < left) left = x;
        if (y < top) top = y;
        if (x > right) right = x;
        if (y > bottom) bottom = y;
      }
    }
  }

  if (right < left || bottom < top) return null;

  const cropLeft = Math.max(0, left - CROP_PADDING);
  const cropTop = Math.max(0, top - CROP_PADDING);
  const cropRight = Math.min(w - 1, right + CROP_PADDING);
  const cropBottom = Math.min(h - 1, bottom + CROP_PADDING);
  const cropW = cropRight - cropLeft + 1;
  const cropH = cropBottom - cropTop + 1;

  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = w;
  fullCanvas.height = h;
  const fullContext = fullCanvas.getContext('2d');
  if (!fullContext) throw new Error('Could not build the cutout image.');
  fullContext.putImageData(new ImageData(out, w, h), 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not crop the cutout image.');
  context.drawImage(fullCanvas, cropLeft, cropTop, cropW, cropH, 0, 0, cropW, cropH);

  return { canvas, crop: { x: cropLeft, y: cropTop, width: cropW, height: cropH } };
}

export async function segmentPeople(
  file: Blob,
  onProgress?: (p: RemovalProgress) => void,
): Promise<SegmentResult> {
  const prepared = await prepareImage(file);
  const { width: w, height: h } = prepared;

  const decoded = await decodeToImageData(prepared.blob, w, h);

  let fg: ImageData;
  let people: PersonDetection[] = [];

  try {
    const poseSource = decoded.source;
    const detectTask = (async () => {
      try {
        return await detectPeople(poseSource);
      } catch (error) {
        console.warn('Pose detection failed; continuing without people.', error);
        return [] as PersonDetection[];
      }
    })();

    const [fgResult] = await Promise.all([
      removeBackgroundFullFrame(prepared.blob, onProgress),
      detectTask,
    ]);
    fg = fgResult;
    people = await detectTask;

    onProgress?.({ phase: 'detecting', ratio: 0, label: 'Detecting people…' });
  } finally {
    decoded.close?.();
  }

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

          let bestPerson = -1;
          let bestValue = MASK_THRESHOLD;
          const candidates: number[] = [];

          for (let p = 0; p < people.length; p += 1) {
            const person = people[p];
            if (person.maskWidth > 0) {
              const mx = Math.min(person.maskWidth - 1, Math.floor(nx * person.maskWidth));
              const my = Math.min(person.maskHeight - 1, Math.floor(ny * person.maskHeight));
              const value = person.mask[my * person.maskWidth + mx];
              if (value >= bestValue) {
                bestValue = value;
                bestPerson = p;
              }
            }
            const b = person.bbox;
            if (nx >= b.left && nx <= b.right && ny >= b.top && ny <= b.bottom) {
              candidates.push(p);
            }
          }

          if (bestPerson >= 0) {
            grid[cell] = bestPerson;
            continue;
          }

          if (candidates.length > 0) {
            let nearest = candidates[0];
            let nearestDist = Infinity;
            for (const p of candidates) {
              const dx = (people[p].torsoX - nx) * gw;
              const dy = (people[p].torsoY - ny) * gh;
              const dist = dx * dx + dy * dy;
              if (dist < nearestDist) {
                nearestDist = dist;
                nearest = p;
              }
            }
            grid[cell] = nearest;
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
      const fallback = fallbackRegions(grid, gw, gh, foregroundCells, people);
      regions = fallback.regions;
      method = fallback.method;
    }
  }

  const produced: { region: FinalRegion; pixels: CutoutPixels }[] = [];
  for (const region of regions) {
    const pixels = extractCutout(fg, grid, gw, gh, region.labelId);
    if (pixels) produced.push({ region, pixels });
  }

  const peopleCutouts = produced
    .filter((p) => p.region.kind === 'person')
    .sort((a, b) => a.pixels.crop.x + a.pixels.crop.width / 2 - (b.pixels.crop.x + b.pixels.crop.width / 2));
  const objectCutouts = produced
    .filter((p) => p.region.kind === 'object')
    .sort((a, b) => a.pixels.crop.x + a.pixels.crop.width / 2 - (b.pixels.crop.x + b.pixels.crop.width / 2));

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
