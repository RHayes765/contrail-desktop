import { dialog, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDir,
  type EngineDeps,
  type ProjectDocRecord,
  type ProjectNoteRecord,
  type ProjectRecord,
} from '@contrail/engine';
import type {
  BindingView,
  EnvRole,
  ProjectDocView,
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
