import {
  createSdkMcpServer,
  tool,
  type McpServerConfig,
  type Options,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { BridgeToolResult, ExternalMcpServerSpec, SessionContext } from './types.js';
import { buildSystemPrompt } from './context.js';
import { MCP_SERVER_NAME, mintableCapabilities, PROJECT_TOOLS, sdkToolName } from './mint.js';

/**
 * THE session-options factory — the only code path allowed to construct
 * Agent SDK options. Every isolation invariant lives here, stated once:
 *
 *   - `tools: []`            → NO built-in tools, by construction. File tools
 *                              arrive in a later milestone via explicit
 *                              allowlist + path enforcement; Bash never in v1.
 *   - `settingSources: []`   → never load ~/.claude settings, CLAUDE.md, or
 *                              the user's skills into a Contrail session.
 *   - CLAUDE_CONFIG_DIR      → ALWAYS the Contrail-owned dir from ctx. The
 *                              SDK persists session history there (that is
 *                              what makes resume work — deliberate change
 *                              from the original persistSession:false, made
 *                              when resume shipped); the user's real ~/.claude
 *                              is never read or written either way.
 *   - allowlist minting      → only grant-filtered engine capabilities exist,
 *                              executed in MAIN via the bridge (the runtime
 *                              process never holds tokens or DB handles).
 *
 * The tool-manifest snapshot test pins this factory's output; change it
 * deliberately or not at all.
 */

export type CapabilityInvoker = (name: string, args: unknown) => Promise<BridgeToolResult>;

/**
 * External (auth_mode: independent) servers pass through to the SDK's MCP
 * client untouched. Main already resolved per-project enablement and
 * sanitized keys; this layer's own guard is that no external server may
 * shadow the first-party 'contrail' namespace or another external key —
 * a shadowed entry is dropped, never merged.
 */
function externalServerEntries(
  specs: readonly ExternalMcpServerSpec[],
): Record<string, McpServerConfig> {
  const entries: Record<string, McpServerConfig> = {};
  for (const spec of specs) {
    // Object.hasOwn, not `in`: a server named "Constructor" slugs to a
    // prototype key and `in` would silently drop it.
    if (!spec.key || spec.key === MCP_SERVER_NAME || Object.hasOwn(entries, spec.key)) continue;
    if (spec.transport === 'stdio') {
      entries[spec.key] = {
        type: 'stdio',
        command: spec.urlOrCommand,
        ...(spec.args ? { args: spec.args } : {}),
        ...(spec.env ? { env: spec.env } : {}),
      };
    } else {
      entries[spec.key] = {
        type: spec.transport,
        url: spec.urlOrCommand,
        ...(spec.headers ? { headers: spec.headers } : {}),
      };
    }
  }
  return entries;
}

export function buildSessionOptions(
  ctx: SessionContext,
  invoke: CapabilityInvoker,
): Options {
  const caps = mintableCapabilities(ctx.bindings, ctx.disabledCatalogKeys ?? []);

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

  // Project-silo tools mint unconditionally — the executor resolves the
  // project from the session, so there is no cross-project surface to gate.
  for (const def of PROJECT_TOOLS) {
    tools.push(
      tool(
        def.name,
        def.description,
        def.inputSchema as Record<string, never>,
        async (args: unknown) => {
          const result = await invoke(def.name, args);
          return { content: result.content, isError: result.isError };
        },
      ),
    );
  }

  const external = externalServerEntries(ctx.externalServers ?? []);

  const allowed = [
    ...caps.map((cap) => sdkToolName(cap.name)),
    ...PROJECT_TOOLS.map((t) => sdkToolName(t.name)),
    // Server-level allow spec (mcp__{key}) admits every tool the external
    // server exposes — we cannot know their names ahead of connection, and
    // the server was explicitly enabled for this project.
    ...Object.keys(external).map((key) => `mcp__${key}`),
  ];

  return {
    cwd: ctx.cwd,
    model: ctx.model,
    ...(ctx.effort ? { effort: ctx.effort } : {}),
    ...(ctx.resumeSdkSessionId ? { resume: ctx.resumeSdkSessionId } : {}),
    systemPrompt: buildSystemPrompt(ctx),
    tools: [],
    settingSources: [],
    // persistSession defaults true — history lands in ctx.claudeConfigDir
    // (Contrail-owned), which is the whole resume mechanism.
    mcpServers: {
      [MCP_SERVER_NAME]: createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: '1.0.0',
        tools,
      }),
      ...external,
    },
    allowedTools: allowed,
    maxTurns: ctx.maxTurns,
    maxBudgetUsd: ctx.maxBudgetUsd,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: ctx.apiKey,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CONFIG_DIR: ctx.claudeConfigDir,
    },
  };
}
