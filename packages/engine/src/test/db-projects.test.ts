import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';

/**
 * The v6 project/session CRUD surface added for the desktop UI (Session 4).
 * Pure row logic — file handling lives in the desktop's ProjectService.
 */

let tmp: string;
let db: ContrailDb;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-proj-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('projects CRUD', () => {
  it('create returns the full record and list/get/find agree', () => {
    const created = db.createProject({ name: 'Acme', description: 'CPQ rollout' });
    expect(created.name).toBe('Acme');
    expect(created.description).toBe('CPQ rollout');
    expect(created.instructions).toBeNull();
    expect(db.listProjects().map((p) => p.id)).toContain(created.id);
    expect(db.getProject(created.id)?.name).toBe('Acme');
    expect(db.findProjectByName('Acme')?.id).toBe(created.id);
  });

  it('update patches only what was passed and bumps updated_at', () => {
    const p = db.createProject({ name: 'Acme' });
    const updated = db.updateProject(p.id, { instructions: 'Use LF4_ prefix' });
    expect(updated?.instructions).toBe('Use LF4_ prefix');
    expect(updated?.name).toBe('Acme');
    // explicit null clears; undefined preserves
    expect(db.updateProject(p.id, { description: null })?.instructions).toBe('Use LF4_ prefix');
    expect(db.updateProject('nope', {})).toBeNull();
  });

  it('delete removes the silo rows but keeps session history', () => {
    const p = db.createProject({ name: 'Doomed' });
    db.addProjectBinding(p.id, 'conn-1', 'dev');
    db.upsertProjectDoc({ projectId: p.id, filename: 'a.md', mime: 'text/markdown', sizeBytes: 5 });
    db.addProjectNote({ projectId: p.id, author: 'user', body: 'note' });
    const sessionId = db.createAgentSession({ projectId: p.id, title: 't', model: 'm' });
    db.deleteProject(p.id);
    expect(db.getProject(p.id)).toBeNull();
    expect(db.listProjectBindings(p.id)).toEqual([]);
    expect(db.listProjectDocs(p.id)).toEqual([]);
    expect(db.listProjectNotes(p.id)).toEqual([]);
    expect(db.getAgentSession(sessionId)?.projectId).toBe(p.id);
  });
});

describe('bindings', () => {
  it('add/remove/list round-trips and re-add after remove changes the role', () => {
    const p = db.createProject({ name: 'P' });
    db.addProjectBinding(p.id, 'conn-1', 'dev');
    expect(db.listProjectBindings(p.id)).toEqual([{ connectionId: 'conn-1', envRole: 'dev' }]);
    db.removeProjectBinding(p.id, 'conn-1');
    db.addProjectBinding(p.id, 'conn-1', 'prod');
    expect(db.listProjectBindings(p.id)).toEqual([{ connectionId: 'conn-1', envRole: 'prod' }]);
  });
});

describe('docs & notes rows', () => {
  it('upsert replaces the row for the same filename in the same project only', () => {
    const p1 = db.createProject({ name: 'P1' });
    const p2 = db.createProject({ name: 'P2' });
    const first = db.upsertProjectDoc({ projectId: p1.id, filename: 'x.md', mime: 'text/markdown', sizeBytes: 10 });
    const second = db.upsertProjectDoc({ projectId: p1.id, filename: 'x.md', mime: 'text/markdown', sizeBytes: 99 });
    expect(second.id).toBe(first.id);
    expect(db.listProjectDocs(p1.id)).toHaveLength(1);
    expect(db.listProjectDocs(p1.id)[0]?.sizeBytes).toBe(99);
    // Same filename in another project is a separate doc — silo by key.
    db.upsertProjectDoc({ projectId: p2.id, filename: 'x.md', mime: null, sizeBytes: 1 });
    expect(db.listProjectDocs(p1.id)).toHaveLength(1);
    expect(db.listProjectDocs(p2.id)).toHaveLength(1);
    expect(db.getProjectDoc(p2.id, 'x.md')?.sizeBytes).toBe(1);
  });

  it('notes carry author + optional session and list in creation order', () => {
    const p = db.createProject({ name: 'P' });
    db.addProjectNote({ projectId: p.id, author: 'user', body: 'first' });
    db.addProjectNote({ projectId: p.id, sessionId: 's1', author: 'agent', body: 'second' });
    const notes = db.listProjectNotes(p.id);
    expect(notes.map((n) => n.body)).toEqual(['first', 'second']);
    expect(notes[1]?.author).toBe('agent');
    expect(notes[1]?.sessionId).toBe('s1');
  });
});

describe('agent session rows', () => {
  it('create → title → usage → finish lifecycle', () => {
    const p = db.createProject({ name: 'P' });
    const id = db.createAgentSession({ projectId: p.id, title: null, model: 'claude-haiku-4-5' });
    db.setAgentSessionTranscriptPath(id, 'C:/x/t.jsonl');
    db.setAgentSessionTitle(id, 'How many accounts?');
    db.updateAgentSessionUsage(id, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, costUsd: 0.01 });
    let rec = db.getAgentSession(id);
    expect(rec?.status).toBe('active');
    expect(rec?.title).toBe('How many accounts?');
    expect(rec?.transcriptPath).toBe('C:/x/t.jsonl');
    expect(rec?.costUsd).toBeCloseTo(0.01);
    db.finishAgentSession(id, { inputTokens: 30, outputTokens: 40, cacheReadTokens: 9, costUsd: 0.02 }, 'ended');
    rec = db.getAgentSession(id);
    expect(rec?.status).toBe('ended');
    expect(rec?.inputTokens).toBe(30);
    expect(rec?.endedAt).toBeTruthy();
    expect(db.listAgentSessions(p.id).map((s) => s.id)).toContain(id);
  });
});

describe('v7: resume columns', () => {
  it('sdk session id + effort persist and reopen flips an ended row back to active', () => {
    const p = db.createProject({ name: 'P' });
    const id = db.createAgentSession({ projectId: p.id, title: 't', model: 'claude-haiku-4-5', effort: 'high' });
    db.setAgentSessionSdkId(id, 'sdk-abc');
    let rec = db.getAgentSession(id);
    expect(rec?.sdkSessionId).toBe('sdk-abc');
    expect(rec?.effort).toBe('high');
    db.finishAgentSession(id, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, costUsd: 0.01 }, 'ended');
    db.reopenAgentSession(id);
    rec = db.getAgentSession(id);
    expect(rec?.status).toBe('active');
    expect(rec?.endedAt).toBeNull();
    // usage survives the reopen — resume accumulates on top of it
    expect(rec?.costUsd).toBeCloseTo(0.01);
  });
});

describe('app locks (cross-process advisory leases)', () => {
  it('grants, refuses live foreign locks, allows takeover of expired or own locks', () => {
    expect(db.acquireAppLock('snapshot:c1', 'desktop-a', 60_000)).toBe(true);
    // Someone else, lock still live → refused.
    expect(db.acquireAppLock('snapshot:c1', 'plugin-b', 60_000)).toBe(false);
    // The holder itself re-acquires (lease renewal).
    expect(db.acquireAppLock('snapshot:c1', 'desktop-a', 60_000)).toBe(true);
    // Expired lock is taken over.
    expect(db.acquireAppLock('snapshot:c2', 'desktop-a', -1000)).toBe(true);
    expect(db.acquireAppLock('snapshot:c2', 'plugin-b', 60_000)).toBe(true);
    // Release only removes the caller's own lock.
    db.releaseAppLock('snapshot:c1', 'plugin-b');
    expect(db.acquireAppLock('snapshot:c1', 'plugin-b', 60_000)).toBe(false);
    db.releaseAppLock('snapshot:c1', 'desktop-a');
    expect(db.acquireAppLock('snapshot:c1', 'plugin-b', 60_000)).toBe(true);
  });
});

describe('snapshot status', () => {
  it('reports empty for unknown connections and records runs', () => {
    const empty = db.getSnapshotStatus('conn-x');
    expect(empty.artifactCount).toBe(0);
    expect(empty.lastIndexedAt).toBeNull();
    expect(empty.lastRun).toBeNull();
    db.insertMetadataSnapshot({ connectionId: 'conn-x', kind: 'baseline', types: ['Flow'], artifactCount: 42 });
    const after = db.getSnapshotStatus('conn-x');
    expect(after.lastRun?.kind).toBe('baseline');
    expect(after.lastRun?.artifactCount).toBe(42);
  });
});
