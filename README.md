# Contrail

An AI harness built for Salesforce work: a local-first desktop app where an
embedded Claude agent operates against your orgs through a first-party
Salesforce engine — with grants, project isolation, and human approval for
every write (one disclosed carve-out: starting an agent test run,
whose only input is a test definition the human already approved).

> **Status: released and self-updating.** Installers ship on
> [GitHub Releases](https://github.com/RHayes765/contrail-desktop/releases)
> and installed apps auto-update. Built and exercised against real orgs,
> with an adversarial write-safety suite guarding the approval invariants.
>
> **📖 The full tool & feature reference lives in the engine repo:
> [contrail-plugin/TOOLS.md](https://github.com/RHayes765/contrail-plugin/blob/main/TOOLS.md)**
> — the same engine and capabilities in both surfaces, desktop differences noted
> there; four plugin tools have no counterpart here: `open_settings` (a native
> Settings screen), `list_skills` and `read_skill` (the app's own skill library)
> and `render_flow` (the Metadata and Diff screens' flow diagrams).

**Omnistudio Data Mappers (S47).** `OmniDataTransform`, the Metadata API type
behind Omnistudio Data Mappers (which document generation templates use), is
deployable, indexed and explicit-refresh
(`refresh_snapshot types:["OmniDataTransform"]`). Salesforce marks the
OmniDataTransform and OmniDataTransformItem objects internal use only — their
records are not to be created, edited or deleted — so the Data Mapper Designer
and this type are the supported routes, unless the org has turned on Clean
Metadata Deployment: per Salesforce Help the legacy Omnistudio types can then
no longer be deployed or retrieved, and Data Mappers move to
`DataMapperDefinition`, a type Contrail does not register. A Data Mapper is
one plain `omniDataTransforms/<api_name>.rpt` document (folder and suffix
from the org's own describe; the Industries guide's `.omniDataTransform`
suffix is wrong). Its api_name is letters and digits, optionally
`_<version>`: Salesforce's
guides name the files `<Name>_<version>`, and the exact fullName rule is not
yet confirmed against an org. Per Salesforce Help the Metadata API deploys
Omnistudio components only where the org's **Omnistudio Metadata** setting is
on, and that setting can't be turned off again. So whenever a package holds a
Data Mapper, `validate_deploy` reads the setting (one Settings retrieve,
alongside the validation, dry runs too) and returns it as
`omnistudio_metadata`; when it is off, Deploy Review's warnings lead with
OMNISTUDIO METADATA IS OFF (rebuilt from that stored setting for a request
validated outside the app) — Data Mappers that exist there as records are
invisible to Contrail, so an ADD proves nothing — and a failed validation's
note, or a passed dry run's `omnistudio_note`, says the same. The setting is
reported, never enforced: the org's own answer decides. A `refresh_snapshot`
that lists no Data Mappers now says why when the setting is off, where it used
to be a silent zero. Every add or modify carries a Data Mapper note on its
Deploy Review row (the setting; whether it lands active follows its `<active>`
value per a Salesforce blog, not yet confirmed here; formula items need the
Designer, whose `formulaConverted` can't be reliably hand-written), and the row
also warns when the api_name differs from the file's `uniqueName`, when the
package mixes Data Mappers with any other type (Salesforce says Omnistudio
components can't share a deploy with setup metadata), and, on a modify, that
neither an in-place update (per Salesforce Help an active version can't be
edited once Data Mapper Versioning is on) nor the removal of omitted mapping
rows is confirmed. The
permission-coverage check has no Data Mapper arm: no per-component grant for
running one turned up in Salesforce's docs, and the type's documented
`<requiredPermission>` field is not yet confirmed to gate anything. Dependency
edges join a Data Mapper to the objects its rows name and the fields its Load
and lookup rows name, where the index holds them — read from Salesforce's
documented grammar, not yet from a retrieved file. No new tool (still 39).

**Governance for client work (S46).** The six proposing tools
(`validate_deploy`, `deactivate_flow`, `dml_propose`, `apex_propose`,
`agent_activation_propose`, `bulk_load_propose`) take a `justification` — one
or two sentences the agent drafts from what the human asked for, shown in
Deploy Review as the prefilled approval comment, editable, and recorded with
who wrote it (the agent's draft approved unchanged, or the human's own words;
Reject sends a reason only when the human types one over the draft) — and a
`ticket`, passed only when the human named one. A new `policies` section in
`config.json`, written by the human (no Contrail tool or screen writes it),
holds rules matched by org type, connection label or org id: require a
justification or a ticket (optionally matching a pattern), deny destructive
metadata changes, data deletes or anonymous Apex, set a minimum test level, or
freeze a connection during weekly or dated windows. Contrail re-reads the
section at every check — when a write is proposed (for a deploy, again when
its validation finishes), whenever Deploy Review shows the request, when the
human clicks Approve, and again just before the write runs. A proposal that
breaks a rule is refused, naming the rule, and leaves any pending approval
untouched. During a freeze the request is created, but Deploy Review shows a
**CHANGE FREEZE** banner and keeps Approve disabled until the human types an
emergency reason there (at least 15 characters, recorded as a freeze override
for that request only), and the phone push says a freeze is in effect; starting
an agent test run is refused while the freeze lasts. A request a policy blocks
cannot be approved unless the only thing missing is a justification, which the
human can type as the comment. A fresh install writes one built-in rule
(production and unknown-type orgs need a justification); an install that
already had a `config.json` runs that rule until a `policies` section is added.
For 24 hours after Contrail notices the section changed, Deploy Review and the
phone push say so. `list_connections` reports each connection's `policy` and a
`policies_status`, and the SF Orgs screen shows what applies to each
connection; `get_audit_log` gains `request_id`, `event_type` and `until`, and
compares `since` and `until` as the instants they name (a value Contrail
cannot read as a date and time is refused; `since` used to be compared as
text); and one new capability, `export_change_evidence`, writes a dossier
(`evidence.md` and `evidence.json`) under `evidence/` in the data directory:
per request the ticket, the justification and who wrote it, the rules that
applied, any freeze override, pre-image stamps, the execute-time checks, the
org's result and the audit rows that name it — never a confirmation code or a
record field value (in a project session it requires a `connection`). Two
more behaviour changes: an unknown key in the `policies` section, or a
`config.json` that cannot be parsed, now refuses every write proposal and
every agent test-run start until the human fixes the file (reads keep
working); and a `config.json` saved with a UTF-8 byte-order mark is now read
normally (it was previously ignored as unreadable). A `config.json` saved as
UTF-16 (Windows PowerShell 5.1's default for `>` and `Out-File`) still cannot
be read: it is refused like a file that cannot be parsed, and the refusal says
to save it as UTF-8.
Policies are enforced by Contrail 0.40.0 and later. The desktop app, the Claude
Desktop extension and the Claude Code plugin update separately and share one
data directory; a copy older than 0.40.0 neither checks policies nor honours a
freeze, and the change-evidence dossier marks any request such a copy created or
executed — so update every installed Contrail surface together: the extension,
the Claude Code plugin and the desktop app.

**Live-check fixes (S46).** Stamps for custom fields, validation rules,
custom labels and list views now come from a query that names only the
package's members instead of the org-wide listing — on a dev org with about
24,000 custom fields that listing took over 90 seconds and pushed the
execute-time check past its 15-second deadline. Their pre-images come from a
retrieve that names the child (a standard field, or a child whose parent
document the same package already retrieves, is still read from that
document). A validation poll reports real progress; the permission warning no
longer says a package "adds" what the org already has; the revert README is
accurate for add-only deploys; and the approval page says plainly that a
screenshot of it contains the code. Version skew: a 0.39 desktop app showing
a request validated by the 0.40 plugin prints a failed stamp query as
"listMetadata reported INVALID_TYPE" for that type. The guard behaviour is
still correct; only that notice's reason is wrong. Update the desktop app
together with the plugin.

**Snapshot re-baseline (S46).** After a successful deploy Contrail re-reads
the deployed components into the local snapshot — best-effort and bounded; the
result's `snapshot` block says what was updated, and Deploy Review's result
panel shows it — and `refresh_snapshot` takes `members` to re-read named
components. After a re-read the Metadata screen refreshes its type counts
and open list, and reloads the open component when the re-read named it or
re-wrote it as the document of a named one (a FlowDefinition's flow, a custom
field's object); an open Diff whose snapshot changed is marked historical; the
SF Orgs screen's "synced … ago" still reports the oldest whole-type refresh,
which a re-read after a deploy never moves. `snapshot.rebaselineAfterDeploy: false` turns the
re-read off and `snapshot.rebaselineTimeoutMs` (60 s) bounds it; `diff_orgs`
now reports each side's oldest and newest retrieval time in `snapshot_taken`,
because a snapshot's rows can now have different ages.

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
- **Phone notifications (opt-in)** — Settings → Notifications pushes a short
  code-free "waiting in Deploy Review" summary to your phone through Pushover
  the moment a change is proposed. Keys live in the OS keychain (shared with
  the companion plugin, whose pushes carry the code because its approval is a
  typed code); the agent cannot see or change them. The plugin's
  `notifications.when` setting (push only while a Claude Code session has
  Remote Control on) is a Claude Code concept and does not apply here: the
  app's push is a pager for its own Deploy Review screen.
- **Org intelligence** — drift reports (live org vs your snapshot),
  SetupAuditTrail reading, effective-access explanations (CRUD/FLS with
  attribution), standalone Apex test runs, trace flags and debug logs, and
  free offline Apex/SOQL pre-checks via vendored Salesforce language servers.
- **Skills** — the bundled Salesforce skill pack (house rules,
  Apex/object/field/permission-set/validation-rule authoring, data migration,
  the Agentforce agent and agent-test family) plus custom skill uploads,
  toggleable per project.
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
account `anthropic-api-key` (Pushover keys, if you set them, go under the
engine's service `contrail-engine`, accounts `notify:pushover:user` /
`notify:pushover:token` — the Settings screen does this for you). Connect an
org from the **SF Orgs** screen; create a project, bind the org, and start a
session.

Application data (SQLite database, metadata snapshots, transcripts) lives in
`%USERPROFILE%\.contrail` on Windows and the platform equivalent elsewhere,
shared with the companion Claude plugin (additive-only schema, so either can
run without the other).
Nothing leaves this machine except traffic to: your Salesforce orgs, the
Anthropic API, whatever external MCP connectors you enable, GitHub Releases
(the daily release check and the auto-update download), and — only if you
switch it on — Pushover (one message per proposed change, plus a key check
and a test message when you press "Send test notification").

## Tests

```bash
pnpm -r test
```

1,600+ tests across the workspace — engine unit and capability-surface tests,
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
