import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import {
  ArrowDownToLine,
  Check,
  Image as ImageIcon,
  LoaderCircle,
  Rocket,
  Sparkles,
  Upload,
  WandSparkles,
} from 'lucide-react';
import {
  DEFAULT_SPAWN_SIZE,
  MAX_SPAWN_SIZE,
  MIN_SPAWN_SIZE,
  type CutoutAsset,
} from '../types/asset';
import {
  getImageSize,
  preloadModel,
  removeImageBackground,
  validateFile,
  type RemovalProgress,
} from '../lib/removeBackground';
import './StudioPanel.css';

export interface StudioPanelProps {
  onSpawn: (asset: CutoutAsset) => void;
}

interface LibraryItem {
  assetId: string;
  name: string;
  originalUrl: string | null;
  cutoutUrl: string;
  width: number;
  height: number;
  source: 'upload' | 'demo';
}

interface PendingPreview {
  originalUrl: string;
  name: string;
}

type PreviewBackground = 'checker' | 'white' | 'black';

const INITIAL_PROGRESS: RemovalProgress = {
  phase: 'idle',
  ratio: 0,
  label: '',
};

const clearFinishedProgress = (current: RemovalProgress): RemovalProgress =>
  current.phase === 'done' || current.phase === 'error' ? INITIAL_PROGRESS : current;

const DEMO_ITEMS = [
  { assetId: 'demo-rocket', name: 'Rocket', url: '/demo/rocket.svg' },
  { assetId: 'demo-duck', name: 'Rubber Duck', url: '/demo/duck.svg' },
  { assetId: 'demo-planet', name: 'Planet', url: '/demo/planet.svg' },
] as const;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export default function StudioPanel({ onSpawn }: StudioPanelProps) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<RemovalProgress>(INITIAL_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [bgMode, setBgMode] = useState<PreviewBackground>('checker');
  const [spawnSize, setSpawnSize] = useState(DEFAULT_SPAWN_SIZE);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<PendingPreview | null>(null);
  const [modelUnavailable, setModelUnavailable] = useState(false);
  const [isLoadingDemos, setIsLoadingDemos] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const loadingDemosRef = useRef(false);

  const selectedItem = items.find((item) => item.assetId === selectedId) ?? null;
  const currentPreviewUrl = pendingPreview
    ? pendingPreview.originalUrl
    : selectedItem && showOriginal && selectedItem.originalUrl
      ? selectedItem.originalUrl
      : selectedItem?.cutoutUrl ?? null;
  const currentPreviewName = pendingPreview?.name ?? selectedItem?.name ?? null;
  const isRemoving = progress.phase === 'downloading-model' || progress.phase === 'processing';

  useEffect(() => {
    mountedRef.current = true;
    void preloadModel().catch(() => {
      if (mountedRef.current) setModelUnavailable(true);
    });

    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);

  const handleFile = useCallback(async (file: File) => {
    const requestId = ++requestSequenceRef.current;
    const validationError = validateFile(file);

    if (validationError) {
      setError(validationError);
      setProgress(INITIAL_PROGRESS);
      return;
    }

    const originalUrl = URL.createObjectURL(file);
    setError(null);
    setShowOriginal(true);
    setSelectedId(null);
    setPendingPreview({ originalUrl, name: file.name });
    setProgress({
      phase: 'downloading-model',
      ratio: 0,
      label: 'Preparing image…',
    });

    try {
      const result = await removeImageBackground(file, (nextProgress) => {
        if (mountedRef.current && requestSequenceRef.current === requestId) {
          setProgress(nextProgress);
        }
      });

      if (!mountedRef.current || requestSequenceRef.current !== requestId) return;

      const item: LibraryItem = {
        assetId: newId(),
        name: file.name,
        originalUrl,
        cutoutUrl: result.url,
        width: result.width,
        height: result.height,
        source: 'upload',
      };
      setItems((currentItems) => [...currentItems, item]);
      setSelectedId(item.assetId);
      setPendingPreview(null);
      setShowOriginal(false);
      setError(null);
      setProgress({ phase: 'done', ratio: 1, label: 'Background removed' });
    } catch (removalError) {
      if (!mountedRef.current || requestSequenceRef.current !== requestId) return;

      setError(
        removalError instanceof Error
          ? removalError.message
          : 'Could not remove the image background. Please try again.',
      );
      setProgress({
        phase: 'error',
        ratio: 0,
        label: 'Background removal failed',
      });
    }
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDropZoneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFilePicker();
    }
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (file) void handleFile(file);
    event.currentTarget.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void handleFile(file);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setIsDragging(false);
    }
  };

  const spawnItem = useCallback((item: LibraryItem) => {
    const asset: CutoutAsset = {
      id: newId(),
      assetId: item.assetId,
      name: item.name,
      url: item.cutoutUrl,
      width: item.width,
      height: item.height,
      source: item.source,
      spawnSize,
    };
    onSpawn(asset);
  }, [onSpawn, spawnSize]);

  const handleLoadDemos = async () => {
    if (loadingDemosRef.current) return;

    loadingDemosRef.current = true;
    setIsLoadingDemos(true);
    setError(null);

    try {
      const demoItems: LibraryItem[] = await Promise.all(
        DEMO_ITEMS.map(async (demo) => {
          const dimensions = await getImageSize(demo.url);
          return {
            assetId: demo.assetId,
            name: demo.name,
            originalUrl: null,
            cutoutUrl: demo.url,
            width: dimensions.width,
            height: dimensions.height,
            source: 'demo',
          };
        }),
      );

      if (!mountedRef.current) return;

      setItems((currentItems) => {
        const existingIds = new Set(currentItems.map((item) => item.assetId));
        return [...currentItems, ...demoItems.filter((item) => !existingIds.has(item.assetId))];
      });
      setSelectedId(demoItems[0].assetId);
      setProgress(clearFinishedProgress);
      setPendingPreview(null);
      setShowOriginal(false);
      demoItems.forEach(spawnItem);
    } catch (demoError) {
      if (mountedRef.current) {
        setError(
          demoError instanceof Error
            ? demoError.message
            : 'Could not load the demo objects.',
        );
      }
    } finally {
      loadingDemosRef.current = false;
      if (mountedRef.current) setIsLoadingDemos(false);
    }
  };

  const handleDownload = () => {
    if (!selectedItem) return;

    const nameWithoutExtension = selectedItem.name.replace(/\.[^.]+$/, '');
    const anchor = document.createElement('a');
    anchor.href = selectedItem.cutoutUrl;
    const extension = selectedItem.source === 'demo'
      ? selectedItem.cutoutUrl.split('.').pop() ?? 'svg'
      : 'png';
    anchor.download = `${nameWithoutExtension}-cutout.${extension}`;
    anchor.click();
  };

  return (
    <div className="studio-panel">
      <header className="studio-header">
        <div className="studio-brand-icon" aria-hidden="true">
          <Sparkles size={20} />
        </div>
        <div className="studio-header-copy">
          <p className="studio-eyebrow">CREATIVE WORKSPACE</p>
          <h1>PhysicsLab — Photo Studio</h1>
        </div>
        <span className="studio-status-pill">
          <span className="studio-status-dot" />
          STUDIO
        </span>
      </header>

      <div className="studio-workspace">
        <div
          className={`studio-dropzone${isDragging ? ' studio-dropzone--dragging' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Upload an image. Drop a PNG, JPG, or WebP file here or choose a file."
          onClick={(event) => {
            if (event.target !== fileInputRef.current) openFilePicker();
          }}
          onKeyDown={handleDropZoneKeyDown}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            className="studio-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Choose a PNG, JPG, or WebP image"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onChange={handleFileInputChange}
          />
          <div className="studio-upload-icon">
            <Upload size={20} strokeWidth={1.8} />
          </div>
          <div className="studio-dropzone-copy">
            <strong>{isDragging ? 'Release to upload' : 'Drop a photo to get started'}</strong>
            <span>or click to browse your files</span>
          </div>
          <div className="studio-format-tags" aria-hidden="true">
            <span>PNG</span>
            <span>JPG</span>
            <span>WEBP</span>
          </div>
        </div>

        <section className="studio-preview-card" aria-label="Image preview">
          <div className="studio-section-heading">
            <div>
              <p className="studio-eyebrow">CANVAS</p>
              <h2>Preview</h2>
            </div>
            <button
              className={`studio-before-after${showOriginal ? ' studio-before-after--active' : ''}`}
              type="button"
              aria-label={showOriginal ? 'Show cutout preview' : 'Show original preview'}
              aria-pressed={showOriginal}
              disabled={!selectedItem?.originalUrl || Boolean(pendingPreview)}
              onClick={() => setShowOriginal((showing) => !showing)}
            >
              <ImageIcon size={15} />
              {showOriginal ? 'Before' : 'After'}
            </button>
          </div>

          <div
            className={`studio-preview-stage studio-preview-stage--${bgMode}`}
            aria-live="polite"
          >
            {currentPreviewUrl ? (
              <img
                id="studio-preview-image"
                className="studio-preview-image"
                src={currentPreviewUrl}
                alt={currentPreviewName ? `${currentPreviewName} preview` : 'Image preview'}
              />
            ) : (
              <div className="studio-preview-empty">
                <div className="studio-empty-art" aria-hidden="true">
                  <ImageIcon size={26} />
                  <span />
                </div>
                <strong>Your canvas is ready</strong>
                <span>Upload a photo or explore the demo objects</span>
              </div>
            )}
            {isRemoving && (
              <div className="studio-processing-indicator">
                <LoaderCircle size={14} className="studio-spin" />
                Removing background
              </div>
            )}
          </div>

          <div className="studio-preview-controls">
            <div className="studio-background-options" role="group" aria-label="Preview background">
              {([
                ['checker', 'Checkerboard'],
                ['white', 'White'],
                ['black', 'Black'],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  className={`studio-background-button studio-background-button--${mode}${bgMode === mode ? ' studio-background-button--selected' : ''}`}
                  type="button"
                  aria-label={`${label} background`}
                  aria-pressed={bgMode === mode}
                  onClick={() => setBgMode(mode)}
                >
                  <span className="studio-background-swatch" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <button
              className="studio-download-button"
              type="button"
              aria-label="Download cutout PNG"
              disabled={!selectedItem}
              onClick={handleDownload}
            >
              <ArrowDownToLine size={15} />
              <span>Download</span>
            </button>
          </div>
        </section>

        {isRemoving && (
          <div className="studio-progress-card">
            <div className="studio-progress-heading">
              <span className="studio-progress-label">{progress.label}</span>
              <span className="studio-progress-percent">{Math.round(progress.ratio * 100)}%</span>
            </div>
            <div
              className="studio-progress-track"
              role="progressbar"
              aria-label="Background removal progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.ratio * 100)}
              aria-valuetext={progress.label}
            >
              <span style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
            </div>
          </div>
        )}

        {progress.phase === 'done' && (
          <div className="studio-success-note" role="status">
            <Check size={15} />
            <span>{progress.label}</span>
          </div>
        )}

        {(error || modelUnavailable) && (
          <div className={`studio-alert${error ? ' studio-alert--error' : ''}`} role={error ? 'alert' : 'status'}>
            <span className="studio-alert-icon">
              <Sparkles size={16} />
            </span>
            <span>
              {error ?? 'AI model unavailable — demo objects still work'}
            </span>
          </div>
        )}

        <div className="studio-model-hint">
          <WandSparkles size={15} />
          <span>The AI model is a large one-time download. Your image stays in this browser.</span>
        </div>

        <section className="studio-library-section" aria-label="Asset library">
          <div className="studio-section-heading studio-library-heading">
            <div>
              <p className="studio-eyebrow">YOUR ASSETS</p>
              <h2>Library <span>{items.length}</span></h2>
            </div>
            <button
              className="studio-demo-button"
              type="button"
              onClick={() => void handleLoadDemos()}
              disabled={isLoadingDemos}
            >
              {isLoadingDemos ? (
                <LoaderCircle size={15} className="studio-spin" />
              ) : (
                <Rocket size={15} />
              )}
              Try Demo Objects
            </button>
          </div>

          {items.length > 0 ? (
            <div className="studio-asset-strip">
              {items.map((item) => (
                <button
                  key={item.assetId}
                  className={`studio-asset-card${selectedId === item.assetId ? ' studio-asset-card--selected' : ''}`}
                  type="button"
                  aria-label={`Select ${item.name}`}
                  aria-pressed={selectedId === item.assetId}
                  onClick={() => {
                    setSelectedId(item.assetId);
                    setProgress(clearFinishedProgress);
                    setPendingPreview(null);
                    setShowOriginal(false);
                    setError(null);
                  }}
                >
                  <span className="studio-asset-thumb studio-preview-stage--checker">
                    <img src={item.cutoutUrl} alt="" />
                  </span>
                  <span className="studio-asset-name">{item.name}</span>
                  <span className="studio-asset-dimensions">
                    {item.width} × {item.height}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="studio-library-empty">
              <span className="studio-library-empty-icon">
                <ImageIcon size={18} />
              </span>
              <span>Your cutouts will appear here</span>
            </div>
          )}
        </section>

        <section className="studio-spawn-section" aria-label="Spawn settings">
          <div className="studio-spawn-heading">
            <div>
              <p className="studio-eyebrow">PHYSICS PLAYGROUND</p>
              <h2>Object size</h2>
            </div>
            <span className="studio-size-value">{spawnSize}<small>px</small></span>
          </div>
          <label className="studio-slider-label" htmlFor="studio-spawn-size">
            <span>Small</span>
            <span>Large</span>
          </label>
          <input
            id="studio-spawn-size"
            className="studio-size-slider"
            type="range"
            min={MIN_SPAWN_SIZE}
            max={MAX_SPAWN_SIZE}
            step={10}
            value={spawnSize}
            onChange={(event) => setSpawnSize(Number(event.currentTarget.value))}
            aria-label="Spawn size"
          />
          <button
            className="studio-spawn-button"
            type="button"
            disabled={!selectedItem}
            onClick={() => selectedItem && spawnItem(selectedItem)}
          >
            <WandSparkles size={18} />
            <span>Bring to Life</span>
            <Sparkles size={16} className="studio-spawn-sparkle" />
          </button>
          <p className="studio-spawn-footnote">Each click creates a new object in the playground.</p>
        </section>
      </div>
    </div>
  );
}
