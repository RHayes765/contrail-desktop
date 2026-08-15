import type { DependencyEdge } from '../core/types.js';
import type { FileProperties } from '../salesforce/metadataSoap.js';
import { SnapshotStore } from './store.js';
import { indexSnapshotFiles, type IndexedArtifact } from './indexer.js';
import { extractAllEdges, type KnownArtifacts } from '../deps/extract.js';

/**
 * The snapshot pipeline's CPU-bound work units, split behind a seam so a host
 * can move them OFF its main thread (the desktop runs them in a worker
 * process; the plugin and tests use the inline default — identical behavior).
 *
 * Boundary discipline: work units touch the filesystem (snapshot tree) but
 * NEVER SQLite — every DB write stays with the caller, keeping the shared
 * database single-writer per process and WAL contention off the plugin.
 * All inputs/outputs are structured-clone-safe (Buffers, plain objects, Maps).
 */

/** Container types whose children are re-indexed alongside them. */
export const CHILD_TYPES: Record<string, string[]> = {
  CustomObject: ['CustomField', 'ValidationRule'],
  CustomLabels: ['CustomLabel'],
};

export function withChildTypes(types: string[]): string[] {
  const all = new Set(types);
  for (const t of types) for (const child of CHILD_TYPES[t] ?? []) all.add(child);
  return [...all];
}

/** Top-level snapshot directories owned by each retrievable type. */
const TYPE_DIRS: Record<string, string> = {
  ApexClass: 'classes',
  ApexTrigger: 'triggers',
  Flow: 'flows',
  CustomObject: 'objects',
  CustomLabels: 'labels',
  PermissionSet: 'permissionsets',
};

/** The refreshed types' own directories — null if any requested type has no known mapping. */
function ownedDirsForTypes(types: string[]): Set<string> | null {
  const dirs = new Set<string>();
  for (const t of types) {
    const dir = Object.hasOwn(TYPE_DIRS, t) ? TYPE_DIRS[t] : undefined;
    if (!dir) return null;
    dirs.add(dir);
  }
  return dirs;
}

/** Fallback for unmapped types: the refreshed types' known dirs plus whatever the zip contains. */
function dirsForTypes(types: string[], files: Map<string, Uint8Array>): string[] {
  const dirs = new Set<string>();
  for (const t of types) {
    const dir = Object.hasOwn(TYPE_DIRS, t) ? TYPE_DIRS[t] : undefined;
    if (dir) dirs.add(dir);
  }
  for (const rel of files.keys()) {
    const top = rel.split('/')[0];
    if (top && rel.includes('/')) dirs.add(top);
  }
  return [...dirs];
}

export interface ExtractIndexInput {
  connectionId: string;
  /** The raw Metadata API retrieve zip. */
  zip: Buffer | Uint8Array;
  types: string[];
  fullManifest: boolean;
  fileProps: FileProperties[];
  retrievedAt: string;
}

export interface ExtractIndexResult {
  artifacts: IndexedArtifact[];
  filesWritten: number;
}

export interface EdgeExtractionInput {
  connectionId: string;
  artifacts: IndexedArtifact[];
  known: KnownArtifacts;
}

export interface SnapshotWorkUnits {
  /** Unzip → filter to the refresh's authority → write the current/ tree → index. */
  extractAndIndex(input: ExtractIndexInput): Promise<ExtractIndexResult>;
  /** Reference extraction over the freshly indexed artifacts. */
  extractEdges(input: EdgeExtractionInput): Promise<DependencyEdge[]>;
}

/**
 * The synchronous implementation — the exact Phase 0 logic, verbatim. This
 * is the only place the unzip/filter/index pipeline exists; worker hosts call
 * these same functions from another process.
 */
export function runExtractAndIndex(
  store: SnapshotStore,
  input: ExtractIndexInput,
): ExtractIndexResult {
  const zip = Buffer.isBuffer(input.zip) ? input.zip : Buffer.from(input.zip);
  const extracted = store.extractRetrieveZip(zip);
  const affectedSet = new Set(withChildTypes(input.types));

  // A refresh is authoritative ONLY for the types it asked for. On a
  // partial refresh, both the files written and the artifacts indexed are
  // filtered to the requested types' directories, and only those
  // directories are cleared — whatever else the zip carries cannot clobber
  // other types' snapshot or index state.
  let files = extracted;
  let clearDirs: string[] | undefined;
  if (!input.fullManifest) {
    const ownedDirs = ownedDirsForTypes(input.types);
    if (ownedDirs) {
      files = new Map(
        [...extracted].filter(([rel]) => {
          const top = rel.split('/')[0] ?? '';
          return rel.includes('/') ? ownedDirs.has(top) : rel === 'package.xml';
        }),
      );
      clearDirs = [...ownedDirs];
    } else {
      clearDirs = dirsForTypes(input.types, extracted);
    }
  }
  store.writeCurrent(input.connectionId, files, clearDirs ? { clearDirs } : undefined);

  const artifacts = indexSnapshotFiles(files, input.fileProps, input.retrievedAt).filter(
    (a) => input.fullManifest || affectedSet.has(a.type),
  );
  return { artifacts, filesWritten: files.size };
}

export function inlineSnapshotWork(store: SnapshotStore): SnapshotWorkUnits {
  return {
    extractAndIndex: (input) => Promise.resolve(runExtractAndIndex(store, input)),
    extractEdges: (input) =>
      Promise.resolve(extractAllEdges(input.connectionId, input.artifacts, input.known)),
  };
}
