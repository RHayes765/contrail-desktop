import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dialog, type BrowserWindow } from 'electron';
import {
  customSkillKey,
  dataDir,
  log,
  skillEnabled,
  type CustomSkillRecord,
  type EngineDeps,
} from '@contrail/engine';
import { listBundledSkills, parseSkillFrontmatter, type BundledSkill } from '@contrail/skills';
import type { ProjectSkillsView, SkillView } from '@contrail/shared';

/**
 * The skill library: bundled pack (from @contrail/skills, read-only, never
 * persisted) + custom uploads (rows in custom_skills, files under
 * dataDir()/skills/<dirName>/), selected per project via skill_toggles.
 *
 * This service is the ONLY reader of skill files — the renderer (via IPC) and
 * the agent (via the executor's read_skill) both come through here, so the
 * silo rules live in one place: skill content is resolved by NAME against the
 * library, never by caller-supplied path, and every agent read re-checks the
 * session project's toggles live (minting is UX, the gate is law).
 *
 * Deliberately NO live-session revocation machinery (unlike external MCP
 * servers): read_skill crosses the per-call executor gate, so disabling a
 * skill takes effect on the very next read. The session's prompt still lists
 * the skill; the refusal explains why.
 */

const SKILL_READ_MAX_CHARS = 100_000;
const UPLOAD_MAX_FILES = 200;
const UPLOAD_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export type SkillReadResult = { ok: true; text: string } | { ok: false; message: string };

export class SkillService {
  private readonly bundled: BundledSkill[];

  constructor(private readonly deps: EngineDeps) {
    const { skills, failures } = listBundledSkills();
    this.bundled = skills;
    if (failures.length > 0) {
      // A broken bundled skill must never take the app down — just say so.
      log('warn', 'bundled skills failed frontmatter parse and were skipped', { failures });
    }
  }

  // ── Library ────────────────────────────────────────────────────────────

  listLibrary(): SkillView[] {
    const bundled: SkillView[] = this.bundled.map((b) => ({
      key: b.name,
      name: b.name,
      description: b.description,
      source: 'bundled',
      defaultOn: true,
      id: null,
    }));
    const custom: SkillView[] = this.deps.db.listCustomSkills().map((c) => this.customView(c));
    return [...bundled, ...custom];
  }

  /** Renderer path: OS folder picker (main-side — the renderer has no fs). */
  async addViaDialog(win: BrowserWindow | null): Promise<SkillView> {
    const opts = {
      title: 'Add a skill (choose the folder containing SKILL.md)',
      properties: ['openDirectory' as const],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error('No folder chosen.');
    }
    return this.customView(this.addFromFolder(result.filePaths[0]!));
  }

  /** Copy a skill folder into the library. Exported for tests and drag-drop. */
  addFromFolder(sourceDir: string): CustomSkillRecord {
    // Containment — same posture as ProjectService.addDocFromPath: the
    // renderer names a filesystem path, so the source is a claim. Anything
    // under Contrail's own data dir is off limits, realpath-first so a
    // planted symlink cannot smuggle a data-dir tree past the check.
    const real = fs.realpathSync(sourceDir);
    const dataRoot = fs.realpathSync(dataDir());
    if (real === dataRoot || real.startsWith(dataRoot + path.sep)) {
      throw new Error(
        'Folders inside the Contrail data directory cannot be added — copy the skill somewhere else first.',
      );
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`Not a folder: ${sourceDir}`);
    const mdPath = path.join(real, 'SKILL.md');
    if (!fs.existsSync(mdPath)) throw new Error('The folder has no SKILL.md at its root.');
    const fm = parseSkillFrontmatter(fs.readFileSync(mdPath, 'utf8'));
    if (!fm) {
      throw new Error(
        'SKILL.md needs frontmatter with single-line `name:` and `description:` fields between --- fences.',
      );
    }

    const taken = new Set(
      [...this.bundled.map((b) => b.name), ...this.deps.db.listCustomSkills().map((c) => c.name)].map(
        (n) => n.toLowerCase(),
      ),
    );
    if (taken.has(fm.name.toLowerCase())) {
      throw new Error(`A skill named "${fm.name}" already exists in the library.`);
    }

    // Size discipline before any copy: a skill is instructions, not a corpus.
    let files = 0;
    let bytes = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else {
          files += 1;
          bytes += fs.statSync(p).size;
        }
      }
    };
    walk(real);
    if (files > UPLOAD_MAX_FILES) {
      throw new Error(`Skill folder has ${files} files — the limit is ${UPLOAD_MAX_FILES}.`);
    }
    if (bytes > UPLOAD_MAX_TOTAL_BYTES) {
      throw new Error(
        `Skill folder is ${Math.round(bytes / 1024 / 1024)}MB — the limit is 25MB total.`,
      );
    }

    const dirName = randomUUID();
    const target = path.join(this.skillsRoot(), dirName);
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(real, target, { recursive: true });
    try {
      return this.deps.db.addCustomSkill({
        name: fm.name,
        description: fm.description,
        dirName,
      });
    } catch (err) {
      fs.rmSync(target, { recursive: true, force: true });
      throw err;
    }
  }

  remove(id: string): void {
    const skill = this.deps.db.getCustomSkill(id);
    if (!skill) throw new Error('Skill not found.');
    // Rows (and every project's toggles) first; the dir removal is best-effort.
    this.deps.db.removeCustomSkill(id);
    try {
      fs.rmSync(path.join(this.skillsRoot(), skill.dirName), { recursive: true, force: true });
    } catch {
      /* orphaned dir is inert — nothing resolves it without a row */
    }
  }

  setDefaultOn(id: string, defaultOn: boolean): SkillView {
    const updated = this.deps.db.setCustomSkillDefaultOn(id, defaultOn);
    if (!updated) throw new Error('Skill not found.');
    return this.customView(updated);
  }

  // ── Per-project selection ──────────────────────────────────────────────

  projectView(projectId: string): ProjectSkillsView {
    this.mustGetProject(projectId);
    const toggles = this.deps.db.getSkillToggles(projectId);
    const rows = [
      ...this.bundled.map((b) => ({
        key: b.name,
        name: b.name,
        description: b.description,
        source: 'bundled' as const,
        enabled: skillEnabled(toggles, b.name, true),
      })),
      ...this.deps.db.listCustomSkills().map((c) => ({
        key: customSkillKey(c.id),
        name: c.name,
        description: c.description,
        source: 'custom' as const,
        enabled: skillEnabled(toggles, customSkillKey(c.id), false, c.defaultOn),
      })),
    ];
    return { projectId, skills: rows };
  }

  setToggle(projectId: string, skillKey: string, enabled: boolean): ProjectSkillsView {
    this.mustGetProject(projectId);
    if (!this.keyExists(skillKey)) throw new Error(`Unknown skill key "${skillKey}".`);
    this.deps.db.setSkillToggle(projectId, skillKey, enabled);
    return this.projectView(projectId);
  }

  // ── Session surface ────────────────────────────────────────────────────

  /** The enabled set announced in a new session's system prompt. Sorted for cache stability. */
  resolveSessionSkills(projectId: string): Array<{ name: string; description: string }> {
    return this.projectView(projectId)
      .skills.filter((s) => s.enabled)
      .map((s) => ({ name: s.name, description: s.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Executor path for read_skill. Resolves by name against the library and
   * re-checks THIS project's enablement live — a session can never read a
   * skill its project has off, regardless of what the prompt still lists.
   */
  readSkillText(projectId: string, name: string): SkillReadResult {
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) {
      return { ok: false, message: 'Pass the skill name exactly as listed in the system prompt.' };
    }
    const wanted = name.toLowerCase();
    const toggles = this.deps.db.getSkillToggles(projectId);

    const bundled = this.bundled.find((b) => b.name.toLowerCase() === wanted);
    if (bundled) {
      if (!skillEnabled(toggles, bundled.name, true)) {
        return { ok: false, message: `Skill "${bundled.name}" is disabled for this project.` };
      }
      return this.readMd(path.join(bundled.dir, 'SKILL.md'), bundled.name);
    }

    const custom = this.deps.db.listCustomSkills().find((c) => c.name.toLowerCase() === wanted);
    if (custom) {
      if (!skillEnabled(toggles, customSkillKey(custom.id), false, custom.defaultOn)) {
        return { ok: false, message: `Skill "${custom.name}" is disabled for this project.` };
      }
      return this.readMd(path.join(this.skillsRoot(), custom.dirName, 'SKILL.md'), custom.name);
    }

    return { ok: false, message: `No skill named "${name}" in the library.` };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private readMd(file: string, skillName: string): SkillReadResult {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { ok: false, message: `Skill "${skillName}" is missing its SKILL.md on disk.` };
    }
    if (text.length > SKILL_READ_MAX_CHARS) {
      text =
        text.slice(0, SKILL_READ_MAX_CHARS) +
        `\n\n[truncated: showing ${SKILL_READ_MAX_CHARS} of ${text.length} characters]`;
    }
    return { ok: true, text };
  }

  private skillsRoot(): string {
    return path.join(dataDir(), 'skills');
  }

  private keyExists(skillKey: string): boolean {
    if (skillKey.startsWith('ext:')) {
      return this.deps.db.getCustomSkill(skillKey.slice('ext:'.length)) !== null;
    }
    return this.bundled.some((b) => b.name === skillKey);
  }

  private mustGetProject(projectId: string): void {
    if (!this.deps.db.getProject(projectId)) throw new Error('Project not found.');
  }

  private customView(c: CustomSkillRecord): SkillView {
    return {
      key: customSkillKey(c.id),
      name: c.name,
      description: c.description,
      source: 'custom',
      defaultOn: c.defaultOn,
      id: c.id,
    };
  }
}
