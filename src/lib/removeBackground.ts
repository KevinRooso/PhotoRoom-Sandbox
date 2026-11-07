import { preload, removeBackground } from '@imgly/background-removal';
import type { Config } from '@imgly/background-removal';

export type RemovalPhase =
  | 'idle'
  | 'downloading-model'
  | 'processing'
  | 'done'
  | 'error';

export interface RemovalProgress {
  phase: RemovalPhase;
  ratio: number;
  label: string;
}

export interface CutoutResult {
  url: string;
  width: number;
  height: number;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2048;
const TRANSPARENCY_THRESHOLD = 8;
const CROP_PADDING = 2;

let activeProgressListener:
  | ((progress: RemovalProgress) => void)
  | undefined;

const sharedConfig: Config = {
  output: { format: 'image/png' },
  progress: (key, current, total) => {
    const keyType = key.toLowerCase();
    const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
    const percent = Math.round(ratio * 100);

    if (keyType.includes('fetch')) {
      activeProgressListener?.({
        phase: 'downloading-model',
        ratio,
        label: `Downloading AI model… ${percent}%`,
      });
    } else {
      activeProgressListener?.({
        phase: 'processing',
        ratio,
        label: `Removing background… ${percent}%`,
      });
    }
  },
};

let modelPreloadPromise: Promise<void> | undefined;

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

export function isSupportedImage(file: File): boolean {
  const acceptedMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];
  const type = file.type.trim().toLowerCase();

  if (type) return acceptedMimeTypes.includes(type);

  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return extension === 'png' || extension === 'jpg' || extension === 'jpeg' || extension === 'webp';
}

export function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return 'Image is too large (max 10 MB)';
  }

  if (!isSupportedImage(file)) {
    return 'Unsupported file type. Use PNG, JPG or WebP.';
  }

  return null;
}

export function preloadModel(): Promise<void> {
  modelPreloadPromise ??= preload(sharedConfig).catch((error) => {
    modelPreloadPromise = undefined;
    throw error;
  });
  return modelPreloadPromise;
}

export async function removeImageBackground(
  file: Blob,
  onProgress?: (progress: RemovalProgress) => void,
): Promise<CutoutResult> {
  const listener = onProgress;
  activeProgressListener = listener;

  try {
    const input = await downscaleIfNeeded(file);
    const result = await removeBackground(input, sharedConfig);
    const trimmed = await trimTransparentPadding(result);
    const url = URL.createObjectURL(trimmed.blob);

    onProgress?.({ phase: 'done', ratio: 1, label: 'Background removed' });
    return { url, width: trimmed.width, height: trimmed.height };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Could not remove the image background.';
    throw new Error(message || 'Could not remove the image background.');
  } finally {
    if (activeProgressListener === listener) activeProgressListener = undefined;
  }
}

export function getImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('Could not read image dimensions.'));
        return;
      }

      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => reject(new Error('Could not load image dimensions.'));
    image.src = url;
  });
}

async function downscaleIfNeeded(file: Blob): Promise<Blob> {
  const image = await decodeImage(file);

  try {
    const longestSide = Math.max(image.width, image.height);
    if (longestSide <= MAX_IMAGE_SIDE) return file;

    const scale = MAX_IMAGE_SIDE / longestSide;
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the image for processing.');

    context.drawImage(image.source, 0, 0, width, height);
    return await canvasToPng(canvas);
  } finally {
    image.close?.();
  }
}

async function trimTransparentPadding(
  blob: Blob,
): Promise<{ blob: Blob; width: number; height: number }> {
  const image = await decodeImage(blob);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not inspect the processed image.');

    context.drawImage(image.source, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let left = image.width;
    let top = image.height;
    let right = -1;
    let bottom = -1;

    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const alpha = pixels[(y * image.width + x) * 4 + 3];
        if (alpha > TRANSPARENCY_THRESHOLD) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    }

    if (right < left || bottom < top) {
      return { blob, width: image.width, height: image.height };
    }

    const cropLeft = Math.max(0, left - CROP_PADDING);
    const cropTop = Math.max(0, top - CROP_PADDING);
    const cropRight = Math.min(image.width - 1, right + CROP_PADDING);
    const cropBottom = Math.min(image.height - 1, bottom + CROP_PADDING);
    const width = cropRight - cropLeft + 1;
    const height = cropBottom - cropTop + 1;
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = width;
    cropCanvas.height = height;

    const cropContext = cropCanvas.getContext('2d');
    if (!cropContext) throw new Error('Could not crop the processed image.');

    cropContext.drawImage(
      image.source,
      cropLeft,
      cropTop,
      width,
      height,
      0,
      0,
      width,
      height,
    );

    return { blob: await canvasToPng(cropCanvas), width, height };
  } finally {
    image.close?.();
  }
}

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }

  const dataUrl = await blobToDataUrl(blob);
  const image = await loadImage(dataUrl);
  return { source: image, width: image.naturalWidth, height: image.naturalHeight };
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not encode the processed image.'));
      },
      'image/png',
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read the image.'));
    };
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the image.'));
    image.src = src;
  });
}
