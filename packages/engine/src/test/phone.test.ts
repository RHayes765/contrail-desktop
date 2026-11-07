import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContrailDb } from '../core/db.js';
import { MemoryTokenStore } from '../core/keychain.js';
import { DEFAULT_CONFIG, type ContrailConfig } from '../core/config.js';
import { SnapshotStore } from '../snapshot/store.js';
import {
  ApprovalPageServer,
  type ApprovalPresentation,
  type ApprovalPresenter,
  type ApprovalRequestView,
} from '../deploy/approval.js';
import { createEngineDeps, type EngineDeps } from '../core/deps.js';
import { invokeCapability } from '../capabilities/index.js';
import { emptyGrantSet } from '../core/grants.js';
import type { ApprovalNotifier, NotifyOutcome } from '../core/notify.js';
import type { ApprovalPageOptions } from '../connect/pages.js';

/**
 * S42 (desktop engine): the phone copy of a minted approval. The desktop
 * twist these pin: a NATIVE presentation (the app's Deploy Review — approval
 * is a click, not a code) sends the summary WITHOUT the code, while a page
 * presentation sends it with the code; either way the agent learns only
 * `phone_notification.status`, the code stays out of every tool result, and a
 * notifier that throws cannot fail the proposal.
 */

class RecordingNotifier implements ApprovalNotifier {
  calls: Array<{ view: ApprovalPageOptions; includeCode: boolean }> = [];
  behaviour: 'sent' | 'throw' = 'sent';
  async notify(view: ApprovalPageOptions, opts: { includeCode: boolean }): Promise<NotifyOutcome> {
    this.calls.push({ view, includeCode: opts.includeCode });
    if (this.behaviour === 'throw') throw new Error(`boom ${view.code}`);
    return { status: 'sent' };
  }
  async sendTest() {
    return { ok: true, message: 'ok' };
  }
  status() {
    return { method: 'pushover' as const, configured: true };
  }
  resetCircuit() {}
}

/** Mimics the desktop app's NativeApprovalPresenter: no page, mode 'native'. */
class NativePresenter implements ApprovalPresenter {
  readonly views: ApprovalRequestView[] = [];
  async present(view: ApprovalRequestView): Promise<ApprovalPresentation> {
    this.views.push(view);
    return { url: null, opened: true, mode: 'native' };
  }
  close(): void {}
}

class PagePresenter implements ApprovalPresenter {
  readonly views: ApprovalRequestView[] = [];
  private readonly inner = new ApprovalPageServer(async () => {});
  async present(
    view: ApprovalRequestView,
    statusCheck?: () => { active: boolean; status: string },
    ttlMs?: number,
  ): Promise<ApprovalPresentation> {
    this.views.push(view);
    return this.inner.present(view, statusCheck, ttlMs);
  }
  close(id: string): void {
    this.inner.close(id);
  }
}

let tmp: string;
let db: ContrailDb;

function soapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
}

function stubSalesforce(): void {
  let deploys = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/services/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'AT',
          instance_url: 'https://phone.stub.salesforce.com',
          id: 'https://login.salesforce.com/id/00DP/005P',
          token_type: 'Bearer',
        }),
      );
    }
    if (url.includes('/services/Soap/m/')) {
      const body = String(init?.body ?? '');
      if (body.includes('<met:deploy>')) {
        deploys += 1;
        return new Response(
          soapEnvelope(
            `<deployResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result><id>0Af-phone-${deploys}</id></result>
             </deployResponse>`,
          ),
        );
      }
      if (body.includes('<met:checkDeployStatus>')) {
        return new Response(
          soapEnvelope(
            `<checkDeployStatusResponse xmlns="http://soap.sforce.com/2006/04/metadata">
               <result>
                 <done>true</done><status>Succeeded</status>
                 <success>true</success><checkOnly>true</checkOnly>
                 <numberComponentsTotal>1</numberComponentsTotal>
                 <numberComponentsDeployed>1</numberComponentsDeployed>
                 <numberComponentErrors>0</numberComponentErrors>
                 <numberTestsTotal>0</numberTestsTotal>
                 <numberTestsCompleted>0</numberTestsCompleted>
                 <numberTestErrors>0</numberTestErrors>
                 <details><runTestResult><numTestsRun>0</numTestsRun>
                   <numFailures>0</numFailures></runTestResult></details>
               </result>
             </checkDeployStatusResponse>`,
          ),
        );
      }
      return new Response('unexpected SOAP body', { status: 500 });
    }
    return new Response('not found', { status: 404 });
  });
}

function makeDeps(approvals: ApprovalPresenter, notifier: ApprovalNotifier): EngineDeps {
  const tokens = new MemoryTokenStore();
  const grants = emptyGrantSet();
  grants.metadata_read = true;
  grants.metadata_write = true;
  const conn = db.insertConnection({
    alias: 'phone-org',
    instanceUrl: 'https://phone.stub.salesforce.com',
    loginUrl: 'https://login.salesforce.com',
    orgId: '00DP',
    orgName: 'Phone',
    orgType: 'developer',
    isSandbox: false,
    username: null,
    userId: null,
    grants,
  });
  tokens.setRefreshToken(conn.id, 'RT');
  const config: ContrailConfig = {
    ...DEFAULT_CONFIG,
    salesforce: { ...DEFAULT_CONFIG.salesforce },
    deploy: { ...DEFAULT_CONFIG.deploy, pollIntervalMs: 5 },
  };
  return createEngineDeps({
    db,
    tokens,
    config,
    store: new SnapshotStore(path.join(tmp, 'snapshots')),
    approvals,
    notifier,
    flowOps: { openBrowser: async () => undefined },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-dphone-'));
  process.env.CONTRAIL_DATA_DIR = tmp;
  db = new ContrailDb(path.join(tmp, 'test.db'));
  stubSalesforce();
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
  delete process.env.CONTRAIL_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

async function validate(deps: EngineDeps, extra: Record<string, unknown> = {}) {
  return invokeCapability(deps, 'validate_deploy', {
    connection: 'phone-org',
    components: [{ type: 'FlexiPage', api_name: 'Phone_Page', content: '<FlexiPage/>' }],
    ...extra,
  });
}

describe('S42 (desktop engine): phone copy of a minted approval', () => {
  it('native presentation → the push omits the code (approval is a click, not a code)', async () => {
    const presenter = new NativePresenter();
    const notifier = new RecordingNotifier();
    const result = await validate(makeDeps(presenter, notifier));
    expect(result.isError ?? false).toBe(false);
    expect(presenter.views).toHaveLength(1);
    const code = presenter.views[0]!.code;

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]!.includeCode).toBe(false);
    expect(notifier.calls[0]!.view.code).toBe(code); // the view is the same object the page got
    const text = textOf(result);
    expect(text).toContain('"phone_notification"');
    expect(text).toContain('"status": "sent"');
    expect(text).toContain('"mode": "native"');
    // Native wording: the agent must NOT be told the code is on the phone, and
    // must not be pointed at a tool the desktop never registers.
    expect(text).toContain('code-free summary');
    expect(text).not.toContain('also pushed');
    expect(text).not.toContain('open_settings');
    expect(text).not.toContain(code);
    expect(db.queryAuditEvents({}).find((e) => e.eventType === 'approval.notified')?.detail).toMatchObject({
      kind: 'deploy',
      codeIncluded: false,
    });
  });

  it('page presentation → the push carries the code; the tool result still never does', async () => {
    const presenter = new PagePresenter();
    const notifier = new RecordingNotifier();
    const result = await validate(makeDeps(presenter, notifier));
    const code = presenter.views[0]!.code;
    expect(notifier.calls[0]!.includeCode).toBe(true);
    expect(notifier.calls[0]!.view.code).toBe(code);
    expect(textOf(result)).not.toContain(code);
  });

  it('a dry run mints no code and notifies nobody', async () => {
    const presenter = new NativePresenter();
    const notifier = new RecordingNotifier();
    const result = await validate(makeDeps(presenter, notifier), { dry_run: true });
    expect(result.isError ?? false).toBe(false);
    expect(presenter.views).toHaveLength(0);
    expect(notifier.calls).toHaveLength(0);
  });

  it('a throwing notifier cannot fail the proposal; the agent sees a category, never the message', async () => {
    const presenter = new NativePresenter();
    const notifier = new RecordingNotifier();
    notifier.behaviour = 'throw';
    const result = await validate(makeDeps(presenter, notifier));
    const text = textOf(result);
    expect(result.isError ?? false).toBe(false);
    expect(text).toContain('"status": "failed"');
    expect(text).toContain('"reason": "network"');
    expect(text).not.toContain('boom');
    expect(text).toContain("waiting in the app's Deploy Review"); // native failure wording
    expect(text).not.toContain('The code is only on the approval page'); // the page-mode sentence
    expect(text).not.toContain(presenter.views[0]!.code);
  });
});
