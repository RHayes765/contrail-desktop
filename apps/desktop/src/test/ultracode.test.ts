import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb, type EngineDeps, type GrantSet } from '@contrail/engine';
import { AgentSessionRun, type SessionSpec } from '../main/services/agentRuntime.js';
import { DeployService } from '../main/services/deploys.js';
import { canonicalReviewHash } from '../main/services/reviewHash.js';
import type { ReviewService, ReviewResult } from '../main/services/reviews.js';

/**
 * THE ULTRACODE GATE (S28). Every test here attacks the mandatory-review
 * invariant: in an Ultracode session, no write proposal reaches the engine
 * unless the EXACT content carries a fresh review; outside Ultracode nothing
 * changes; and the matched review is what the human ends up reading on the
 * approval record.
 */

let tmp: string;
let db: ContrailDb;
let deps: EngineDeps;
let service: DeployService;
let proposed: Array<{ kind: string; content: string }>;
let reviewRequests: number;
/** The fake reviewer: verdict fixed, hash computed by the REAL module. */
let nextVerdict: ReviewResult['verdict'];
let connId: string;
let projectId: string;

const SCRIPT = 'System.debug(1);\ndelete accounts;';

function grants(): GrantSet {
  return {
    metadata_read: true,
    metadata_write: true,
    diagnostics_read: false,
    data_read: true,
    data_write: true,
  };
}

function makeRun(ultracode: boolean, reviewer: ReviewService | null): AgentSessionRun {
  const spec: SessionSpec = {
    project: { id: projectId, name: 'P', description: null, instructions: null },
    bindings: [],
    model: 'claude-haiku-4-5',
    maxTurns: 10,
    maxBudgetUsd: 0.5,
    ultracode,
  };
  return new AgentSessionRun(
    deps,
    spec,
    'session-uc',
    {} as never, // silo unused by these paths
    () => service,
    () => null,
    () => reviewer,
  );
}

function fakeReviewer(): ReviewService {
  return {
    requestReview: async (input: {
      subject: { script?: string };
      notes?: string;
    }): Promise<ReviewResult> => {
      reviewRequests += 1;
      return {
        reviewId: `rev-${reviewRequests}`,
        verdict: nextVerdict,
        findings:
          nextVerdict === 'pass'
            ? []
            : [{ severity: 'blocker', title: 'deletes accounts', detail: 'mass delete' }],
        model: 'claude-sonnet-5',
        at: new Date().toISOString(),
        notes: input.notes ?? null,
        hash: canonicalReviewHash({ kind: 'apex', script: input.subject.script ?? '' }),
      };
    },
  } as unknown as ReviewService;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-uc-'));
  db = new ContrailDb(path.join(tmp, 'test.db'));
  proposed = [];
  reviewRequests = 0;
  nextVerdict = 'concerns';

  connId = db.insertConnection({
    alias: 'uc-org',
    instanceUrl: 'https://uc.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00DU',
    orgName: 'UC',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants: grants(),
  }).id;
  projectId = db.createProject({ name: 'UC Project' }).id;
  db.addProjectBinding(projectId, connId, 'dev');

  const engine = {
    proposeApex: async (_conn: unknown, code: string) => {
      proposed.push({ kind: 'apex', content: code });
      return { request_id: 'req-1', lines: 2 };
    },
    proposeDml: async (_conn: unknown, input: Record<string, unknown>) => {
      proposed.push({ kind: 'dml', content: JSON.stringify(input) });
      return { request_id: 'req-2' };
    },
  };
  deps = { db, audit: { record: () => undefined }, deploys: engine } as unknown as EngineDeps;
  service = new DeployService(deps, () => undefined);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the mandatory gate', () => {
  it('outside Ultracode nothing changes: proposes flow, request_review does not exist', async () => {
    const run = makeRun(false, fakeReviewer());
    const ok = await run.executeCapability('apex_propose', { connection: 'uc-org', code: SCRIPT });
    expect(ok.isError).toBeFalsy();
    expect(proposed).toHaveLength(1);

    const rr = await run.executeCapability('request_review', {
      connection: 'uc-org',
      subject: { script: SCRIPT },
    });
    expect(rr.isError).toBe(true);
    expect(rr.content[0]!.text).toContain('only in Ultracode');
    expect(reviewRequests).toBe(0);
  });

  it('Ultracode refuses an unreviewed propose BEFORE the engine hears of it', async () => {
    const run = makeRun(true, fakeReviewer());
    const result = await run.executeCapability('apex_propose', {
      connection: 'uc-org',
      code: SCRIPT,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('no adversarial review');
    expect(proposed).toHaveLength(0);
  });

  it('review → identical propose passes; ONE changed byte is refused again', async () => {
    const run = makeRun(true, fakeReviewer());
    const review = await run.executeCapability('request_review', {
      connection: 'uc-org',
      subject: { script: SCRIPT },
    });
    expect(review.isError).toBeFalsy();
    expect(review.content[0]!.text).toContain('"verdict"');
    expect(review.content[0]!.text).toContain('content_hash');

    const pass = await run.executeCapability('apex_propose', {
      connection: 'uc-org',
      code: SCRIPT,
    });
    expect(pass.isError).toBeFalsy();
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.content).toBe(SCRIPT);

    const tampered = await run.executeCapability('apex_propose', {
      connection: 'uc-org',
      code: SCRIPT + ' ',
    });
    expect(tampered.isError).toBe(true);
    expect(tampered.content[0]!.text).toContain('no adversarial review');
    expect(proposed).toHaveLength(1);
  });

  it('a FAIL verdict informs but does not block — the human is the authority', async () => {
    nextVerdict = 'fail';
    const run = makeRun(true, fakeReviewer());
    await run.executeCapability('request_review', {
      connection: 'uc-org',
      subject: { script: SCRIPT },
      notes: 'proceeding: the delete is the point of this fix',
    });
    const result = await run.executeCapability('apex_propose', {
      connection: 'uc-org',
      code: SCRIPT,
    });
    expect(result.isError).toBeFalsy();
    expect(proposed).toHaveLength(1);
  });

  it('a stale review (>30 min) is refused with the re-review instruction', async () => {
    const staleReviewer = {
      requestReview: async (input: { subject: { script?: string } }) => ({
        reviewId: 'rev-old',
        verdict: 'pass' as const,
        findings: [],
        model: 'claude-sonnet-5',
        at: new Date(Date.now() - 31 * 60_000).toISOString(),
        notes: null,
        hash: canonicalReviewHash({ kind: 'apex', script: input.subject.script ?? '' }),
      }),
    } as unknown as ReviewService;
    const run = makeRun(true, staleReviewer);
    await run.executeCapability('request_review', {
      connection: 'uc-org',
      subject: { script: SCRIPT },
    });
    const result = await run.executeCapability('apex_propose', {
      connection: 'uc-org',
      code: SCRIPT,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('older than 30 minutes');
    expect(proposed).toHaveLength(0);
  });

  it('dml gate: the review subject is the SAME arguments object, minus connection', async () => {
    const run = makeRun(true, {
      requestReview: async (input: { subject: { dml?: Record<string, unknown> } }) => ({
        reviewId: 'rev-dml',
        verdict: 'pass' as const,
        findings: [],
        model: 'claude-sonnet-5',
        at: new Date().toISOString(),
        notes: null,
        hash: canonicalReviewHash({ kind: 'dml', args: input.subject.dml ?? {} }),
      }),
    } as unknown as ReviewService);

    const dmlArgs = { operation: 'delete', ids: ['001000000000001AAA'] };
    await run.executeCapability('request_review', {
      connection: 'uc-org',
      subject: { dml: { ...dmlArgs, object: 'Account' } },
    });
    // Same content → passes even though the propose adds `connection`.
    const ok = await run.executeCapability('dml_propose', {
      connection: 'uc-org',
      object: 'Account',
      ...dmlArgs,
    });
    expect(ok.isError).toBeFalsy();
    // Different targeting (one more id) → refused.
    const widened = await run.executeCapability('dml_propose', {
      connection: 'uc-org',
      object: 'Account',
      operation: 'delete',
      ids: ['001000000000001AAA', '001000000000002AAA'],
    });
    expect(widened.isError).toBe(true);
  });
});

describe('the review reaches the human', () => {
  it('a matched review rides expectPresentation into review_json and the request view', () => {
    const rec = db.insertDeployRequest({
      connectionId: connId,
      kind: 'apex',
      confirmationCode: 'UCAP-CODE',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      summaryJson: JSON.stringify({ lines: 2, chars: SCRIPT.length }),
      payloadJson: JSON.stringify({ apex: true, code: SCRIPT }),
    });
    const attachment = {
      verdict: 'fail' as const,
      findings: [{ severity: 'blocker' as const, title: 'deletes accounts', detail: 'mass delete' }],
      model: 'claude-sonnet-5',
      at: new Date().toISOString(),
      notes: 'human should look hard',
    };
    service.expectPresentation('session-uc', connId, attachment);
    service.onPresented({
      requestId: rec.id,
      kind: 'apex',
      code: 'UCAP-CODE',
      expiresAt: rec.expiresAt,
      org: { alias: 'uc-org', orgName: 'UC', orgType: 'developer', instanceUrl: 'https://x' },
      changes: [{ label: 'Execute anonymous Apex (2 lines)', warnings: [], detail: SCRIPT }],
      destructive: [],
      results: [],
      blast: [],
      warnings: [],
    } as never);

    const view = service.get(rec.id);
    expect(view.agentReview).not.toBeNull();
    expect(view.agentReview!.verdict).toBe('fail');
    expect(view.agentReview!.findings[0]!.title).toBe('deletes accounts');
    expect(view.agentReview!.notes).toBe('human should look hard');
    // The code still never rides any view field.
    expect(JSON.stringify(view)).not.toContain('UCAP-CODE');
  });
});
