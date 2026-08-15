import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // Engine + shared load from node_modules at runtime (native addons can't
    // be bundled); everything declared in dependencies stays external.
    // 'electron' itself must be external too — it's a devDependency, so the
    // plugin misses it, and bundling its npm JS shim breaks binary resolution.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          // The snapshot CPU worker: forked as a utilityProcess so unzip/
          // index/reference-extraction never block the UI thread.
          snapshotWorker: 'src/main/workers/snapshotWorker.ts',
        },
        // Workspace packages stay external so the engine runs from its own
        // built dist with its own node_modules — that's where the native
        // addons resolve from. Bundling it would re-break that resolution.
        external: ['electron', '@contrail/engine', '@contrail/shared'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: 'src/preload/index.ts' },
        external: ['electron'],
        // Sandboxed preloads must be CJS.
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
