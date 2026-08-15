# Org-bound MCP servers — injection contract v1 (design)

**Status: design only.** Spec §6 marks the org-bound injection contract as cuttable scope;
v1 ships `auth_mode: independent` servers only and **rejects `org_bound` at registration**.
This document is the contract a future session implements, plus the one hard problem the
spec's prose glosses over, worked through honestly.

## What org_bound means

An external MCP server (user-registered, not first-party) that wants to make Salesforce
calls *as one of the user's connections* — without holding its own credentials. Contrail
injects org access at session start; the server never sees the refresh token and never
takes part in OAuth.

Everything else about external servers (registration, per-project enablement, SDK
passthrough) is shared with `independent` servers and already ships in v1.

## Invariants (non-negotiable, same as first-party tools)

1. **Grants govern.** A call the connection's grants don't cover is blocked, not logged-and-allowed.
   Classification happens in the connection manager, exactly as for first-party capabilities.
2. **Audit completeness.** Every Salesforce call made on behalf of an org-bound server emits
   one audit event with actor `mcp:{server_key}` and the session id. "Complete log of
   everything the AI did in your org" must include these.
3. **Silo.** An org-bound server enabled for project P's session can only be bound to
   connections that project binds. Server-side check, session identity → project → binding,
   never trusting the runtime's arguments.
4. **The refresh token never leaves the keychain path.** Only short-lived access material is
   ever injected, and only for the mint's TTL.

## The enforcement problem the contract must solve

The spec says the server receives `X-Org-Access-Token` + `X-Org-Instance-Url` per request,
*and* that the connection manager classifies and blocks out-of-grant calls. Those two
statements only compose if the server's Salesforce traffic **routes through Contrail**. A
raw Salesforce access token pointed at the real instance URL is uninspectable — Salesforce
enforces the org's profile, not Contrail's grants, and the audit log goes blind.

Therefore contract v1 is **proxy-mediated**:

- `X-Org-Instance-Url` is **not** the Salesforce instance. It is a loopback relay owned by
  Contrail: `http://127.0.0.1:{port}/orgs/{mint_id}`.
- `X-Org-Access-Token` is a **Contrail-opaque bearer** (random 256-bit, no meaning outside
  the relay). It is not a Salesforce token.
- The relay resolves `mint_id` → (connection, session, server_key), verifies the bearer,
  **classifies the request** (same API-family classifier the first-party executor uses:
  path + method + body inspection for SOQL/DML/Metadata/Tooling), checks grants, emits the
  audit event, then forwards to the real instance with the real access token attached
  server-side. Responses stream back unmodified.
- Consequence: **contract v1 supports local (stdio) servers only.** A loopback URL is
  meaningless to a remote HTTP server. This is the honest version of the spec's local-first
  caveat — for local servers the org token *never leaves the machine at all*, which the spec
  already calls out as the preferred posture.

### Remote org-bound servers — explicitly deferred to contract v2

For a remote server, every option either breaks enforcement or leaks more than a header:

| Option | Why it's not v1 |
|---|---|
| Hand out the real SF access token | No classification, no audit, violates invariants 1–2. The warning UI can't fix an architecture. |
| Public relay (tunnel to the loopback proxy) | Turns Contrail into an internet-reachable org proxy; new attack surface the local-first story exists to avoid. |
| Salesforce OAuth token exchange with narrowed scopes | Scope granularity ≠ grant granularity (no "metadata read but not data read" scope), and org-side setup burden per client org. |

v2 candidates, in preference order: (1) narrow-scoped token exchange *plus* accepting scope
granularity limits with per-server scope disclosure in the UI; (2) authenticated relay with
mutual TLS pinned to the registered server. Neither is settled; both keep the mint/audit
model below.

## Data model (additive, already staged in schema v6)

`custom_mcp_servers` already carries `auth_mode` and a contract-version column. Additions
when implementing:

- `org_bound_bindings` — `server_id`, `connection_id`, `enabled`, `acknowledged_warning_at`.
  Per-server **per-connection** opt-in (spec caveat: the enable action is where the UI says,
  in plain words, what this server can now do and as whom).
- Mints are **in-memory only** — never a table. A mint is `{mint_id, bearer_hash, connection_id,
  session_id, server_key, expires_at}` held by the relay; process exit revokes everything.

## Lifecycle

1. **Session start:** for each org-bound server enabled for the session's project *and*
   bound to a connection that project binds, mint one relay entry per (server, connection).
   TTL **10 minutes**, renewed transparently while the session lives — the server sees a
   stable URL+bearer; renewal is internal (mint rotation, not header churn: the relay
   re-validates the bearer against the active mint).
2. **Per request:** classify → grant check → audit → forward. Block = HTTP 403 with a
   structured body naming the missing grant (same refusal shape first-party tools return).
3. **Session end / server disable / connection unbind / grant revocation:** revoke affected
   mints immediately. Grant revocation applies to live sessions (live-binding resolution,
   same rule the executor already follows).

## Failure modes to test when implemented

- Server presents an expired/foreign bearer → 401, audited as `denied`.
- Server names a connection outside the project silo (can't — connection choice is baked
  into the mint at session start; test that no request parameter can redirect the relay).
- DML attempted with only `data_read` → 403 + audit, session continues.
- Two concurrent sessions, different projects, same server → distinct mints, no cross-talk.
- Relay port conflict / relay crash → org-bound tools degrade to structured errors; the
  session survives; first-party tools unaffected.

## UI copy requirement (spec-mandated)

Enabling an org-bound server for a connection shows, before the toggle takes:
"**{server}** will be able to call **{connection alias}** as you, limited to this
connection's grants ({grant list}). Every call is logged to the audit trail. Local server —
your org credentials never leave this machine." (Remote variant, v2 only, must add the
token-leaves-machine sentence.)
