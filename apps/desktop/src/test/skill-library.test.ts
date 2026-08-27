import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, customSkillKey, type EngineDeps } from '@contrail/engine';
import { SkillService } from '../main/services/skills.js';
import { AgentSessionRun, type SessionSpec } from '../main/services/agentRuntime.js';
import type { ProjectService } from '../main/services/projects.js';

/**
 * S18: the universal skill library — bundled pack + custom uploads, selected
 * per project. The adversarial cases matter most: upload containment, the
 * cross-project read gate, and toggle precedence.
 */

let tmp: string;
let src: string;
let db: ContrailDb;
let deps: EngineDeps;
let skills: SkillService;

function writeSkillFolder(name: string, description = 'A custom skill for testing purposes.'): string {
  const dir = path.join(src, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\nDo the thing well.\n`,
    'utf8',
  );
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-skills-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-skillsrc-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  deps = { db } as unknown as EngineDeps;
  skills = new SkillService(deps);
});

afterEach(() => {
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

describe('the library', () => {
  it('boots with the bundled pack, sorted, all default-on', () => {
    const lib = skills.listLibrary();
    const bundled = lib.filter((s) => s.source === 'bundled');
    expect(bundled.length).toBeGreaterThanOrEqual(9);
    expect(bundled.map((s) => s.name)).toContain('salesforce-house-rules');
    expect(bundled.every((s) => s.defaultOn && s.id === null)).toBe(true);
  });

  it('accepts a valid custom skill folder and lists it', () => {
    const rec = skills.addFromFolder(writeSkillFolder('client-style-guide'));
    expect(rec.name).toBe('client-style-guide');
    expect(rec.defaultOn).toBe(false);
    const stored = path.join(tmp, 'skills', rec.dirName, 'SKILL.md');
    expect(fs.existsSync(stored)).toBe(true);
    expect(skills.listLibrary().some((s) => s.name === 'client-style-guide' && s.source === 'custom')).toBe(true);
  });

  it('refuses sources inside the data dir, missing SKILL.md, and bad frontmatter', () => {
    // Containment: a folder under dataDir (another skill's storage, the DB's home).
    const inside = path.join(tmp, 'skills', 'planted');
    fs.mkdirSync(inside, { recursive: true });
    fs.writeFileSync(path.join(inside, 'SKILL.md'), '---\nname: planted\ndescription: "x y z"\n---\n');
    expect(() => skills.addFromFolder(inside)).toThrow(/data directory/);

    const bare = path.join(src, 'no-skill-md');
    fs.mkdirSync(bare);
    expect(() => skills.addFromFolder(bare)).toThrow(/no SKILL.md/);

    const bad = path.join(src, 'bad-fm');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'SKILL.md'), '# no frontmatter here\n');
    expect(() => skills.addFromFolder(bad)).toThrow(/frontmatter/);
  });

  it('refuses name collisions against bundled AND custom names, case-insensitively', () => {
    expect(() => skills.addFromFolder(writeSkillFolder('Salesforce-House-Rules'))).toThrow(/already exists/);
    skills.addFromFolder(writeSkillFolder('my-skill'));
    const dup = path.join(src, 'my-skill-2');
    fs.mkdirSync(dup);
    fs.writeFileSync(path.join(dup, 'SKILL.md'), '---\nname: MY-SKILL\ndescription: "dupe attempt"\n---\n');
    expect(() => skills.addFromFolder(dup)).toThrow(/already exists/);
  });

  it('enforces the file-count cap before copying anything', () => {
    const big = writeSkillFolder('too-many-files');
    for (let i = 0; i < 201; i += 1) fs.writeFileSync(path.join(big, `f${i}.txt`), 'x');
    expect(() => skills.addFromFolder(big)).toThrow(/limit is 200/);
    // The refusal happened before any copy — not even the storage dir exists.
    const store = path.join(tmp, 'skills');
    expect(!fs.existsSync(store) || fs.readdirSync(store).length === 0).toBe(true);
  });

  it('removing a custom skill deletes the row, the toggles, and the files', () => {
    const p = db.createProject({ name: 'P' });
    const rec = skills.addFromFolder(writeSkillFolder('short-lived'));
    skills.setToggle(p.id, customSkillKey(rec.id), true);
    skills.remove(rec.id);
    expect(skills.listLibrary().some((s) => s.name === 'short-lived')).toBe(false);
    expect(db.getSkillToggles(p.id)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'skills', rec.dirName))).toBe(false);
  });
});

describe('per-project selection', () => {
  it('bundled default on, custom follows default_on, explicit toggles win both ways', () => {
    const p = db.createProject({ name: 'Toggles' });
    const rec = skills.addFromFolder(writeSkillFolder('opt-in-skill'));
    const key = customSkillKey(rec.id);

    let view = skills.projectView(p.id);
    expect(view.skills.find((s) => s.name === 'salesforce-house-rules')?.enabled).toBe(true);
    expect(view.skills.find((s) => s.key === key)?.enabled).toBe(false);

    // default_on lifts the custom skill for projects with no explicit row…
    skills.setDefaultOn(rec.id, true);
    expect(skills.projectView(p.id).skills.find((s) => s.key === key)?.enabled).toBe(true);

    // …but explicit rows beat both directions.
    view = skills.setToggle(p.id, key, false);
    expect(view.skills.find((s) => s.key === key)?.enabled).toBe(false);
    view = skills.setToggle(p.id, 'salesforce-house-rules', false);
    expect(view.skills.find((s) => s.name === 'salesforce-house-rules')?.enabled).toBe(false);

    // Unknown keys never create junk rows.
    expect(() => skills.setToggle(p.id, 'ext:no-such-skill', true)).toThrow(/Unknown skill key/);
  });

  it('resolveSessionSkills returns only enabled skills, sorted by name', () => {
    const p = db.createProject({ name: 'Resolve' });
    skills.setToggle(p.id, 'salesforce-house-rules', false);
    const resolved = skills.resolveSessionSkills(p.id);
    expect(resolved.some((s) => s.name === 'salesforce-house-rules')).toBe(false);
    expect(resolved.length).toBeGreaterThanOrEqual(8);
    expect([...resolved.map((s) => s.name)].sort()).toEqual(resolved.map((s) => s.name));
  });
});

describe('the read gate (executor posture: live per-call check)', () => {
  function makeRun(projectId: string, projectName: string): AgentSessionRun {
    const spec: SessionSpec = {
      project: { id: projectId, name: projectName, description: null, instructions: null },
      bindings: [],
      model: 'claude-haiku-4-5',
      maxTurns: 10,
      maxBudgetUsd: 1,
    };
    return new AgentSessionRun(
      deps,
      spec,
      `session-${projectId}`,
      {} as ProjectService,
      () => null,
      () => skills,
    );
  }

  it('a project that disabled a skill cannot read it while another project still can', async () => {
    const a = db.createProject({ name: 'A' });
    const b = db.createProject({ name: 'B' });
    skills.setToggle(a.id, 'salesforce-house-rules', false);

    const denied = await makeRun(a.id, 'A').executeCapability('read_skill', {
      name: 'salesforce-house-rules',
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toMatch(/disabled for this project/);

    const allowed = await makeRun(b.id, 'B').executeCapability('read_skill', {
      name: 'salesforce-house-rules',
    });
    expect(allowed.isError).toBeUndefined();
    expect(allowed.content[0]?.text).toContain('Contrail house rules');
  });

  it('a mid-session disable takes effect on the very next read', async () => {
    const p = db.createProject({ name: 'Live' });
    const run = makeRun(p.id, 'Live');
    const first = await run.executeCapability('read_skill', { name: 'salesforce-house-rules' });
    expect(first.isError).toBeUndefined();
    skills.setToggle(p.id, 'salesforce-house-rules', false);
    const second = await run.executeCapability('read_skill', { name: 'salesforce-house-rules' });
    expect(second.isError).toBe(true);
  });

  it('unknown names and sessions without a skill library refuse gracefully', async () => {
    const p = db.createProject({ name: 'Edge' });
    const run = makeRun(p.id, 'Edge');
    const unknown = await run.executeCapability('read_skill', { name: 'no-such-skill' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]?.text).toMatch(/No skill named/);

    const bare = new AgentSessionRun(
      deps,
      {
        project: { id: p.id, name: 'Edge', description: null, instructions: null },
        bindings: [],
        model: 'claude-haiku-4-5',
        maxTurns: 10,
        maxBudgetUsd: 1,
      },
      's-bare',
      {} as ProjectService,
    );
    const noLib = await bare.executeCapability('read_skill', { name: 'salesforce-house-rules' });
    expect(noLib.isError).toBe(true);
    expect(noLib.content[0]?.text).toMatch(/unavailable/);
  });
});
