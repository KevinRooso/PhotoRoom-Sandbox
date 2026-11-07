import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import {
  ArrowDownToLine,
  Check,
  Image as ImageIcon,
  Images,
  LoaderCircle,
  Rocket,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
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
  validateFile,
  type RemovalProgress,
} from '../lib/removeBackground';
import { segmentPeople, preloadPoseModel } from '../lib/segmentPeople';
import {
  hashFile,
  openLibrary,
  type CropRect,
  type StoredCutout,
  type StoredUpload,
} from '../lib/library';
import './StudioPanel.css';

export interface StudioPanelProps {
  onSpawn: (asset: CutoutAsset) => void;
}

interface Item {
  assetId: string;
  groupId: string;
  name: string;
  label: string;
  cutoutUrl: string;
  width: number;
  height: number;
  source: 'upload' | 'demo';
  kind?: 'person' | 'object';
  pose?: CutoutAsset['pose'];
}

interface Group {
  id: string;
  name: string;
  originalUrl: string | null;
  width: number;
  height: number;
  createdAt: number;
  assetIds: string[];
  crops: Record<string, CropRect>;
}

interface PendingPreview {
  originalUrl: string;
  name: string;
}

type PreviewBackground = 'checker' | 'white' | 'black';
type Tab = 'create' | 'library';
type AiStatus = 'loading' | 'ready' | 'unavailable';

const INITIAL_PROGRESS: RemovalProgress = { phase: 'idle', ratio: 0, label: '' };

const clearFinishedProgress = (current: RemovalProgress): RemovalProgress =>
  current.phase === 'done' || current.phase === 'error' ? INITIAL_PROGRESS : current;

const DEMO_ITEMS = [
  { assetId: 'demo-rocket', name: 'Rocket', url: '/demo/rocket.svg' },
  { assetId: 'demo-duck', name: 'Rubber Duck', url: '/demo/duck.svg' },
  { assetId: 'demo-planet', name: 'Planet', url: '/demo/planet.svg' },
] as const;

const CROP_COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00', '#bf5af2', '#ff9f0a', '#64d2ff', '#ff375f'];

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function displayName(item: Item, groups: Group[]): string {
  if (!item.label) return item.name;
  const group = groups.find((g) => g.id === item.groupId);
  return `${group ? baseName(group.name) : item.name} · ${item.label}`;
}

function relativeDate(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const PROCESSING_STEPS: { phases: RemovalProgress['phase'][]; label: string }[] = [
  { phases: ['downloading-model', 'processing'], label: 'Removing background' },
  { phases: ['detecting'], label: 'Detecting people' },
  { phases: ['separating'], label: 'Separating' },
];

export default function StudioPanel({ onSpawn }: StudioPanelProps) {
  const [tab, setTab] = useState<Tab>('create');
  const [items, setItems] = useState<Item[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<RemovalProgress>(INITIAL_PROGRESS);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [bgMode, setBgMode] = useState<PreviewBackground>('checker');
  const [spawnSize, setSpawnSize] = useState(DEFAULT_SPAWN_SIZE);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<PendingPreview | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus>('loading');
  const [poseUnavailable, setPoseUnavailable] = useState(false);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [libraryPersistent, setLibraryPersistent] = useState(true);
  const [isLoadingDemos, setIsLoadingDemos] = useState(false);
  const [confirmGroupId, setConfirmGroupId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const pendingOriginalUrlRef = useRef<string | null>(null);
  const requestSequenceRef = useRef(0);
  const activeRequestRef = useRef<number | null>(null);
  const loadingDemosRef = useRef(false);
  const storeRef = useRef<Awaited<ReturnType<typeof openLibrary>> | null>(null);
  const staggerTimersRef = useRef<number[]>([]);
  const confirmTimerRef = useRef<{ id: number | null }>({ id: null });
  const libraryReadyRef = useRef<Promise<void> | null>(null);
  const groupsRef = useRef<Group[]>([]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  const releasePendingOriginal = useCallback(() => {
    if (pendingOriginalUrlRef.current !== null) {
      URL.revokeObjectURL(pendingOriginalUrlRef.current);
      pendingOriginalUrlRef.current = null;
    }
  }, []);

  const selectedItem = items.find((item) => item.assetId === selectedId) ?? null;
  const selectedGroup = selectedItem
    ? groups.find((g) => g.id === selectedItem.groupId) ?? null
    : null;
  const isBusy =
    progress.phase === 'downloading-model' ||
    progress.phase === 'processing' ||
    progress.phase === 'detecting' ||
    progress.phase === 'separating';

  const selectItem = useCallback((assetId: string) => {
    if (activeRequestRef.current === null) releasePendingOriginal();
    setSelectedId(assetId);
    setProgress(clearFinishedProgress);
    setPendingPreview(null);
    setShowOriginal(false);
    setError(null);
    setNotice(null);
  }, [releasePendingOriginal]);

  useEffect(() => {
    mountedRef.current = true;

    preloadModel()
      .then(() => {
        if (mountedRef.current) setAiStatus('ready');
      })
      .catch(() => {
        if (mountedRef.current) setAiStatus('unavailable');
      });

    preloadPoseModel().catch(() => {
      if (mountedRef.current) setPoseUnavailable(true);
    });

    libraryReadyRef.current = (async () => {
      try {
        const store = await openLibrary();
        storeRef.current = store;
        const { uploads, cutouts } = await store.listAll();
        if (!mountedRef.current) return;

        const newGroups: Group[] = [];
        const newItems: Item[] = [];
        for (const upload of uploads) {
          const originalUrl = URL.createObjectURL(upload.originalBlob);
          const group: Group = {
            id: upload.hash,
            name: upload.name,
            originalUrl,
            width: upload.width,
            height: upload.height,
            createdAt: upload.createdAt,
            assetIds: [],
            crops: {},
          };
          for (const cutout of cutouts.filter((c) => c.uploadHash === upload.hash)) {
            if (!upload.assetIds.includes(cutout.assetId)) continue;
            group.assetIds.push(cutout.assetId);
            group.crops[cutout.assetId] = cutout.crop;
            newItems.push({
              assetId: cutout.assetId,
              groupId: upload.hash,
              name: cutout.name || upload.name,
              label: cutout.name,
              cutoutUrl: URL.createObjectURL(cutout.blob),
              width: cutout.width,
              height: cutout.height,
              source: 'upload',
              kind: cutout.kind,
              pose: cutout.pose,
            });
          }
          if (group.assetIds.length > 0) newGroups.push(group);
        }
        const order = new Map(uploads.map((u, i) => [u.hash, i]));
        newItems.sort(
          (a, b) =>
            (order.get(a.groupId) ?? 0) - (order.get(b.groupId) ?? 0) ||
            uploads
              .find((u) => u.hash === a.groupId)!
              .assetIds.indexOf(a.assetId) -
              uploads.find((u) => u.hash === b.groupId)!.assetIds.indexOf(b.assetId),
        );
        setGroups(newGroups);
        setItems(newItems);
        setLibraryPersistent(store.persistent);
      } catch {
        if (mountedRef.current) setLibraryPersistent(false);
      } finally {
        if (mountedRef.current) setLibraryLoaded(true);
      }
    })();

    const staggerTimers = staggerTimersRef.current;
    const confirmTimer = confirmTimerRef.current;

    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      releasePendingOriginal();
      staggerTimers.forEach((t) => clearTimeout(t));
      if (confirmTimer.id !== null) clearTimeout(confirmTimer.id);
    };
  }, [releasePendingOriginal]);

  const handleFile = useCallback(
    async (file: File) => {
      const requestId = ++requestSequenceRef.current;
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        setNotice(null);
        setProgress(INITIAL_PROGRESS);
        return;
      }

      activeRequestRef.current = requestId;
      releasePendingOriginal();
      const originalUrl = URL.createObjectURL(file);
      pendingOriginalUrlRef.current = originalUrl;
      setError(null);
      setNotice(null);
      setShowOriginal(true);
      setSelectedId(null);
      setPendingPreview({ originalUrl, name: file.name });
      setTab('create');
      setProgress({ phase: 'downloading-model', ratio: 0, label: 'Preparing image…' });

      try {
        const store = storeRef.current ?? (await openLibrary());
        storeRef.current = store;
        const hash = await hashFile(file);

        if (!mountedRef.current || requestSequenceRef.current !== requestId) return;

        await libraryReadyRef.current;
        if (!mountedRef.current || requestSequenceRef.current !== requestId) return;

        const existing = await store.findUpload(hash);
        if (existing) {
          const existingGroup = groupsRef.current.find((g) => g.id === hash);
          if (existingGroup && existingGroup.assetIds.length > 0) {
            releasePendingOriginal();
            selectItem(existingGroup.assetIds[0]);
            setNotice(`Already in your library — ${existingGroup.assetIds.length} characters`);
            setProgress(INITIAL_PROGRESS);
            return;
          }
          await store.deleteUpload(hash);
        }

        const result = await segmentPeople(file, (nextProgress) => {
          if (mountedRef.current && requestSequenceRef.current === requestId) {
            setProgress(nextProgress);
          }
        });

        if (!mountedRef.current || requestSequenceRef.current !== requestId) return;

        const cutouts: StoredCutout[] = result.cutouts.map((c) => ({
          assetId: newId(),
          uploadHash: hash,
          name: c.label,
          blob: c.blob,
          width: c.width,
          height: c.height,
          kind: c.kind,
          pose: c.pose,
          crop: c.crop,
          createdAt: Date.now(),
        }));
        const upload: StoredUpload = {
          hash,
          name: file.name,
          createdAt: Date.now(),
          originalBlob: result.original.blob,
          width: result.original.width,
          height: result.original.height,
          assetIds: cutouts.map((c) => c.assetId),
        };

        try {
          await store.saveUpload(upload, cutouts);
        } catch {
          if (mountedRef.current) {
            setNotice("Couldn't save to library — kept for this session");
          }
        }

        const group: Group = {
          id: hash,
          name: file.name,
          originalUrl: URL.createObjectURL(result.original.blob),
          width: result.original.width,
          height: result.original.height,
          createdAt: upload.createdAt,
          assetIds: upload.assetIds,
          crops: Object.fromEntries(cutouts.map((c) => [c.assetId, c.crop])),
        };
        const newItems: Item[] = cutouts.map((c) => ({
          assetId: c.assetId,
          groupId: hash,
          name: c.name || file.name,
          label: c.name,
          cutoutUrl: URL.createObjectURL(c.blob),
          width: c.width,
          height: c.height,
          source: 'upload',
          kind: c.kind,
          pose: c.pose,
        }));

        releasePendingOriginal();
        setPendingPreview(null);
        setShowOriginal(false);
        setGroups((current) => [group, ...current]);
        setItems((current) => [...newItems, ...current]);
        setSelectedId(newItems[0]?.assetId ?? null);
        setAiStatus('ready');
        setProgress({
          phase: 'done',
          ratio: 1,
          label:
            result.cutouts.length === 1
              ? 'Background removed'
              : `Found ${result.cutouts.length} characters`,
        });
      } catch (removalError) {
        if (!mountedRef.current || requestSequenceRef.current !== requestId) return;
        setError(
          removalError instanceof Error
            ? removalError.message
            : 'Could not remove the image background. Please try again.',
        );
        setProgress({ phase: 'error', ratio: 0, label: 'Background removal failed' });
      } finally {
        if (activeRequestRef.current === requestId) activeRequestRef.current = null;
      }
    },
    [releasePendingOriginal, selectItem],
  );

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

  const spawnItem = useCallback(
    (item: Item) => {
      const asset: CutoutAsset = {
        id: newId(),
        assetId: item.assetId,
        name: displayName(item, groups),
        url: item.cutoutUrl,
        width: item.width,
        height: item.height,
        source: item.source,
        spawnSize,
        ...(item.source === 'demo' ? {} : { kind: item.kind, pose: item.pose }),
      };
      onSpawn(asset);
    },
    [groups, onSpawn, spawnSize],
  );

  const spawnAll = useCallback(
    (groupId: string) => {
      const groupItems = items.filter((i) => i.groupId === groupId);
      groupItems.forEach((item, index) => {
        const timer = window.setTimeout(() => spawnItem(item), index * 120);
        staggerTimersRef.current.push(timer);
      });
    },
    [items, spawnItem],
  );

  const handleLoadDemos = async () => {
    if (loadingDemosRef.current) return;
    loadingDemosRef.current = true;
    setIsLoadingDemos(true);
    setError(null);

    try {
      const demoItems: Item[] = await Promise.all(
        DEMO_ITEMS.map(async (demo) => {
          const dimensions = await getImageSize(demo.url);
          return {
            assetId: demo.assetId,
            groupId: 'demo',
            name: demo.name,
            label: '',
            cutoutUrl: demo.url,
            width: dimensions.width,
            height: dimensions.height,
            source: 'demo' as const,
          };
        }),
      );

      if (!mountedRef.current) return;
      if (activeRequestRef.current === null) releasePendingOriginal();

      setGroups((current) =>
        current.some((g) => g.id === 'demo')
          ? current
          : [
              ...current,
              {
                id: 'demo',
                name: 'Demo objects',
                originalUrl: null,
                width: 0,
                height: 0,
                createdAt: Date.now(),
                assetIds: demoItems.map((d) => d.assetId),
                crops: {},
              },
            ],
      );
      setItems((current) => {
        const existing = new Set(current.map((i) => i.assetId));
        return [...current, ...demoItems.filter((i) => !existing.has(i.assetId))];
      });
      setSelectedId(demoItems[0].assetId);
      setProgress(clearFinishedProgress);
      setPendingPreview(null);
      setShowOriginal(false);
      demoItems.forEach(spawnItem);
    } catch (demoError) {
      if (mountedRef.current) {
        setError(
          demoError instanceof Error ? demoError.message : 'Could not load the demo objects.',
        );
      }
    } finally {
      loadingDemosRef.current = false;
      if (mountedRef.current) setIsLoadingDemos(false);
    }
  };

  const handleDeleteItem = useCallback(
    async (item: Item) => {
      if (item.source === 'upload') {
        try {
          await storeRef.current?.deleteCutout(item.assetId);
        } catch {
          /* keep UI consistent anyway */
        }
      }
      setItems((current) => current.filter((i) => i.assetId !== item.assetId));
      setGroups((current) =>
        current
          .map((g) =>
            g.id === item.groupId
              ? { ...g, assetIds: g.assetIds.filter((id) => id !== item.assetId) }
              : g,
          )
          .filter((g) => g.id === 'demo' || g.assetIds.length > 0),
      );
      if (selectedId === item.assetId) setSelectedId(null);
    },
    [selectedId],
  );

  const handleDeleteGroup = useCallback(async (group: Group) => {
    if (confirmGroupId !== group.id) {
      setConfirmGroupId(group.id);
      if (confirmTimerRef.current.id !== null) clearTimeout(confirmTimerRef.current.id);
      confirmTimerRef.current.id = window.setTimeout(() => setConfirmGroupId(null), 3000);
      return;
    }
    setConfirmGroupId(null);
    if (group.id === 'demo') {
      setGroups((current) => current.filter((g) => g.id !== 'demo'));
      setItems((current) => current.filter((i) => i.groupId !== 'demo'));
      setSelectedId((current) =>
        group.assetIds.includes(current ?? '') ? null : current,
      );
      return;
    }
    try {
      await storeRef.current?.deleteUpload(group.id);
    } catch {
      /* keep UI consistent anyway */
    }
    if (group.originalUrl) URL.revokeObjectURL(group.originalUrl);
    setGroups((current) => current.filter((g) => g.id !== group.id));
    setItems((current) => current.filter((i) => i.groupId !== group.id));
    setSelectedId((current) => (group.assetIds.includes(current ?? '') ? null : current));
  }, [confirmGroupId]);

  const handleDownload = () => {
    if (!selectedItem) return;
    const anchor = document.createElement('a');
    anchor.href = selectedItem.cutoutUrl;
    const extension =
      selectedItem.source === 'demo'
        ? selectedItem.cutoutUrl.split('.').pop() ?? 'svg'
        : 'png';
    anchor.download = `${baseName(displayName(selectedItem, groups))}-cutout.${extension}`;
    anchor.click();
  };

  const currentStep = PROCESSING_STEPS.findIndex((s) => s.phases.includes(progress.phase));
  const hasContent = pendingPreview !== null || selectedItem !== null || isBusy;
  const selectedGroupItems = selectedGroup
    ? items.filter((i) => i.groupId === selectedGroup.id)
    : [];
  const groupOrder = useMemo(() => new Map(groups.map((g, i) => [g.id, i])), [groups]);

  const renderGroupSection = (group: Group) => {
    const groupItems = items
      .filter((i) => i.groupId === group.id)
      .sort(
        (a, b) =>
          group.assetIds.indexOf(a.assetId) - group.assetIds.indexOf(b.assetId),
      );
    return (
      <section key={group.id} className="studio-lib-group">
        <div className="studio-lib-group-header">
          <span className="studio-lib-group-thumb">
            {group.originalUrl ? (
              <img src={group.originalUrl} alt="" />
            ) : (
              <Sparkles size={16} />
            )}
          </span>
          <span className="studio-lib-group-info">
            <strong>{group.name}</strong>
            <span>
              {groupItems.length} characters · {relativeDate(group.createdAt)}
            </span>
          </span>
          <button
            type="button"
            className="studio-lib-group-bringall"
            aria-label={`Bring all ${groupItems.length} characters of ${group.name} to life`}
            onClick={() => spawnAll(group.id)}
          >
            <WandSparkles size={13} /> Bring all
          </button>
          <button
            type="button"
            className={`studio-icon-button${confirmGroupId === group.id ? ' studio-icon-button--confirm' : ''}`}
            aria-label={confirmGroupId === group.id ? 'Confirm delete group' : `Delete ${group.name}`}
            onClick={() => void handleDeleteGroup(group)}
          >
            {confirmGroupId === group.id ? <span className="studio-confirm-text">Confirm?</span> : <Trash2 size={14} />}
          </button>
        </div>
        <div className="studio-lib-grid">
          {groupItems.map((item) => (
            <div key={item.assetId} className="studio-lib-card-wrap">
              <button
                type="button"
                className={`studio-lib-card${selectedId === item.assetId ? ' studio-lib-card--selected' : ''}`}
                aria-label={`Select ${displayName(item, groups)}`}
                aria-pressed={selectedId === item.assetId}
                onClick={() => selectItem(item.assetId)}
              >
                <span className="studio-lib-thumb studio-preview-stage--checker">
                  <img src={item.cutoutUrl} alt="" />
                </span>
                <span className="studio-lib-name">{item.label || item.name}</span>
              </button>
              <button
                type="button"
                className="studio-lib-delete"
                aria-label={`Delete ${item.label || item.name}`}
                onClick={() => void handleDeleteItem(item)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="studio-panel">
      <header className="studio-toprow">
        <div className="studio-tabs" role="tablist" aria-label="Studio sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'create'}
            className={`studio-tab${tab === 'create' ? ' studio-tab--active' : ''}`}
            onClick={() => setTab('create')}
          >
            Create
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'library'}
            className={`studio-tab${tab === 'library' ? ' studio-tab--active' : ''}`}
            onClick={() => setTab('library')}
          >
            Library ({items.length})
          </button>
        </div>
        <span
          className={`studio-ai-chip studio-ai-chip--${aiStatus}`}
          role="status"
          aria-label={`AI model status: ${aiStatus}`}
        >
          {aiStatus === 'loading' && <LoaderCircle size={12} className="studio-spin" />}
          {aiStatus === 'ready' && <Check size={12} />}
          {aiStatus === 'unavailable' && <X size={12} />}
          {aiStatus === 'loading' ? 'AI loading' : aiStatus === 'ready' ? 'AI ready' : 'AI unavailable'}
        </span>
      </header>

      <div className="studio-scroll">
        {tab === 'create' && (
          <>
            <div
              className={`studio-dropzone${isDragging ? ' studio-dropzone--dragging' : ''}${hasContent ? ' studio-dropzone--slim' : ''}`}
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
              {hasContent ? (
                <span className="studio-dropzone-slim">
                  <Upload size={15} /> Upload another photo
                </span>
              ) : (
                <>
                  <div className="studio-upload-icon">
                    <Upload size={20} strokeWidth={1.8} />
                  </div>
                  <div className="studio-dropzone-copy">
                    <strong>{isDragging ? 'Release to upload' : 'Drop a photo to get started'}</strong>
                    <span>or click to browse · PNG, JPG or WebP up to 10 MB</span>
                  </div>
                </>
              )}
            </div>

            {(pendingPreview || selectedItem) && (
              <section className="studio-preview-card" aria-label="Image preview">
                <div className="studio-preview-heading">
                  <h2>Preview</h2>
                  <div className="studio-preview-heading-actions">
                    {selectedItem && selectedGroup?.originalUrl && !pendingPreview && (
                      <button
                        className={`studio-before-after${showOriginal ? ' studio-before-after--active' : ''}`}
                        type="button"
                        aria-label={showOriginal ? 'Show cutout preview' : 'Show original preview'}
                        aria-pressed={showOriginal}
                        onClick={() => setShowOriginal((v) => !v)}
                      >
                        <ImageIcon size={14} />
                        {showOriginal ? 'Before' : 'After'}
                      </button>
                    )}
                    <button
                      className="studio-icon-button"
                      type="button"
                      aria-label="Download cutout PNG"
                      disabled={!selectedItem}
                      onClick={handleDownload}
                    >
                      <ArrowDownToLine size={15} />
                    </button>
                  </div>
                </div>

                <div className={`studio-preview-stage studio-preview-stage--${bgMode}`} aria-live="polite">
                  {pendingPreview ? (
                    <img
                      className="studio-preview-image"
                      src={pendingPreview.originalUrl}
                      alt={`${pendingPreview.name} preview`}
                    />
                  ) : selectedItem && showOriginal && selectedGroup?.originalUrl ? (
                    <div
                      className="studio-original-wrap"
                      style={{ aspectRatio: `${selectedGroup.width} / ${selectedGroup.height}` }}
                    >
                      <img
                        className="studio-preview-image"
                        src={selectedGroup.originalUrl}
                        alt={`${selectedGroup.name} original`}
                      />
                      <svg
                        className="studio-overlay"
                        viewBox={`0 0 ${selectedGroup.width} ${selectedGroup.height}`}
                        aria-hidden="true"
                      >
                        {selectedGroupItems.map((item, index) => {
                          const crop = selectedGroup.crops[item.assetId];
                          if (!crop) return null;
                          const color = CROP_COLORS[index % CROP_COLORS.length];
                          const fontSize = Math.max(16, selectedGroup.width / 28);
                          const pad = fontSize * 0.3;
                          const text = item.label || item.name;
                          const labelW = text.length * fontSize * 0.6 + pad * 2;
                          const labelH = fontSize + pad * 2;
                          return (
                            <g key={item.assetId}>
                              <rect
                                x={crop.x}
                                y={crop.y}
                                width={crop.width}
                                height={crop.height}
                                fill="none"
                                stroke={color}
                                strokeWidth={Math.max(3, selectedGroup.width / 200)}
                                rx={8}
                              />
                              <rect
                                x={crop.x}
                                y={crop.y}
                                width={labelW}
                                height={labelH}
                                fill="rgb(0 0 0 / 60%)"
                                rx={pad}
                              />
                              <text
                                x={crop.x + pad}
                                y={crop.y + pad + fontSize * 0.8}
                                fill={color}
                                fontSize={fontSize}
                                fontWeight={600}
                              >
                                {text}
                              </text>
                            </g>
                          );
                        })}
                      </svg>
                    </div>
                  ) : selectedItem ? (
                    <img
                      id="studio-preview-image"
                      className="studio-preview-image"
                      src={selectedItem.cutoutUrl}
                      alt={`${displayName(selectedItem, groups)} preview`}
                    />
                  ) : null}
                  {isBusy && (
                    <div className="studio-processing-indicator">
                      <LoaderCircle size={14} className="studio-spin" />
                      Working…
                    </div>
                  )}
                </div>

                <div className="studio-preview-controls">
                  <div className="studio-background-options" role="group" aria-label="Preview background">
                    {(
                      [
                        ['checker', 'Checkerboard'],
                        ['white', 'White'],
                        ['black', 'Black'],
                      ] as const
                    ).map(([mode, label]) => (
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
                </div>
              </section>
            )}

            {isBusy && (
              <div className="studio-progress-card">
                <div className="studio-progress-steps">
                  {PROCESSING_STEPS.map((step, index) => (
                    <span
                      key={step.label}
                      className={`studio-step${index < currentStep ? ' studio-step--done' : ''}${index === currentStep ? ' studio-step--active' : ''}`}
                    >
                      {index < currentStep ? <Check size={11} /> : null}
                      {step.label}
                    </span>
                  ))}
                </div>
                <div className="studio-progress-heading">
                  <span className="studio-progress-label">{progress.label}</span>
                  <span className="studio-progress-percent">{Math.round(progress.ratio * 100)}%</span>
                </div>
                <div
                  className="studio-progress-track"
                  role="progressbar"
                  aria-label="Processing progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress.ratio * 100)}
                  aria-valuetext={progress.label}
                >
                  <span style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
                </div>
              </div>
            )}

            {progress.phase === 'done' && selectedItem && (
              <div className="studio-result-header" role="status">
                <Check size={15} />
                <span>
                  {items.filter((i) => i.groupId === selectedItem.groupId).length > 1
                    ? `Found ${items.filter((i) => i.groupId === selectedItem.groupId).length} characters`
                    : 'Background removed'}
                </span>
              </div>
            )}

            {notice && (
              <div className="studio-alert studio-alert--info" role="status">
                <Sparkles size={15} />
                <span>{notice}</span>
              </div>
            )}
            {error && (
              <div className="studio-alert studio-alert--error" role="alert">
                <X size={15} />
                <span>{error}</span>
              </div>
            )}
            {aiStatus === 'unavailable' && (
              <div className="studio-alert" role="status">
                <Sparkles size={15} />
                <span>AI unavailable — demo objects still work</span>
              </div>
            )}
            {poseUnavailable && aiStatus !== 'unavailable' && (
              <div className="studio-note" role="status">
                <span>People detection off — uploads will produce single cutouts</span>
              </div>
            )}
            {!libraryPersistent && libraryLoaded && (
              <div className="studio-note" role="status">
                <span>Library is temporary in this browser mode</span>
              </div>
            )}

            {selectedItem && items.filter((i) => i.groupId === selectedItem.groupId).length > 1 && (
              <div className="studio-characters">
                {items
                  .filter((i) => i.groupId === selectedItem.groupId)
                  .map((item) => (
                    <button
                      key={item.assetId}
                      type="button"
                      className={`studio-char-card${selectedId === item.assetId ? ' studio-char-card--selected' : ''}`}
                      aria-label={`Select ${displayName(item, groups)}`}
                      aria-pressed={selectedId === item.assetId}
                      onClick={() => selectItem(item.assetId)}
                    >
                      <span className="studio-char-thumb studio-preview-stage--checker">
                        <img src={item.cutoutUrl} alt="" />
                      </span>
                      <span className="studio-char-name">{item.label || item.name}</span>
                      <span className={`studio-char-badge studio-char-badge--${item.kind ?? 'object'}`}>
                        {item.kind ?? 'object'}
                      </span>
                      <span className="studio-char-dims">
                        {item.width} × {item.height}
                      </span>
                    </button>
                  ))}
              </div>
            )}

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
              Try demo objects
            </button>
          </>
        )}

        {tab === 'library' && (
          <div className="studio-library">
            {!libraryLoaded ? (
              <div className="studio-skeletons" aria-label="Loading library">
                {[0, 1].map((i) => (
                  <div key={i} className="studio-skeleton-group">
                    <div className="studio-skeleton studio-skeleton-header" />
                    <div className="studio-skeleton-grid">
                      {[0, 1, 2].map((j) => (
                        <div key={j} className="studio-skeleton studio-skeleton-card" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : groups.length === 0 ? (
              <div className="studio-library-empty">
                <Images size={20} />
                <strong>Nothing here yet</strong>
                <span>Processed photos and demo objects will show up here.</span>
              </div>
            ) : (
              groups
                .slice()
                .sort((a, b) => (groupOrder.get(a.id) ?? 0) - (groupOrder.get(b.id) ?? 0))
                .map(renderGroupSection)
            )}
          </div>
        )}
      </div>

      <footer className="studio-actionbar">
        <div className="studio-size-control">
          <label htmlFor="studio-spawn-size" className="studio-size-label">
            Size <strong>{spawnSize}px</strong>
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
        </div>
        <div className="studio-actions">
          {selectedGroup && selectedGroupItems.length > 1 && (
            <button
              className="studio-bringall-button"
              type="button"
              aria-label={`Bring all ${selectedGroupItems.length} characters to life`}
              onClick={() => spawnAll(selectedGroup.id)}
            >
              <WandSparkles size={15} />
              Bring all ({selectedGroupItems.length})
            </button>
          )}
          <button
            className="studio-spawn-button"
            type="button"
            disabled={!selectedItem}
            onClick={() => selectedItem && spawnItem(selectedItem)}
          >
            <Sparkles size={16} />
            <span>Bring to Life</span>
          </button>
        </div>
      </footer>
    </div>
  );
}
