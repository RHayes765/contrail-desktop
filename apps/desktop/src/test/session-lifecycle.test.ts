import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, type EngineDeps } from '@contrail/engine';
import { AgentSessionManager } from '../main/services/agentRuntime.js';

/**
 * Session lifecycle (S13): a session you never spoke in is not history,
 * clicking a past session continues it, and the human can rename or delete.
 *
 * These run against a REAL database and real files — the point of the feature
 * is what survives on disk, so a fake would test the wrong thing.
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let pushes: Array<{ channel: string; payload: unknown }>;

function makeManager(): AgentSessionManager {
  return new AgentSessionManager(deps, {} as never, 'unused-child-path', (channel, payload) => {
    pushes.push({ channel, payload });
  });
}

/** A session row plus the files a real one owns. */
function seedSession(over: { title?: string | null; tokens?: number; cost?: number } = {}): string {
  const id = db.createAgentSession({
    projectId: 'p1',
    title: over.title ?? null,
    model: 'claude-haiku-4-5',
  });
  const transcriptPath = path.join(tmp, 'sessions', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, '{"kind":"session"}\n', 'utf8');
  db.setAgentSessionTranscriptPath(id, transcriptPath);
  // The SDK's per-session cwd, which resume keys history by.
  fs.mkdirSync(path.join(tmp, 'sessions', id, 'cwd'), { recursive: true });
  if (over.tokens || over.cost) {
    db.finishAgentSession(
      id,
      { inputTokens: over.tokens ?? 0, outputTokens: 0, cacheReadTokens: 0, costUsd: over.cost ?? 0 },
      'ended',
    );
  }
  return id;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-sesslife-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  db.createProject({ name: 'P', description: null });
  pushes = [];
  deps = { db, audit: { record: () => undefined } } as unknown as EngineDeps;
});

afterEach(() => {
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a session nobody spoke in is not saved', () => {
  it('identifies exactly the sessions with no title, no tokens, no cost', () => {
    const empty = seedSession();
    const spoken = seedSession({ title: 'what does Send_Invoice do?', tokens: 900, cost: 0.004 });
    // A RENAMED but unspoken session is deliberately kept: naming it is a
    // statement that you want it.
    const named = seedSession({ title: 'saved for later' });

    const ids = db.listEmptyAgentSessions().map((s) => s.id);
    expect(ids).toEqual([empty]);
    expect(ids).not.toContain(spoken);
    expect(ids).not.toContain(named);
  });

  it('startup discards empty rows AND their files (the crash / walk-away path)', () => {
    const empty = seedSession();
    const spoken = seedSession({ title: 'real work', tokens: 500, cost: 0.002 });
    const emptyTranscript = path.join(tmp, 'sessions', `${empty}.jsonl`);
    const emptyCwd = path.join(tmp, 'sessions', empty);
    expect(fs.existsSync(emptyTranscript)).toBe(true);

    makeManager(); // the constructor sweeps

    expect(db.getAgentSession(empty)).toBeNull();
    expect(fs.existsSync(emptyTranscript)).toBe(false);
    expect(fs.existsSync(emptyCwd)).toBe(false);
    // The session with actual conversation is untouched.
    expect(db.getAgentSession(spoken)?.title).toBe('real work');
    expect(fs.existsSync(path.join(tmp, 'sessions', `${spoken}.jsonl`))).toBe(true);
  });
});

describe('deleting a session', () => {
  it('removes the row, the transcript, and the resumable cwd', async () => {
    const id = seedSession({ title: 'delete me', tokens: 10, cost: 0.001 });
    const transcript = path.join(tmp, 'sessions', `${id}.jsonl`);
    const cwd = path.join(tmp, 'sessions', id);

    await makeManager().deleteSession(id);

    expect(db.getAgentSession(id)).toBeNull();
    expect(fs.existsSync(transcript)).toBe(false);
    expect(fs.existsSync(cwd)).toBe(false);
    // The list refreshes for the right project.
    expect(pushes.some((p) => p.channel === 'sessions:changed')).toBe(true);
  });

  it('deleting twice is not an error, and an unknown id is a no-op', async () => {
    const manager = makeManager();
    const id = seedSession({ title: 'x', tokens: 1, cost: 0.001 });
    await manager.deleteSession(id);
    await expect(manager.deleteSession(id)).resolves.toBeUndefined();
    await expect(manager.deleteSession('never-existed')).resolves.toBeUndefined();
  });

  it('leaves OTHER sessions and their files alone', async () => {
    const keep = seedSession({ title: 'keep', tokens: 5, cost: 0.001 });
    const drop = seedSession({ title: 'drop', tokens: 5, cost: 0.001 });
    await makeManager().deleteSession(drop);
    expect(db.getAgentSession(keep)?.title).toBe('keep');
    expect(fs.existsSync(path.join(tmp, 'sessions', `${keep}.jsonl`))).toBe(true);
  });
});

describe('renaming a session', () => {
  it('stores the new name and returns the updated view', () => {
    const id = seedSession({ title: 'untitled-ish', tokens: 5, cost: 0.001 });
    const view = makeManager().rename(id, '  Renewal analysis  ');
    expect(view.title).toBe('Renewal analysis'); // trimmed
    expect(db.getAgentSession(id)?.title).toBe('Renewal analysis');
  });

  it('refuses a blank name and an unknown session', () => {
    const manager = makeManager();
    const id = seedSession({ title: 'keep', tokens: 5, cost: 0.001 });
    expect(() => manager.rename(id, '   ')).toThrow(/name/i);
    expect(db.getAgentSession(id)?.title).toBe('keep'); // unchanged
    expect(() => manager.rename('ghost', 'x')).toThrow(/not found/);
  });

  it('a renamed empty session survives the startup sweep', () => {
    const id = seedSession();
    // Rename BEFORE any manager exists — constructing one sweeps, and an
    // as-yet-unnamed empty session is exactly what it is meant to remove.
    db.setAgentSessionTitle(id, 'parked for Monday');
    makeManager(); // now sweep: the name protects it
    expect(db.getAgentSession(id)?.title).toBe('parked for Monday');
  });
});
