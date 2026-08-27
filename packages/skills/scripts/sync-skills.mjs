import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sync the bundled pack from the plugin repo (the source of truth for skill
 * content). Manual, local-only: run `pnpm -C packages/skills sync` after the
 * plugin's skills/ change, review the diff, commit. CI never runs this — the
 * committed copies are what ship, and the pack lint test guards their content.
 *
 * SKILL.overlay.patch files are plugin-repo dev metadata and are not copied.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const pluginRepo = path.resolve(pkgRoot, '..', '..', '..', 'Phase 0 Plugin');
const source = path.join(pluginRepo, 'skills');
const target = path.join(pkgRoot, 'skills');

if (!fs.existsSync(source)) {
  console.error(`plugin skills dir not found at ${source} — sync runs only where both repos are checked out side by side.`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

let copied = 0;
for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const from = path.join(source, entry.name);
  if (!fs.existsSync(path.join(from, 'SKILL.md'))) continue;
  fs.cpSync(from, path.join(target, entry.name), {
    recursive: true,
    filter: (src) => path.basename(src) !== 'SKILL.overlay.patch',
  });
  copied += 1;
  console.log(`synced ${entry.name}`);
}

for (const file of ['NOTICE', 'LICENSE-APACHE-2.0']) {
  const from = path.join(pluginRepo, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(pkgRoot, file));
}

console.log(`${copied} skills synced from ${source}`);
