import { dialog, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDir,
  type EngineDeps,
  type ProjectDocRecord,
  type ProjectFolderRecord,
  type ProjectNoteRecord,
  type ProjectRecord,
} from '@contrail/engine';
import type {
  BindingView,
  EnvRole,
  ProjectDocView,
  ProjectFolderView,
  ProjectNoteView,
  ProjectView,
} from '@contrail/shared';

/**
 * Projects = context silos. This service owns the silo's disk surface
 * (dataDir/projects/{id}/docs/) and its row surface, and is the ONLY reader
 * of doc files — both the renderer (via IPC) and the agent (via the
 * executor's read_project_doc) come through here, so the silo rules live in
 * exactly one place:
 *   - doc paths are always derived from the project id + a basename that must
 *     match a DB row — no caller-supplied path ever reaches the filesystem;
 *   - notes and docs are keyed by project id resolved server-side.
 */

const DOC_MAX_BYTES = 25 * 1024 * 1024; // refuse uploads beyond this
const DOC_READ_MAX_CHARS = 100_000; // agent-facing read cap, with truncation notice

// Linked-folder walk bounds. A listing that outgrows them TRUNCATES with a
// notice — it never throws, or one runaway folder would brick every listing.
const FOLDER_LIST_MAX_FILES = 500;
const FOLDER_WALK_MAX_DEPTH = 8;
/** Directory names nobody means to expose to an agent by linking a project folder. */
const FOLDER_SKIP_DIRS = new Set(['node_modules', '.git']);

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.log', '.sql', '.soql', '.apex', '.cls', '.trigger', '.js', '.ts',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.log': 'text/plain',
  '.sql': 'text/plain',
  '.soql': 'text/plain',
  '.apex': 'text/plain',
  '.cls': 'text/plain',
  '.trigger': 'text/plain',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export function docView(rec: ProjectDocRecord): ProjectDocView {
  return {
    id: rec.id,
    filename: rec.filename,
    mime: rec.mime,
    sizeBytes: rec.sizeBytes,
    addedAt: rec.addedAt,
  };
}

export function folderView(rec: ProjectFolderRecord): ProjectFolderView {
  return {
    id: rec.id,
    name: path.basename(rec.path),
    path: rec.path,
    addedAt: rec.addedAt,
  };
}

export function noteView(rec: ProjectNoteRecord): ProjectNoteView {
  return {
    id: rec.id,
    sessionId: rec.sessionId,
    author: rec.author,
    body: rec.body,
    createdAt: rec.createdAt,
  };
}

export class ProjectService {
  constructor(private readonly deps: EngineDeps) {}

  // ── views ──────────────────────────────────────────────────────────────

  private bindingViews(projectId: string): BindingView[] {
    const views: BindingView[] = [];
    for (const b of this.deps.db.listProjectBindings(projectId)) {
      const conn = this.deps.db.resolveConnection(b.connectionId);
      if (!conn) continue; // connection was removed; binding is inert
      views.push({
        connectionId: conn.id,
        alias: conn.alias,
        orgName: conn.orgName,
        orgType: conn.orgType,
        envRole: b.envRole as EnvRole,
        grants: conn.grants,
      });
    }
    return views;
  }

  projectView(rec: ProjectRecord): ProjectView {
    return {
      id: rec.id,
      name: rec.name,
      description: rec.description,
      instructions: rec.instructions,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      bindings: this.bindingViews(rec.id),
    };
  }

  private mustGet(projectId: string): ProjectRecord {
    const rec = this.deps.db.getProject(projectId);
    if (!rec) throw new Error(`Project ${projectId} not found.`);
    return rec;
  }

  // ── CRUD ───────────────────────────────────────────────────────────────

  list(): ProjectView[] {
    return this.deps.db.listProjects().map((p) => this.projectView(p));
  }

  create(name: string, description?: string): ProjectView {
    if (this.deps.db.findProjectByName(name)) {
      throw new Error(`A project named "${name}" already exists.`);
    }
    return this.projectView(this.deps.db.createProject({ name, description: description ?? null }));
  }

  update(
    id: string,
    patch: { name?: string; description?: string | null; instructions?: string | null },
  ): ProjectView {
    if (patch.name) {
      const clash = this.deps.db.findProjectByName(patch.name);
      if (clash && clash.id !== id) throw new Error(`A project named "${patch.name}" already exists.`);
    }
    const updated = this.deps.db.updateProject(id, patch);
    if (!updated) throw new Error(`Project ${id} not found.`);
    return this.projectView(updated);
  }

  delete(id: string): void {
    this.mustGet(id);
    this.deps.db.deleteProject(id);
    try {
      fs.rmSync(path.join(dataDir(), 'projects', id), { recursive: true, force: true });
    } catch {
      // Orphaned doc files are harmless; the rows are gone.
    }
  }

  bind(projectId: string, connectionId: string, envRole: EnvRole): ProjectView {
    const project = this.mustGet(projectId);
    if (!this.deps.db.resolveConnection(connectionId)) {
      throw new Error(`Connection ${connectionId} not found.`);
    }
    // Re-binding changes the env role (remove + add keeps this idempotent).
    this.deps.db.removeProjectBinding(projectId, connectionId);
    this.deps.db.addProjectBinding(projectId, connectionId, envRole);
    return this.projectView(project);
  }

  unbind(projectId: string, connectionId: string): ProjectView {
    const project = this.mustGet(projectId);
    this.deps.db.removeProjectBinding(projectId, connectionId);
    return this.projectView(project);
  }

  // ── docs ───────────────────────────────────────────────────────────────

  private docsDir(projectId: string): string {
    return path.join(dataDir(), 'projects', projectId, 'docs');
  }

  listDocs(projectId: string): ProjectDocRecord[] {
    return this.deps.db.listProjectDocs(projectId);
  }

  /** Copy one file into the silo. Same filename replaces the previous upload. */
  addDocFromPath(projectId: string, sourcePath: string): ProjectDocRecord {
    this.mustGet(projectId);
    // Containment (review finding, S12): this is the one path where the
    // RENDERER names a filesystem path, so the source is a claim. Anything
    // under Contrail's own data dir is off limits — otherwise a compromised
    // renderer copies another project's docs (silo leak) or contrail.db
    // itself into a silo the agent reads. realpath first, so a symlink
    // planted elsewhere cannot smuggle a data-dir file past the check.
    const real = fs.realpathSync(sourcePath);
    const dataRoot = fs.realpathSync(dataDir());
    if (real === dataRoot || real.startsWith(dataRoot + path.sep)) {
      throw new Error(
        'Files inside the Contrail data directory cannot be attached — copy the file somewhere else first.',
      );
    }
    const stat = fs.statSync(real);
    if (stat.isDirectory()) {
      throw new Error(
        `"${path.basename(sourcePath)}" is a folder — attach individual files here, or link ` +
          `the folder from the project's Docs tab (linked folders are read live, no copies).`,
      );
    }
    if (!stat.isFile()) throw new Error(`Not a file: ${sourcePath}`);
    if (stat.size > DOC_MAX_BYTES) {
      throw new Error(
        `File is ${Math.round(stat.size / 1024 / 1024)}MB — the per-doc limit is 25MB.`,
      );
    }
    const filename = path.basename(sourcePath).slice(0, 200);
    if (!filename || filename.startsWith('.')) {
      throw new Error(`Unusable filename: "${filename}"`);
    }
    const dir = this.docsDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(dir, filename));
    const ext = path.extname(filename).toLowerCase();
    return this.deps.db.upsertProjectDoc({
      projectId,
      filename,
      mime: MIME_BY_EXTENSION[ext] ?? null,
      sizeBytes: stat.size,
    });
  }

  /** Renderer path: OS file picker (main-side — the renderer has no fs). */
  async addDocsViaDialog(projectId: string, win: BrowserWindow | null): Promise<ProjectDocRecord[]> {
    this.mustGet(projectId);
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Add reference documents',
          properties: ['openFile', 'multiSelections'],
        })
      : await dialog.showOpenDialog({
          title: 'Add reference documents',
          properties: ['openFile', 'multiSelections'],
        });
    if (result.canceled) return [];
    const added: ProjectDocRecord[] = [];
    const errors: string[] = [];
    for (const filePath of result.filePaths) {
      try {
        added.push(this.addDocFromPath(projectId, filePath));
      } catch (err) {
        errors.push(`${path.basename(filePath)}: ${String(err)}`);
      }
    }
    if (added.length === 0 && errors.length > 0) throw new Error(errors.join('; '));
    return added;
  }

  removeDoc(projectId: string, docId: string): void {
    const doc = this.deps.db.getProjectDocById(docId);
    // Silo check: the doc must belong to the project named in the request.
    if (!doc || doc.projectId !== projectId) throw new Error('Document not found in this project.');
    this.deps.db.removeProjectDoc(docId);
    try {
      fs.rmSync(path.join(this.docsDir(projectId), doc.filename), { force: true });
    } catch {
      // Row is gone; a stray file cannot be listed or read again.
    }
  }

  /**
   * Agent-facing doc read. The filename must be a plain basename matching a
   * DB row for THIS project — the path is rebuilt from trusted parts, so
   * traversal input dies here regardless of what the model sends.
   */
  readDocText(
    projectId: string,
    filename: string,
  ): { ok: true; text: string } | { ok: false; message: string } {
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > 200) {
      return { ok: false, message: 'filename must be a non-empty string (max 200 chars).' };
    }
    if (path.basename(filename) !== filename || filename.includes('..')) {
      return { ok: false, message: 'filename must be a plain filename, not a path.' };
    }
    const doc = this.deps.db.getProjectDoc(projectId, filename);
    if (!doc) {
      return {
        ok: false,
        message: `No document named "${filename}" in this project. Use list_project_docs to see what exists.`,
      };
    }
    const ext = path.extname(doc.filename).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        message: `"${filename}" is ${ext || 'a binary format'} — only text formats are readable in v1.`,
      };
    }
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.docsDir(projectId), doc.filename), 'utf8');
    } catch (err) {
      return { ok: false, message: `Could not read "${filename}": ${String(err).slice(0, 200)}` };
    }
    if (text.length > DOC_READ_MAX_CHARS) {
      return {
        ok: true,
        text:
          text.slice(0, DOC_READ_MAX_CHARS) +
          `\n\n[truncated: showing ${DOC_READ_MAX_CHARS.toLocaleString()} of ${text.length.toLocaleString()} characters]`,
      };
    }
    return { ok: true, text };
  }

  // ── linked folders (v14) ───────────────────────────────────────────────
  //
  // The docs invariants deliberately RELAX here, in exactly one way: a linked
  // folder is a LIVE view of the user's own files — nothing is copied, edits
  // land immediately, unlinking touches nothing on disk. What does not relax:
  // every read re-resolves and re-contains the path per call (a symlink can
  // appear inside a linked tree AFTER linking), and the data dir can never be
  // reached through a linked folder in either direction.

  listFolders(projectId: string): ProjectFolderRecord[] {
    return this.deps.db.listProjectFolders(projectId);
  }

  linkFolder(projectId: string, dir: string): ProjectFolderRecord {
    this.mustGet(projectId);
    // Containment, same posture as addDocFromPath — realpath first so a
    // symlink cannot smuggle the data dir past the check. Both directions:
    // a folder INSIDE the data dir leaks silo/db files, and a folder that
    // CONTAINS the data dir (e.g. the home directory) hands the agent
    // contrail.db through list/read.
    const real = fs.realpathSync(dir);
    const dataRoot = fs.realpathSync(dataDir());
    if (real === dataRoot || real.startsWith(dataRoot + path.sep)) {
      throw new Error('Folders inside the Contrail data directory cannot be linked.');
    }
    if (dataRoot.startsWith(real + path.sep)) {
      throw new Error(
        'This folder contains the Contrail data directory — link a more specific folder instead.',
      );
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`Not a folder: ${dir}`);
    const name = path.basename(real);
    if (!name || name.startsWith('.')) throw new Error(`Unusable folder name: "${name}"`);
    // The basename is the agent-facing handle, so it must be unambiguous
    // within the project (and the same path can only be linked once).
    for (const existing of this.deps.db.listProjectFolders(projectId)) {
      if (existing.path.toLowerCase() === real.toLowerCase()) {
        throw new Error('That folder is already linked to this project.');
      }
      if (path.basename(existing.path).toLowerCase() === name.toLowerCase()) {
        throw new Error(
          `A folder named "${path.basename(existing.path)}" is already linked — sessions name ` +
            'folders by basename, so link a differently-named folder (or unlink the other one).',
        );
      }
    }
    return this.deps.db.insertProjectFolder({ projectId, path: real });
  }

  /** Renderer path: OS folder picker (main-side — the renderer has no fs). */
  async linkFolderViaDialog(
    projectId: string,
    win: BrowserWindow | null,
  ): Promise<ProjectFolderRecord | null> {
    this.mustGet(projectId);
    const opts = {
      title: 'Link a local folder (read live by this project’s sessions)',
      properties: ['openDirectory' as const],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled || result.filePaths.length === 0) return null;
    return this.linkFolder(projectId, result.filePaths[0]!);
  }

  /** Unlink removes the ROW only — the folder and its files are the user's. */
  unlinkFolder(projectId: string, folderId: string): void {
    const folder = this.deps.db.getProjectFolderById(folderId);
    // Silo check: the folder must belong to the project named in the request.
    if (!folder || folder.projectId !== projectId) {
      throw new Error('Folder not found in this project.');
    }
    this.deps.db.removeProjectFolder(folderId);
  }

  /**
   * Agent-facing live listing: the CURRENT text files of every linked folder,
   * bounded (depth, count, symlinks skipped) and truncation-honest.
   */
  listFolderFiles(projectId: string): Array<{
    folder: string;
    path: string;
    files: Array<{ path: string; size_bytes: number }>;
    truncated: boolean;
    unavailable?: string;
  }> {
    const out: ReturnType<ProjectService['listFolderFiles']> = [];
    for (const rec of this.deps.db.listProjectFolders(projectId)) {
      const entry = {
        folder: path.basename(rec.path),
        path: rec.path,
        files: [] as Array<{ path: string; size_bytes: number }>,
        truncated: false,
      };
      let root: string;
      try {
        root = fs.realpathSync(rec.path);
        if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
      } catch {
        out.push({ ...entry, unavailable: 'the linked folder no longer exists (or is unreadable)' });
        continue;
      }
      const walk = (dir: string, rel: string, depthLeft: number): void => {
        if (entry.truncated) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return; // an unreadable subdirectory is skipped, not fatal
        }
        for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.files.length >= FOLDER_LIST_MAX_FILES) {
            entry.truncated = true;
            return;
          }
          // Symlinks are skipped OUTRIGHT — following them re-opens every
          // containment question (a link to the data dir, a link cycle).
          if (d.isSymbolicLink()) continue;
          if (d.name.startsWith('.')) continue;
          const p = path.join(dir, d.name);
          if (d.isDirectory()) {
            if (FOLDER_SKIP_DIRS.has(d.name.toLowerCase())) continue;
            if (depthLeft > 0) walk(p, rel ? `${rel}/${d.name}` : d.name, depthLeft - 1);
            continue;
          }
          if (!d.isFile()) continue;
          if (!TEXT_EXTENSIONS.has(path.extname(d.name).toLowerCase())) continue;
          let size = 0;
          try {
            size = fs.statSync(p).size;
          } catch {
            continue;
          }
          entry.files.push({ path: rel ? `${rel}/${d.name}` : d.name, size_bytes: size });
        }
      };
      walk(root, '', FOLDER_WALK_MAX_DEPTH);
      out.push(entry);
    }
    return out;
  }

  /**
   * Agent-facing live read of one file inside a linked folder. THE
   * security-load-bearing path of the feature: the folder is resolved from
   * the project's rows by basename, the relative path is resolved under it,
   * and the RESULT is realpath'd and re-checked against the re-realpath'd
   * root — so neither `..`, an absolute path, nor a symlink planted inside
   * the tree after linking can escape it.
   */
  readFolderFile(
    projectId: string,
    folderName: string,
    relPath: string,
  ): { ok: true; text: string } | { ok: false; message: string } {
    const resolved = this.resolveFolderPath(projectId, folderName, relPath);
    if (!resolved.ok) return resolved;
    const { real, stat } = resolved;
    const ext = path.extname(real).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        message: `"${relPath}" is ${ext || 'a binary format'} — only text formats are readable in v1.`,
      };
    }
    if (stat.size > DOC_MAX_BYTES) {
      return {
        ok: false,
        message: `"${relPath}" is ${Math.round(stat.size / 1024 / 1024)}MB — too large to read (limit 25MB).`,
      };
    }
    let text: string;
    try {
      text = fs.readFileSync(real, 'utf8');
    } catch (err) {
      return { ok: false, message: `Could not read "${relPath}": ${String(err).slice(0, 200)}` };
    }
    if (text.length > DOC_READ_MAX_CHARS) {
      return {
        ok: true,
        text:
          text.slice(0, DOC_READ_MAX_CHARS) +
          `\n\n[truncated: showing ${DOC_READ_MAX_CHARS.toLocaleString()} of ${text.length.toLocaleString()} characters]`,
      };
    }
    return { ok: true, text };
  }

  /**
   * The shared containment chain behind every agent-facing linked-folder
   * access — factored so the text-read path and the bulk-load path cannot
   * drift apart on the security-load-bearing part: folder resolved from the
   * PROJECT's rows by basename, the relative path resolved under it, and the
   * RESULT realpath'd and re-checked against the re-realpath'd root, so
   * neither `..`, an absolute path, nor a symlink planted inside the tree
   * after linking can escape it.
   */
  private resolveFolderPath(
    projectId: string,
    folderName: string,
    relPath: string,
  ): { ok: true; real: string; stat: fs.Stats } | { ok: false; message: string } {
    if (typeof folderName !== 'string' || folderName.length === 0 || folderName.length > 255) {
      return { ok: false, message: 'folder must be a folder name from list_project_files.' };
    }
    if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 1000) {
      return { ok: false, message: 'path must be a non-empty relative path (max 1000 chars).' };
    }
    const rec = this.deps.db
      .listProjectFolders(projectId)
      .find((f) => path.basename(f.path).toLowerCase() === folderName.toLowerCase());
    if (!rec) {
      return {
        ok: false,
        message: `No linked folder named "${folderName}" in this project. Use list_project_files to see what exists.`,
      };
    }
    // Friendly early rejects; the realpath containment below is the real guard.
    if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
      return { ok: false, message: 'path must be relative to the folder, without "..".' };
    }
    let root: string;
    let real: string;
    try {
      root = fs.realpathSync(rec.path);
    } catch {
      return { ok: false, message: 'The linked folder no longer exists — unlink it, or restore the folder.' };
    }
    try {
      real = fs.realpathSync(path.resolve(root, relPath));
    } catch {
      return { ok: false, message: `No file at "${relPath}" in "${folderName}".` };
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      return { ok: false, message: 'That path resolves outside the linked folder — refused.' };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      return { ok: false, message: `No file at "${relPath}" in "${folderName}".` };
    }
    if (!stat.isFile()) {
      return { ok: false, message: `"${relPath}" is not a file.` };
    }
    return { ok: true, real, stat };
  }

  /**
   * Resolve a linked-folder CSV to its absolute path for a bulk load — the
   * same guard chain as readFolderFile, but returning the PATH (the engine
   * freezes the bytes itself) with no text-read truncation. CSV only: this
   * hands a file to an org-bound pipeline, so the allowlist is exactly the
   * format that pipeline speaks. Size is capped by the engine's
   * bulkLoad.maxFileBytes when it stats the file again at freeze time.
   */
  resolveFolderDataFile(
    projectId: string,
    folderName: string,
    relPath: string,
  ): { ok: true; absPath: string; size: number } | { ok: false; message: string } {
    const resolved = this.resolveFolderPath(projectId, folderName, relPath);
    if (!resolved.ok) return resolved;
    const ext = path.extname(resolved.real).toLowerCase();
    if (ext !== '.csv') {
      return {
        ok: false,
        message: `"${relPath}" is ${ext || 'not a .csv file'} — bulk loads take .csv files only.`,
      };
    }
    return { ok: true, absPath: resolved.real, size: resolved.stat.size };
  }

  // ── notes ──────────────────────────────────────────────────────────────

  listNotes(projectId: string): ProjectNoteRecord[] {
    return this.deps.db.listProjectNotes(projectId);
  }

  addNote(
    projectId: string,
    body: string,
    author: 'user' | 'agent',
    sessionId?: string | null,
  ): ProjectNoteRecord {
    this.mustGet(projectId);
    const trimmed = body.trim();
    if (!trimmed) throw new Error('Note body is empty.');
    if (trimmed.length > 10_000) throw new Error('Note body exceeds 10,000 characters.');
    return this.deps.db.addProjectNote({ projectId, sessionId, author, body: trimmed });
  }
}
