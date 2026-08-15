import {
  extractAllEdges,
  runExtractAndIndex,
  SnapshotStore,
  type EdgeExtractionInput,
  type ExtractIndexInput,
} from '@contrail/engine';

/**
 * Snapshot CPU worker (utilityProcess). Receives the pipeline's two
 * CPU-bound work units and answers by id. Filesystem only — this process
 * NEVER opens the SQLite database (single-writer discipline lives in main).
 */

type WorkRequest =
  | { kind: 'extractAndIndex'; id: number; input: ExtractIndexInput }
  | { kind: 'extractEdges'; id: number; input: EdgeExtractionInput };

type WorkResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

interface ParentPort {
  on(event: 'message', listener: (e: { data: WorkRequest }) => void): void;
  postMessage(message: WorkResponse): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
const store = new SnapshotStore();

parentPort.on('message', (e) => {
  const msg = e.data;
  try {
    let result: unknown;
    if (msg.kind === 'extractAndIndex') {
      result = runExtractAndIndex(store, msg.input);
    } else {
      result = extractAllEdges(msg.input.connectionId, msg.input.artifacts, msg.input.known);
    }
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String(err).slice(0, 1000) });
  }
});
