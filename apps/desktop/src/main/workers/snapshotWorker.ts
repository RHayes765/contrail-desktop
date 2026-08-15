import {
  extractAllEdges,
  runExtractAndIndex,
  semanticDiff,
  SnapshotStore,
  type EdgeExtractionInput,
  type ExtractIndexInput,
} from '@contrail/engine';

/**
 * Snapshot CPU worker (utilityProcess). Receives the pipeline's CPU-bound
 * work units and answers by id. Filesystem only — this process NEVER opens
 * the SQLite database (single-writer discipline lives in main).
 */

export interface DiffPair {
  type: string;
  apiName: string;
  connectionIdA: string;
  connectionIdB: string;
  filePathA: string;
  filePathB: string;
}

export interface DiffPairResult {
  type: string;
  apiName: string;
  identical: boolean;
  format: 'xml' | 'text';
  /** XML: structural change count; text: lines added+removed. */
  changeCount: number;
  /** One side's snapshot file could not be read — counted as changed. */
  unreadable: boolean;
}

type WorkRequest =
  | { kind: 'extractAndIndex'; id: number; input: ExtractIndexInput }
  | { kind: 'extractEdges'; id: number; input: EdgeExtractionInput }
  | { kind: 'diffPairs'; id: number; input: { pairs: DiffPair[] } };

type WorkResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

interface ParentPort {
  on(event: 'message', listener: (e: { data: WorkRequest }) => void): void;
  postMessage(message: WorkResponse): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
const store = new SnapshotStore();

function diffPairs(pairs: DiffPair[]): DiffPairResult[] {
  return pairs.map((pair) => {
    const a = store.readCurrentFile(pair.connectionIdA, pair.filePathA);
    const b = store.readCurrentFile(pair.connectionIdB, pair.filePathB);
    if (a == null || b == null) {
      return {
        type: pair.type,
        apiName: pair.apiName,
        identical: false,
        format: 'text' as const,
        changeCount: 0,
        unreadable: true,
      };
    }
    const diff = semanticDiff(a, b);
    const changeCount =
      diff.format === 'xml'
        ? (diff.xml?.change_count ?? 0)
        : (diff.text?.lines_added ?? 0) + (diff.text?.lines_removed ?? 0);
    return {
      type: pair.type,
      apiName: pair.apiName,
      identical: diff.identical,
      format: diff.format,
      changeCount,
      unreadable: false,
    };
  });
}

parentPort.on('message', (e) => {
  const msg = e.data;
  try {
    let result: unknown;
    if (msg.kind === 'extractAndIndex') {
      result = runExtractAndIndex(store, msg.input);
    } else if (msg.kind === 'extractEdges') {
      result = extractAllEdges(msg.input.connectionId, msg.input.artifacts, msg.input.known);
    } else {
      result = diffPairs(msg.input.pairs);
    }
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String(err).slice(0, 1000) });
  }
});
