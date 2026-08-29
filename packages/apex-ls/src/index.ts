import path from 'node:path';

/**
 * The vendored Salesforce language-server bundles (vendor/ — see its
 * PROVENANCE.md). This package exists so the ~20MB payload ships into the
 * packaged app the same proven way @contrail/skills does: a workspace
 * dependency of the app, landing whole at
 * resources/app/node_modules/@contrail/apex-ls/ (asar is off — the bundles
 * are spawnable real files). The engine NEVER computes this path itself
 * (its plugin-repo twin compiles to a single esbuild file where relative
 * paths lie) — the app's bootstrap injects apexLsDir() into the runner.
 */

/** Absolute path to the vendored bundle root (works in dev and packaged trees). */
export function apexLsDir(): string {
  return path.join(import.meta.dirname, '..', 'vendor');
}
