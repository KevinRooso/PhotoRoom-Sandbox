import type { PoseKeypoint } from '../types/asset';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StoredUpload {
  hash: string;
  name: string;
  createdAt: number;
  originalBlob: Blob;
  width: number;
  height: number;
  assetIds: string[];
}

export interface StoredCutout {
  assetId: string;
  uploadHash: string;
  name: string;
  blob: Blob;
  width: number;
  height: number;
  kind: 'person' | 'object';
  pose?: PoseKeypoint[];
  crop: CropRect;
  createdAt: number;
}

export interface LibraryStore {
  readonly persistent: boolean;
  findUpload(hash: string): Promise<StoredUpload | undefined>;
  saveUpload(upload: StoredUpload, cutouts: StoredCutout[]): Promise<void>;
  listAll(): Promise<{ uploads: StoredUpload[]; cutouts: StoredCutout[] }>;
  deleteUpload(hash: string): Promise<void>;
  deleteCutout(assetId: string): Promise<void>;
}

const DB_NAME = 'physicslab';
const DB_VERSION = 1;
const UPLOADS = 'uploads';
const CUTOUTS = 'cutouts';

export async function hashFile(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(UPLOADS)) {
        db.createObjectStore(UPLOADS, { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains(CUTOUTS)) {
        const store = db.createObjectStore(CUTOUTS, { keyPath: 'assetId' });
        store.createIndex('uploadHash', 'uploadHash');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the library.'));
    request.onblocked = () => reject(new Error('Library upgrade was blocked.'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Library transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Library transaction aborted.'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Library request failed.'));
  });
}

function requestAll<T>(store: IDBObjectStore | IDBIndex): Promise<T[]> {
  return requestToPromise(store.getAll() as IDBRequest<T[]>);
}

function createIndexedDbStore(db: IDBDatabase): LibraryStore {
  return {
    persistent: true,

    async findUpload(hash) {
      const tx = db.transaction(UPLOADS, 'readonly');
      const upload = await requestToPromise(
        tx.objectStore(UPLOADS).get(hash) as IDBRequest<StoredUpload | undefined>,
      );
      await txDone(tx);
      return upload;
    },

    async saveUpload(upload, cutouts) {
      const tx = db.transaction([UPLOADS, CUTOUTS], 'readwrite');
      tx.objectStore(UPLOADS).put(upload);
      const cutoutStore = tx.objectStore(CUTOUTS);
      for (const cutout of cutouts) cutoutStore.put(cutout);
      await txDone(tx);
    },

    async listAll() {
      const tx = db.transaction([UPLOADS, CUTOUTS], 'readonly');
      const [uploads, cutouts] = await Promise.all([
        requestAll<StoredUpload>(tx.objectStore(UPLOADS)),
        requestAll<StoredCutout>(tx.objectStore(CUTOUTS)),
      ]);
      await txDone(tx);
      uploads.sort((a, b) => b.createdAt - a.createdAt);
      return { uploads, cutouts };
    },

    async deleteUpload(hash) {
      const tx = db.transaction([UPLOADS, CUTOUTS], 'readwrite');
      tx.objectStore(UPLOADS).delete(hash);
      const cutoutStore = tx.objectStore(CUTOUTS);
      const ids = await requestToPromise(
        cutoutStore.index('uploadHash').getAllKeys(hash),
      );
      for (const id of ids) cutoutStore.delete(id);
      await txDone(tx);
    },

    async deleteCutout(assetId) {
      const tx = db.transaction([UPLOADS, CUTOUTS], 'readwrite');
      const cutoutStore = tx.objectStore(CUTOUTS);
      const cutout = await requestToPromise(
        cutoutStore.get(assetId) as IDBRequest<StoredCutout | undefined>,
      );
      if (cutout) {
        cutoutStore.delete(assetId);
        const uploadStore = tx.objectStore(UPLOADS);
        const upload = await requestToPromise(
          uploadStore.get(cutout.uploadHash) as IDBRequest<StoredUpload | undefined>,
        );
        if (upload) {
          upload.assetIds = upload.assetIds.filter((id) => id !== assetId);
          if (upload.assetIds.length === 0) uploadStore.delete(upload.hash);
          else uploadStore.put(upload);
        }
      }
      await txDone(tx);
    },
  };
}

function createMemoryStore(): LibraryStore {
  const uploads = new Map<string, StoredUpload>();
  const cutouts = new Map<string, StoredCutout>();

  return {
    persistent: false,

    async findUpload(hash) {
      return uploads.get(hash);
    },

    async saveUpload(upload, items) {
      uploads.set(upload.hash, upload);
      for (const item of items) cutouts.set(item.assetId, item);
    },

    async listAll() {
      return {
        uploads: [...uploads.values()].sort((a, b) => b.createdAt - a.createdAt),
        cutouts: [...cutouts.values()],
      };
    },

    async deleteUpload(hash) {
      uploads.delete(hash);
      for (const [id, cutout] of cutouts) {
        if (cutout.uploadHash === hash) cutouts.delete(id);
      }
    },

    async deleteCutout(assetId) {
      const cutout = cutouts.get(assetId);
      if (!cutout) return;
      cutouts.delete(assetId);
      const upload = uploads.get(cutout.uploadHash);
      if (upload) {
        upload.assetIds = upload.assetIds.filter((id) => id !== assetId);
        if (upload.assetIds.length === 0) uploads.delete(upload.hash);
      }
    },
  };
}

let libraryPromise: Promise<LibraryStore> | undefined;

export function openLibrary(): Promise<LibraryStore> {
  libraryPromise ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined') return createMemoryStore();
      const db = await openDatabase();
      return createIndexedDbStore(db);
    } catch {
      return createMemoryStore();
    }
  })();
  return libraryPromise;
}
