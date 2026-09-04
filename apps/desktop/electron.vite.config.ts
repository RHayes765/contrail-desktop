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
        //
        // ONLY this list is effective: externalizeDepsPlugin does not
        // actually externalize here (electron-updater proves it — it sits
        // bundled in a lazy chunk despite being a dependency). Bundled CJS
        // deps happen to work via interop, but fflate's ESM entry declares a
        // top-level `var require` that collides with the CJS-shim banner when
        // inlined into the entry chunk — the v0.21.1 startup SyntaxError.
        // Any new npm import in main-process code must be added here.
        external: ['electron', 'fflate', '@contrail/engine', '@contrail/shared'],
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
    server: {
      watch: {
        // Never watch packaged output: `release/` holds ~700 MB and a couple
        // thousand files (including a 293 MB claude.exe), which would swamp
        // the dev-server file watcher for no reason.
        ignored: ['**/release/**'],
      },
    },
  },
});
