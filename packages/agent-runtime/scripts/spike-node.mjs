import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';

/**
 * Keyless Agent SDK spike (risk #1, phase 1: plain Node).
 *
 * Proves the spawn chain — SDK → claude.exe subprocess → streamed init →
 * structured API auth error — WITHOUT spending tokens: the key is invalid,
 * so the one API call fails at auth. What we verify:
 *   1. the platform binary resolves and spawns;
 *   2. `tools: []` + our in-process MCP server yields ONLY minted tools
 *      (the init message carries the authoritative tool manifest);
 *   3. the failure surfaces as a structured result, not a crash.
 */

const mark = (m) => process.stderr.write(`[spike] ${m}\n`);
mark(`entry reached (node ${process.version}, electron=${process.versions.electron ?? 'no'})`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'contrail-agent-spike-'));
mark('sdk imported, scratch ready');

const ping = tool(
  'ping',
  'Health-check tool. Returns pong.',
  {},
  async () => ({ content: [{ type: 'text', text: 'pong' }] }),
);

const outcome = {
  spawned: false,
  initSeen: false,
  toolManifest: null,
  resultSubtype: null,
  errorText: null,
  unexpected: [],
};

try {
  const q = query({
    prompt: 'Call the ping tool once, then say PONG.',
    options: {
      cwd: scratch,
      model: 'claude-haiku-4-5',
      systemPrompt: 'You are a connectivity test. Be terse.',
      // Isolation posture (the non-negotiables from the architecture decision):
      tools: [],                       // NO built-in tools, by construction
      settingSources: [],              // never load ~/.claude settings/CLAUDE.md
      persistSession: false,           // no writes to the user's session store
      mcpServers: {
        contrail: createSdkMcpServer({ name: 'contrail', version: '0.0.0', tools: [ping] }),
      },
      allowedTools: ['mcp__contrail__ping'],
      maxTurns: 2,
      maxBudgetUsd: 0.05,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'sk-ant-invalid-spike-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    },
  });

  outcome.spawned = true; // constructing the async iterable spawns lazily; confirmed once messages flow
  mark('query constructed, awaiting first message');

  let retryLogged = false;
  for await (const msg of q) {
    mark(`message: ${msg.type}${'subtype' in msg ? ':' + msg.subtype : ''} (+${Math.round(process.uptime())}s)`);
    if (msg.type === 'system' && msg.subtype === 'api_retry' && !retryLogged) {
      retryLogged = true;
      mark(`retry detail: ${JSON.stringify(msg).slice(0, 400)}`);
      if (outcome.initSeen) {
        // Chain fully proven: subprocess spawned, init streamed with our tool
        // manifest, and an API request went out (the retry IS the evidence —
        // an invalid key is retried ~8 times over ~3min, so don't wait it out).
        outcome.resultSubtype = 'early-exit-after-first-api-attempt';
        break;
      }
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      outcome.initSeen = true;
      outcome.toolManifest = msg.tools ?? null;
    } else if (msg.type === 'result') {
      outcome.resultSubtype = msg.subtype;
      outcome.errorText = msg.subtype === 'success' ? null : String(msg.errors ?? msg.result ?? '').slice(0, 400);
      if (msg.subtype === 'success' && msg.is_error) {
        outcome.errorText = String(msg.result).slice(0, 400);
      }
    } else if (msg.type === 'auth_status') {
      outcome.unexpected.push(`auth_status: ${JSON.stringify(msg).slice(0, 200)}`);
    }
  }
} catch (err) {
  outcome.errorText = `THROWN: ${String(err).slice(0, 500)}`;
}

console.log(JSON.stringify(outcome, null, 2));
try {
  fs.rmSync(scratch, { recursive: true, force: true });
} catch {
  // The killed CLI may briefly hold a handle on the scratch cwd — harmless.
}
