import fs from 'node:fs';
import path from 'node:path';

/**
 * The bundled Contrail skill pack. The skill folders under skills/ are COPIES
 * synced from the plugin repo (the source of truth) by scripts/sync-skills.mjs
 * — never hand-edit them here. This package also owns the tiny frontmatter
 * reader so the desktop's skill library and its tests share one parser.
 *
 * Licensing: the pack is adapted from forcedotcom/sf-skills (Apache-2.0);
 * NOTICE and LICENSE-APACHE-2.0 travel with this package, and each adapted
 * SKILL.md carries its own attribution footer.
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export interface BundledSkill extends SkillFrontmatter {
  /** Absolute path to the skill's directory. */
  dir: string;
}

/** Absolute path to the bundled skill folders (works in dev and packaged trees). */
export function bundledSkillsDir(): string {
  return path.join(import.meta.dirname, '..', 'skills');
}

/**
 * Minimal frontmatter reader: top-level `name:` and `description:` scalars
 * (bare or single-line quoted) between the leading `---` fences. Deliberately
 * NOT a YAML parser — a skill whose identity fields need more than this is a
 * skill whose identity fields should be simplified.
 */
export function parseSkillFrontmatter(md: string): SkillFrontmatter | null {
  const fence = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) return null;
  const body = fence[1] ?? '';
  const scalar = (key: string): string | null => {
    const line = body.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
    if (!line) return null;
    let v = (line[1] ?? '').trim();
    if (v.startsWith('"')) {
      if (!v.endsWith('"') || v.length < 2) return null; // multi-line: unsupported
      v = v.slice(1, -1).replaceAll('\\"', '"');
    } else if (v.startsWith("'")) {
      if (!v.endsWith("'") || v.length < 2) return null;
      v = v.slice(1, -1);
    }
    return v.length > 0 ? v : null;
  };
  const name = scalar('name');
  const description = scalar('description');
  return name && description ? { name, description } : null;
}

/**
 * Enumerate the bundled pack. Returns parse failures separately so the caller
 * decides how loudly to complain — a broken bundled skill must never take the
 * app down.
 */
export function listBundledSkills(root = bundledSkillsDir()): {
  skills: BundledSkill[];
  failures: string[];
} {
  const skills: BundledSkill[] = [];
  const failures: string[] = [];
  if (!fs.existsSync(root)) return { skills, failures };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const md = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    const fm = parseSkillFrontmatter(fs.readFileSync(md, 'utf8'));
    if (fm) skills.push({ ...fm, dir });
    else failures.push(entry.name);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, failures };
}
