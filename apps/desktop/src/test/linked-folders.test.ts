import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, type EngineDeps } from '@contrail/engine';
import { ProjectService } from '../main/services/projects.js';

/**
 * S23 — linked project folders. The docs invariants relax in exactly one way
 * (a linked folder is a LIVE view, not a copy); everything else is attacked
 * here: containment in both directions, traversal, symlinks planted after
 * linking, walk bounds that truncate instead of throwing, and unlink leaving
 * the user's files strictly alone.
 *
 * Directory links use junctions ('junction') where symlinks are exercised —
 * they need no privilege on Windows, and Node reports them as symlinks in
 * readdir + resolves them in realpath, which is exactly the attack shape.
 */

let tmp: string; // the Contrail data dir
let src: string; // user-space root for linked folders
let db: ContrailDb;
let projects: ProjectService;
let projId: string;

const canJunction = (() => {
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-jn-'));
    fs.mkdirSync(path.join(d, 't'));
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'), 'junction');
    fs.rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function makeFolder(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(src, name);
  fs.mkdirSync(dir, { recursive: true });
  writeTree(dir, files);
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-lf-data-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-lf-src-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  projects = new ProjectService({ db } as unknown as EngineDeps);
  projId = db.createProject({ name: 'Linked' }).id;
});

afterEach(() => {
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

describe('linking', () => {
  it('links a folder by realpath and lists it; the basename is the handle', () => {
    const dir = makeFolder('client-docs', { 'notes.md': 'hello' });
    const rec = projects.linkFolder(projId, dir);
    expect(rec.path).toBe(fs.realpathSync(dir));
    const listed = projects.listFolders(projId);
    expect(listed).toHaveLength(1);
    expect(path.basename(listed[0]!.path)).toBe('client-docs');
  });

  it('refuses the data dir, anything inside it, and any PARENT of it', () => {
    // Inside the data dir: would hand the agent silo/db files.
    const planted = path.join(tmp, 'projects', 'other', 'docs');
    fs.mkdirSync(planted, { recursive: true });
    expect(() => projects.linkFolder(projId, planted)).toThrow(/data directory/);
    expect(() => projects.linkFolder(projId, tmp)).toThrow(/data directory/);
    // A parent of the data dir: contrail.db would be reachable through it.
    expect(() => projects.linkFolder(projId, os.tmpdir())).toThrow(/contains the Contrail data directory/);
    expect(projects.listFolders(projId)).toEqual([]);
  });

  it('refuses files, duplicate paths, and basename collisions (the agent-facing handle)', () => {
    const dir = makeFolder('docs', { 'a.md': 'x' });
    fs.writeFileSync(path.join(src, 'plain.txt'), 'not a folder');
    expect(() => projects.linkFolder(projId, path.join(src, 'plain.txt'))).toThrow(/Not a folder/);

    projects.linkFolder(projId, dir);
    expect(() => projects.linkFolder(projId, dir)).toThrow(/already linked/);

    const clash = path.join(src, 'elsewhere', 'docs');
    fs.mkdirSync(clash, { recursive: true });
    expect(() => projects.linkFolder(projId, clash)).toThrow(/named "docs" is already linked/);
  });
});

describe('live reads', () => {
  it('reads the CURRENT file content — an edit after linking is visible (the point of linking)', () => {
    const dir = makeFolder('live', { 'plan.md': 'version one' });
    projects.linkFolder(projId, dir);
    expect(projects.readFolderFile(projId, 'live', 'plan.md')).toEqual({
      ok: true,
      text: 'version one',
    });
    // The inversion of the docs copy-semantics test: here the edit MUST show.
    fs.writeFileSync(path.join(dir, 'plan.md'), 'version two');
    expect(projects.readFolderFile(projId, 'live', 'plan.md')).toEqual({
      ok: true,
      text: 'version two',
    });
    // A file created after linking appears too.
    writeTree(dir, { 'sub/new.md': 'fresh' });
    expect(projects.readFolderFile(projId, 'live', 'sub/new.md')).toEqual({
      ok: true,
      text: 'fresh',
    });
  });

  it('refuses traversal, absolute paths, and unknown folders', () => {
    const dir = makeFolder('safe', { 'ok.md': 'fine' });
    fs.writeFileSync(path.join(src, 'outside.md'), 'secret');
    projects.linkFolder(projId, dir);

    expect(projects.readFolderFile(projId, 'safe', '../outside.md').ok).toBe(false);
    expect(projects.readFolderFile(projId, 'safe', 'sub/../../outside.md').ok).toBe(false);
    expect(projects.readFolderFile(projId, 'safe', path.join(src, 'outside.md')).ok).toBe(false);
    expect(projects.readFolderFile(projId, 'nope', 'ok.md').ok).toBe(false);
    const bad = projects.readFolderFile(projId, 'safe', '..\\outside.md');
    expect(bad.ok).toBe(false);
  });

  it.runIf(canJunction)(
    'a symlink planted INSIDE the tree after linking cannot reach the data dir',
    () => {
      writeTree(tmp, { 'secret.md': 'the db lives here' });
      const dir = makeFolder('trap', { 'ok.md': 'fine' });
      projects.linkFolder(projId, dir);
      // The attack: after linking, a junction inside the tree points at the
      // data dir. resolve() stays inside; only realpath exposes the escape.
      fs.symlinkSync(tmp, path.join(dir, 'evil'), 'junction');
      const result = projects.readFolderFile(projId, 'trap', 'evil/secret.md');
      expect(result.ok).toBe(false);
      expect((result as { message: string }).message).toContain('outside the linked folder');
    },
  );

  it('refuses binary formats and truncates very long files with a notice', () => {
    const dir = makeFolder('formats', { 'data.md': 'x'.repeat(150_000) });
    fs.writeFileSync(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50]));
    projects.linkFolder(projId, dir);

    const png = projects.readFolderFile(projId, 'formats', 'image.png');
    expect(png.ok).toBe(false);
    expect((png as { message: string }).message).toContain('text formats');

    const long = projects.readFolderFile(projId, 'formats', 'data.md');
    expect(long.ok).toBe(true);
    expect((long as { text: string }).text).toContain('[truncated: showing 100,000 of 150,000 characters]');
  });

  it('a linked folder that disappears degrades to honest refusals, not crashes', () => {
    const dir = makeFolder('gone', { 'a.md': 'x' });
    projects.linkFolder(projId, dir);
    fs.rmSync(dir, { recursive: true, force: true });

    const listing = projects.listFolderFiles(projId);
    expect(listing).toHaveLength(1);
    expect(listing[0]!.unavailable).toContain('no longer exists');

    const read = projects.readFolderFile(projId, 'gone', 'a.md');
    expect(read.ok).toBe(false);
    expect((read as { message: string }).message).toContain('no longer exists');
  });
});

describe('walk bounds', () => {
  it('lists text files with relative paths; skips dotfiles, node_modules, and non-text', () => {
    const dir = makeFolder('walk', {
      'readme.md': 'a',
      'sub/query.soql': 'b',
      'sub/deep/notes.txt': 'c',
      '.hidden/nope.md': 'd',
      '.env': 'e',
      'node_modules/pkg/index.js': 'f',
      'binary.png': 'g',
    });
    projects.linkFolder(projId, dir);
    const [entry] = projects.listFolderFiles(projId);
    const paths = entry!.files.map((f) => f.path).sort();
    expect(paths).toEqual(['readme.md', 'sub/deep/notes.txt', 'sub/query.soql']);
    expect(entry!.truncated).toBe(false);
  });

  it('truncates at the file cap with the flag set — never throws', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 501; i++) files[`f${String(i).padStart(3, '0')}.md`] = 'x';
    const dir = makeFolder('big', files);
    projects.linkFolder(projId, dir);
    const [entry] = projects.listFolderFiles(projId);
    expect(entry!.files).toHaveLength(500);
    expect(entry!.truncated).toBe(true);
  });

  it('stops descending beyond the depth cap', () => {
    const deep = Array.from({ length: 10 }, (_, i) => `d${i}`).join('/');
    const dir = makeFolder('deep', {
      'top.md': 'x',
      [`${deep}/buried.md`]: 'y',
    });
    projects.linkFolder(projId, dir);
    const [entry] = projects.listFolderFiles(projId);
    expect(entry!.files.map((f) => f.path)).toEqual(['top.md']);
  });

  it.runIf(canJunction)('symlinked directories are skipped outright in listings', () => {
    const other = makeFolder('other', { 'linked-in.md': 'x' });
    const dir = makeFolder('walker', { 'own.md': 'y' });
    fs.symlinkSync(other, path.join(dir, 'jump'), 'junction');
    projects.linkFolder(projId, dir);
    const [entry] = projects.listFolderFiles(projId);
    expect(entry!.files.map((f) => f.path)).toEqual(['own.md']);
  });
});

describe('unlink and delete', () => {
  it("unlink removes the row and NOTHING else — the user's files stay put, and reads refuse", () => {
    const dir = makeFolder('mine', { 'keep.md': 'precious' });
    const rec = projects.linkFolder(projId, dir);
    projects.unlinkFolder(projId, rec.id);

    expect(projects.listFolders(projId)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'keep.md'))).toBe(true);
    // The rows are re-read per call, so the very next read refuses (the
    // mid-session-unlink posture, same as skill toggles).
    expect(projects.readFolderFile(projId, 'mine', 'keep.md').ok).toBe(false);
  });

  it("a folder cannot be unlinked through ANOTHER project (silo check)", () => {
    const dir = makeFolder('siloed', { 'a.md': 'x' });
    const rec = projects.linkFolder(projId, dir);
    const other = db.createProject({ name: 'Other' }).id;
    expect(() => projects.unlinkFolder(other, rec.id)).toThrow(/not found in this project/);
    expect(projects.listFolders(projId)).toHaveLength(1);
  });

  it('deleting the project removes folder rows and leaves the files untouched', () => {
    const dir = makeFolder('survivor', { 'still-here.md': 'x' });
    projects.linkFolder(projId, dir);
    projects.delete(projId);
    expect(db.listProjectFolders(projId)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'still-here.md'))).toBe(true);
  });
});
