import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, DEFAULT_CONFIG, type EngineDeps } from '@contrail/engine';
import type { PushChannel, PushEvents, SnapshotStatusView } from '@contrail/shared';
import { SnapshotService, type SnapshotWorkerBridge } from '../main/services/snapshots.js';
import { DiffService, MetadataService } from '../main/services/metadata.js';
import { snapshotBasis } from '../renderer/src/lib/snapshotBasis.js';
import { changeTouchesArtifact } from '../renderer/src/lib/metadataChanged.js';

/**
 * S46 (C), design C §C5: the desktop's freshness readers after a member-scoped
 * re-read (refresh_snapshot members, or the re-baseline after a deploy).
 *   - "synced … ago" and the stale badge read syncedAt — the oldest
 *     whole-type refresh among the default sync types — which a member run
 *     never moves;
 *   - the org-diff cache key and the Diff screen's "results are historical"
 *     flag read the pair lastIndexedAt + artifactCount, which every member
 *     run moves — a removal-only one through the count alone.
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let pushes: Array<{ channel: PushChannel; payload: unknown }>;
let snapshots: SnapshotService;

const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function connection(alias: string): string {
  return db.insertConnection({
    alias,
    instanceUrl: `https://${alias}.example.invalid`,
    loginUrl: 'https://login.example.invalid',
    orgId: `00D${alias.replace(/[^a-z]/g, '').padEnd(12, '0').slice(0, 12)}`,
    orgName: alias,
    orgType: 'sandbox',
    isSandbox: true,
    username: null,
    userId: null,
    grants: {
      metadata_read: true,
      metadata_write: false,
      diagnostics_read: false,
      data_read: false,
      data_write: false,
    },
  }).id;
}

function row(type: string, apiName: string, retrievedAt: string, hash = `h-${type}-${apiName}`) {
  return {
    connectionId: '',
    type,
    apiName,
    filePath: `${type}/${apiName}`,
    contentHash: hash,
    lastModifiedDate: null,
    lastModifiedBy: null,
    retrievedAt,
  };
}

/** A whole sync of ApexClass + CustomObject `hoursAgo` hours ago (no recorded run). */
function wholeSync(connId: string, hoursAgo: number): void {
  const at = iso(hoursAgo * HOUR);
  db.replaceArtifactsForTypes(connId, ['ApexClass'], [
    { ...row('ApexClass', 'InvoiceService', at), connectionId: connId },
    { ...row('ApexClass', 'InvoiceController', at), connectionId: connId },
  ]);
  db.replaceArtifactsForTypes(connId, ['CustomObject'], [
    { ...row('CustomObject', 'Invoice__c', at), connectionId: connId },
  ]);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-snapstatus-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  deps = { db, config: structuredClone(DEFAULT_CONFIG) } as unknown as EngineDeps;
  pushes = [];
  snapshots = new SnapshotService(deps, <C extends PushChannel>(channel: C, payload: PushEvents[C]) => {
    pushes.push({ channel, payload });
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('syncedAt drives "synced … ago" and stale; a member run never moves it', () => {
  it('a member re-read leaves a stale snapshot stale, while lastIndexedAt and the diff basis move', () => {
    const connId = connection('acme-uat');
    wholeSync(connId, 30);
    const before = snapshots.status(connId);
    expect(before.syncedAt).not.toBeNull();
    expect(Date.now() - Date.parse(before.syncedAt!)).toBeGreaterThan(29 * HOUR);
    expect(before.stale).toBe(true);

    // The re-baseline after a deploy re-reads ONE class now.
    db.replaceArtifactRows(
      connId,
      [],
      [{ ...row('ApexClass', 'InvoiceService', iso(0), 'h-new'), connectionId: connId }],
    );
    const after = snapshots.status(connId);
    expect(after.syncedAt).toBe(before.syncedAt);
    expect(after.stale).toBe(true);
    expect(after.lastIndexedAt).not.toBe(before.lastIndexedAt);
    expect(after.artifactCount).toBe(before.artifactCount);
    expect(snapshotBasis(after)).not.toBe(snapshotBasis(before));
  });

  it('a whole sync of every default type moves syncedAt and clears stale', () => {
    const connId = connection('acme-uat');
    wholeSync(connId, 30);
    expect(snapshots.status(connId).stale).toBe(true);
    wholeSync(connId, 0);
    const s = snapshots.status(connId);
    expect(Date.now() - Date.parse(s.syncedAt!)).toBeLessThan(HOUR);
    expect(s.stale).toBe(false);
  });

  it('rows of a type outside the default sync types do not pin syncedAt', () => {
    const connId = connection('acme-uat');
    wholeSync(connId, 1);
    // Report is explicit-refresh-only (not in snapshot.types): an old Report
    // row must not make the whole snapshot read as stale.
    expect(DEFAULT_CONFIG.snapshot.types).not.toContain('Report');
    db.replaceArtifactsForTypes(connId, ['Report'], [
      { ...row('Report', 'Sales/Pipeline', iso(72 * HOUR)), connectionId: connId },
    ]);
    const s = snapshots.status(connId);
    expect(Date.now() - Date.parse(s.syncedAt!)).toBeLessThan(2 * HOUR);
    expect(s.stale).toBe(false);
  });

  it('a recorded whole run newer than the oldest row is what "synced" reports (the lastRun guard)', () => {
    const connId = connection('acme-uat');
    wholeSync(connId, 30);
    db.insertMetadataSnapshot({
      connectionId: connId,
      kind: 'refresh',
      types: DEFAULT_CONFIG.snapshot.types,
      artifactCount: 3,
    });
    const s = snapshots.status(connId);
    expect(Date.now() - Date.parse(s.syncedAt!)).toBeLessThan(HOUR);
    expect(s.stale).toBe(false);
  });

  it('a never-synced connection reports null and is not stale', () => {
    const connId = connection('acme-new');
    const s = snapshots.status(connId);
    expect(s.syncedAt).toBeNull();
    expect(s.lastIndexedAt).toBeNull();
    expect(s.stale).toBe(false);
  });
});

describe('a removal-only member run moves the count, not the timestamp — the diff caches must see it', () => {
  it('lastIndexedAt is unchanged, artifactCount is lower, and the org-diff cache key differs', async () => {
    const a = connection('acme-uat');
    const b = connection('acme-prod');
    wholeSync(a, 2);
    wholeSync(b, 2);
    const fakeBridge = { diffPairs: async () => [] } as unknown as SnapshotWorkerBridge;
    const diff = new DiffService(deps, fakeBridge, new MetadataService(deps));
    const first = await diff.diffScope(a, b);
    expect(first.cached).toBeFalsy();
    expect((await diff.diffScope(a, b)).cached).toBe(true);

    const before = snapshots.status(b);
    // A destructive deploy of a class: the re-baseline removes its row only.
    db.replaceArtifactRows(b, [{ type: 'ApexClass', apiName: 'InvoiceController' }], []);
    const after = snapshots.status(b);
    expect(after.lastIndexedAt).toBe(before.lastIndexedAt);
    expect(after.artifactCount).toBe(before.artifactCount - 1);
    expect(after.syncedAt).toBe(before.syncedAt);
    // The Diff screen's "results are historical" basis differs…
    expect(snapshotBasis(after)).not.toBe(snapshotBasis(before));
    // …and so does main's cache key: the next scope is recomputed and shows the removal.
    const recomputed = await diff.diffScope(a, b);
    expect(recomputed.cached).toBeFalsy();
    expect(recomputed.entries).toContainEqual(
      expect.objectContaining({ type: 'ApexClass', apiName: 'InvoiceController', status: 'removed' }),
    );
  });

  it('snapshotBasis: same timestamp with a different count is a different basis', () => {
    const base = {
      connectionId: 'c',
      artifactCount: 10,
      edgeCount: 0,
      lastIndexedAt: '2026-11-18T08:00:00.000Z',
      syncedAt: '2026-11-17T08:00:00.000Z',
      syncing: false,
      progress: null,
      syncElapsedMs: null,
      typicalDurationMs: null,
      stale: false,
    } satisfies SnapshotStatusView;
    expect(snapshotBasis(base)).toBe('2026-11-18T08:00:00.000Z|10');
    expect(snapshotBasis({ ...base, artifactCount: 9 })).not.toBe(snapshotBasis(base));
    // syncedAt is not part of it: a member run never moves syncedAt.
    expect(snapshotBasis({ ...base, syncedAt: null })).toBe(snapshotBasis(base));
    expect(snapshotBasis({ ...base, lastIndexedAt: null })).toBe('|10');
    expect(snapshotBasis(undefined)).toBeNull();
  });
});

describe('member runs reach the renderer, and never record a whole-sync run', () => {
  it('onMembersChanged pushes metadata:changed with the refreshed and removed members only', () => {
    snapshots.onMembersChanged({
      connectionId: 'c-1',
      members: [
        { type: 'ApexClass', api_name: 'InvoiceService', outcome: 'refreshed', unit: 'ApexClass:invoiceservice' },
        { type: 'ApexClass', api_name: 'OldHelper', outcome: 'removed' },
        { type: 'Profile', api_name: 'Admin', outcome: 'skipped', reason: 'profile' },
      ],
      units: ['ApexClass:InvoiceService', 'ApexClass:OldHelper'],
    });
    expect(pushes).toEqual([
      {
        channel: 'metadata:changed',
        payload: {
          connectionId: 'c-1',
          members: [
            {
              type: 'ApexClass',
              apiName: 'InvoiceService',
              outcome: 'refreshed',
              unit: 'ApexClass:invoiceservice',
            },
            { type: 'ApexClass', apiName: 'OldHelper', outcome: 'removed', unit: null },
          ],
          units: ['ApexClass:InvoiceService', 'ApexClass:OldHelper'],
        },
      },
    ]);
    // Nothing changed → nothing pushed.
    snapshots.onMembersChanged({
      connectionId: 'c-1',
      members: [{ type: 'Profile', api_name: 'Admin', outcome: 'skipped', reason: 'profile' }],
      units: [],
    });
    expect(pushes).toHaveLength(1);
  });

  it('every member skipped, yet a unit written: metadata:changed is pushed with no members', () => {
    // A deploy of one field the re-read parent no longer holds: the field is
    // skipped (child_not_in_parent), but the object's document and rows were
    // rewritten — the status, the counts and an open Diff's basis moved.
    snapshots.onMembersChanged({
      connectionId: 'c-1',
      members: [
        {
          type: 'CustomField',
          api_name: 'Invoice__c.Due__c',
          unit: 'CustomObject:Invoice__c',
          outcome: 'skipped',
          reason: 'child_not_in_parent',
        },
      ],
      units: ['CustomObject:Invoice__c'],
    });
    expect(pushes).toEqual([
      {
        channel: 'metadata:changed',
        payload: { connectionId: 'c-1', members: [], units: ['CustomObject:Invoice__c'] },
      },
    ]);
    // The open CustomObject is the document that run re-wrote: it reloads.
    const payload = pushes[0]!.payload as PushEvents['metadata:changed'];
    expect(changeTouchesArtifact({ type: 'CustomObject', apiName: 'invoice__c' }, payload)).toBe(true);
    expect(changeTouchesArtifact({ type: 'CustomObject', apiName: 'Account' }, payload)).toBe(false);
  });

  it("a member's re-read document rides the push, so the open Flow or CustomObject reloads", () => {
    // deactivate_flow deploys a FlowDefinition: the snapshot holds only the
    // Flow row, which the re-read rewrote. A CustomField re-reads its object.
    snapshots.onMembersChanged({
      connectionId: 'c-1',
      members: [
        { type: 'FlowDefinition', api_name: 'Send_Invoice', outcome: 'refreshed', unit: 'Flow:Send_Invoice' },
        {
          type: 'CustomField',
          api_name: 'Invoice__c.Due__c',
          outcome: 'refreshed',
          unit: 'CustomObject:Invoice__c',
        },
      ],
      units: ['Flow:Send_Invoice', 'CustomObject:Invoice__c'],
    });
    const payload = pushes[0]!.payload as PushEvents['metadata:changed'];
    expect(payload.members).toEqual([
      { type: 'FlowDefinition', apiName: 'Send_Invoice', outcome: 'refreshed', unit: 'Flow:Send_Invoice' },
      {
        type: 'CustomField',
        apiName: 'Invoice__c.Due__c',
        outcome: 'refreshed',
        unit: 'CustomObject:Invoice__c',
      },
    ]);
    // The rule the Metadata screen applies to its open detail — the member's
    // own document counts even when the push's unit list is not consulted.
    const membersOnly = { members: payload.members, units: [] };
    expect(changeTouchesArtifact({ type: 'Flow', apiName: 'Send_Invoice' }, membersOnly)).toBe(true);
    expect(changeTouchesArtifact({ type: 'CustomObject', apiName: 'Invoice__c' }, membersOnly)).toBe(true);
    // The member itself, by type and name (case-insensitive name).
    expect(changeTouchesArtifact({ type: 'CustomField', apiName: 'invoice__c.due__c' }, membersOnly)).toBe(
      true,
    );
    // Another flow, or a FlowDefinition-typed name match on the wrong type, does not.
    expect(changeTouchesArtifact({ type: 'Flow', apiName: 'Other_Flow' }, payload)).toBe(false);
    expect(changeTouchesArtifact({ type: 'ApexClass', apiName: 'Send_Invoice' }, payload)).toBe(false);
  });

  it('a member completion observed by the Sync loop inserts no metadata_snapshots row', async () => {
    const connId = connection('acme-uat');
    wholeSync(connId, 30);
    let calls = 0;
    (deps as unknown as { engine: unknown }).engine = {
      refresh: async () => {
        calls += 1;
        if (calls === 1) {
          return { status: 'in_progress', state: { jobId: 'members-abc', progress: 'retrieving members' } };
        }
        // The observed job turned out to be a member run (observeJobId).
        return {
          status: 'complete',
          kind: 'members',
          summary: { members: [], duration_ms: 5 },
        };
      },
    };
    expect(snapshots.sync(connId).status).toBe('started');
    // POLL_MS (1.2 s) separates the two observations.
    for (let i = 0; i < 40 && !pushes.some((p) => (p.payload as { done?: boolean }).done); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = pushes.find((p) => p.channel === 'metadata:progress' && (p.payload as { done: boolean }).done);
    expect(done?.payload).toMatchObject({ connectionId: connId, done: true, error: null });
    expect(db.getSnapshotStatus(connId).lastRun).toBeNull();
    expect(snapshots.status(connId).stale).toBe(true);
  });
});
