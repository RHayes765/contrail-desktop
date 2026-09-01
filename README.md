# Contrail

An AI harness built for Salesforce work: a local-first desktop app where an
embedded Claude agent operates against your orgs through a first-party
Salesforce engine — with grants, project isolation, and human approval for
every write.

> **Status: released and self-updating.** Installers ship on
> [GitHub Releases](https://github.com/RHayes765/contrail-desktop/releases)
> and installed apps auto-update. Built and exercised against real orgs,
> with an adversarial write-safety suite guarding the approval invariants.
>
> **📖 The full tool & feature reference lives in the engine repo:
> [contrail-plugin/TOOLS.md](https://github.com/RHayes765/contrail-plugin/blob/main/TOOLS.md)**
> — same 34 capabilities in both surfaces, desktop differences noted there.

## Why it exists

Generic MCP servers can query and CRUD, but they cannot do real Salesforce
work: retrieve a Flow's XML, read an Apex class body, walk a dependency graph,
diff two orgs, or drive a deploy. Contrail builds those as first-party clients
against the Metadata and Tooling APIs, then *presents* them to the agent as
tools. The engine owns Salesforce; MCP is a surface, not the substrate.

## What works today

- **Connect orgs** by OAuth (device-independent, tokens in the OS keychain) with
  a five-grant permission model per connection: metadata read/write, data
  read/write, diagnostics read.
- **Projects as context silos** — each project has its own bound orgs,
  instructions, reference documents, and persistent notes. A session can only
  ever see its own project's context; this is enforced server-side on every
  tool call, not by prompt convention.
- **Chat** with a real multi-turn Claude session (model + reasoning-effort
  picker, streaming, tool cards colored by environment risk, token/cost meter,
  true resume of ended sessions).
- **Metadata browser** — type tree, pretty and raw XML, dependency panel
  (uses / used-by), permission-set viewer, AI summaries, and interactive
  **flow diagrams** rendered from the Flow XML.
- **Cross-org diff** — whole-scope diffs with honest coverage reporting (a
  partial snapshot never reads as thousands of deletions), drill-in per
  artifact, side-by-side flow diagrams with changed nodes highlighted, and
  diff-aware AI summaries.
- **Capability catalog** — per-project toggles for tool families, consulted at
  minting *and* re-checked on every call.
- **External MCP connectors** — bring your own servers (stdio, HTTP, SSE) with
  a built-in OAuth 2.1 client (PKCE, dynamic client registration, or your own
  OAuth app). Off by default in every project.
- **Writes with native approval** — metadata deploys, DML (single changes or
  multi-step plans with server-side id chaining), anonymous Apex (shown
  verbatim), and Bulk API 2.0 CSV data loads (files frozen at propose, rows
  never entering the conversation). The agent can validate and request; only
  a human clicking Approve in the Deploy Review screen can execute.
- **Org intelligence** — drift reports (live org vs your snapshot),
  SetupAuditTrail reading, effective-access explanations (CRUD/FLS with
  attribution), standalone Apex test runs, trace flags and debug logs, and
  free offline Apex/SOQL pre-checks via vendored Salesforce language servers.
- **Skills** — the bundled Salesforce skill pack (house rules, Apex/object/
  field/permission-set/validation-rule authoring, data migration) plus custom
  skill uploads, toggleable per project.
- **Linked folders** — attach local folders to a project; the agent sees
  their live contents (and bulk loads read CSVs from them by name).

## The safety model

Four invariants the code is built around, each enforced structurally rather
than by asking the model nicely:

1. **Grants are law.** Every capability declares the grant it needs. Minting
   hides ungranted tool families from the session; the main-process executor
   re-checks the target connection's grant on every call.
2. **Project isolation.** A session resolves connections only through its
   project's bindings, read live from the database — unbinding an org applies
   to a running session on its next tool call.
3. **The agent never holds a confirmation code.** Codes are generated for
   deploys and DML, scrubbed out of anything the runtime can see, and
   substituted in the main process at execution time.
4. **Writes need a human.** Approval happens over an IPC channel the agent
   runtime physically lacks. Production targets require a written comment.
   Every decision is audited.

## Architecture

A pnpm workspace, deliberately layered so the engine never depends on the UI or
on MCP:

```
packages/engine/         @contrail/engine — Salesforce clients, snapshot store,
                         dependency graph, semantic diff, deploy engine,
                         capability layer. MCP-free, UI-free.
packages/shared/         Typed IPC contracts (zod) + renderer view models.
                         Engine-free.
packages/agent-runtime/  Claude Agent SDK harness: tool minting, session
                         options, the utilityProcess child.
apps/desktop/            Electron app: main process (services, typed IPC),
                         preload, React renderer.
```

The agent runs in its own `utilityProcess` and holds exactly one credential:
your Anthropic API key. It has no database handle, no Salesforce tokens, and no
filesystem tools — every capability executes in the main process over a bridge.

## Running it

**Installing:** grab the latest `Contrail-Setup-<version>.exe` from
[Releases](https://github.com/RHayes765/contrail-desktop/releases) — installed
apps update themselves. From source (Node 22+, pnpm, an Anthropic API key):

```bash
pnpm install
pnpm -r build
pnpm -C apps/desktop dev
```

Store your API key in the OS keychain under service `Contrail Desktop`,
account `anthropic-api-key`. Connect an org from the **SF Orgs** screen; create
a project, bind the org, and start a session.

Application data (SQLite database, metadata snapshots, transcripts) lives in
`%USERPROFILE%\.contrail` on Windows and the platform equivalent elsewhere,
shared with the companion Claude plugin (additive-only schema, so either can
run without the other).
Nothing is uploaded anywhere: network egress is exactly your Salesforce orgs,
the Anthropic API, and whatever external MCP connectors you enable.

## Tests

```bash
pnpm -r test
```

540+ tests across the workspace — engine unit and capability-surface tests,
the agent-runtime tool-manifest tripwire (which pins the isolation invariants:
no built-in tools, no ambient settings, no unexpected tool in the manifest),
and desktop tests for project-silo enforcement, the code vault, native deploy
approval, and the adversarial write-safety suite.

## Related

The same engine also ships as a Claude plugin (a local stdio MCP server) at
[RHayes765/contrail-plugin](https://github.com/RHayes765/contrail-plugin) —
that's how the tooling is used from Claude Desktop or Claude Code rather than
from this app. The tool/feature reference
([TOOLS.md](https://github.com/RHayes765/contrail-plugin/blob/main/TOOLS.md))
lives there.

## License

Not yet licensed for reuse — © 2026 Ryley Hayes. Published for reading and
discussion while the product is in development.
