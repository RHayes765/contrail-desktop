import {
  createSdkMcpServer,
  tool,
  type Options,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { BridgeToolResult, SessionContext } from './types.js';
import { buildSystemPrompt } from './context.js';
import { MCP_SERVER_NAME, mintableCapabilities, sdkToolName } from './mint.js';

/**
 * THE session-options factory — the only code path allowed to construct
 * Agent SDK options. Every isolation invariant lives here, stated once:
 *
 *   - `tools: []`            → NO built-in tools, by construction. File tools
 *                              arrive in a later milestone via explicit
 *                              allowlist + path enforcement; Bash never in v1.
 *   - `settingSources: []`   → never load ~/.claude settings, CLAUDE.md, or
 *                              the user's skills into a Contrail session.
 *   - `persistSession: false`→ no writes to the user's Claude session store;
 *                              Contrail keeps its own transcripts.
 *   - allowlist minting      → only grant-filtered engine capabilities exist,
 *                              executed in MAIN via the bridge (the runtime
 *                              process never holds tokens or DB handles).
 *
 * The tool-manifest snapshot test pins this factory's output; change it
 * deliberately or not at all.
 */

export type CapabilityInvoker = (name: string, args: unknown) => Promise<BridgeToolResult>;

export function buildSessionOptions(
  ctx: SessionContext,
  invoke: CapabilityInvoker,
): Options {
  const caps = mintableCapabilities(ctx.bindings);

  const tools: SdkMcpToolDefinition<Record<string, never>>[] = caps.map((cap) =>
    tool(
      cap.name,
      cap.description,
      // The engine's zod raw shape crosses as-is; the SDK validates with it.
      cap.inputSchema as Record<string, never>,
      async (args: unknown) => {
        const result = await invoke(cap.name, args);
        return { content: result.content, isError: result.isError };
      },
    ),
  );

  return {
    cwd: ctx.cwd,
    model: ctx.model,
    systemPrompt: buildSystemPrompt(ctx),
    tools: [],
    settingSources: [],
    persistSession: false,
    mcpServers: {
      [MCP_SERVER_NAME]: createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: '1.0.0',
        tools,
      }),
    },
    allowedTools: caps.map((cap) => sdkToolName(cap.name)),
    maxTurns: ctx.maxTurns,
    maxBudgetUsd: ctx.maxBudgetUsd,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: ctx.apiKey,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  };
}
