import { z } from 'zod';
import { flowDeactivationXml } from '../deploy/package.js';
import type { DmlPlanStep } from '../deploy/engine.js';
import { resolveSourceFile } from '../deploy/sources.js';
import { stagingDir } from '../core/paths.js';
import type { TestLevel } from '../salesforce/metadataSoap.js';
import type { Capability } from './types.js';
import { ok, fail, guarded } from './result.js';
import { requireConnection } from './metadata.js';

/**
 * The write capabilities (spec §4/§5), ported verbatim from the Phase 0 tool
 * layer (tools/deploy.ts). Both pairs are two-step: the validate/propose step
 * computes consequences and puts a confirmation code on the human-only
 * approval surface; the execute step demands that code. The code NEVER
 * appears in a capability result — if you have not been told it by the human,
 * you cannot execute, and that is the design.
 */

const ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

const APPROVAL_INSTRUCTIONS =
  'The confirmation code is displayed ONLY on the approval page in the human\'s browser — ' +
  'it is not available to you anywhere. Present this summary (destructive changes first), ' +
  'then ask the human to review the page and read the code back if they approve.';

const REF_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const REF_TOKEN_RE = /^@\{([A-Za-z][A-Za-z0-9_]*)\.id\}$/;

/**
 * Grammar/shape validation for a multi-step plan. Semantics (FLS, required
 * fields, validation rules) are the ORG's to judge at execute — with
 * all_or_none defaulting true, an org refusal rolls back cleanly and spends
 * the code, same as a flat failure. What must be exact here is the reference
 * grammar: a token that survives to the org malformed gets "substituted" into
 * garbage, and the preview would have lied about what gets written.
 * Returns an error message, or null when the plan is well-formed.
 */
function validateDmlPlan(args: {
  operation?: string;
  object?: string;
  records?: unknown[];
  ids?: unknown[];
  steps?: Array<{
    ref?: string;
    operation: 'insert' | 'update' | 'delete';
    object: string;
    record?: Record<string, unknown>;
    id?: string;
  }>;
}): string | null {
  if (args.operation || args.object || args.records || args.ids) {
    return 'Send either steps (a plan) or the flat operation/object fields — not both.';
  }
  const steps = args.steps ?? [];
  // Tokens may only cite EXPLICIT refs of EARLIER INSERT steps: inserts are
  // the only steps whose composite response carries an id (update/delete
  // return 204 with no body), and forward/self references can never resolve.
  const insertRefsSoFar = new Set<string>();
  const allRefs = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const where = `step ${i + 1}`;
    if (!/^[A-Za-z0-9_]+$/.test(step.object)) return `${where}: invalid object API name`;
    if (/__mdt$/i.test(step.object)) {
      return (
        `${where}: ${step.object} is a custom metadata type — its records are METADATA, ` +
        `not data, and the REST API cannot write them. Deploy the record instead: ` +
        `validate_deploy with type CustomMetadata, api_name "<Type>.<Record>" ` +
        `(type name without __mdt).`
      );
    }
    if (step.ref !== undefined) {
      if (!REF_RE.test(step.ref)) return `${where}: invalid ref "${step.ref}" (letters/digits/_, start with a letter)`;
      if (allRefs.has(step.ref)) return `${where}: duplicate ref "${step.ref}"`;
      allRefs.add(step.ref);
    }
    const checkToken = (value: string, slot: string): string | null => {
      const m = REF_TOKEN_RE.exec(value);
      if (!m) return `${where}: ${slot} contains "@{" but is not a whole-value "@{ref.id}" token`;
      if (!insertRefsSoFar.has(m[1]!)) {
        return `${where}: ${slot} references "@{${m[1]}.id}" which is not an EARLIER insert step's ref`;
      }
      return null;
    };

    if (step.operation === 'insert') {
      if (!step.record || Object.keys(step.record).length === 0) return `${where}: insert requires record`;
      if (step.id !== undefined) return `${where}: insert must not carry id`;
    } else {
      if (step.id === undefined) return `${where}: ${step.operation} requires id (a record id or "@{ref.id}")`;
      if (!ID_RE.test(step.id)) {
        const bad = checkToken(step.id, 'id');
        if (bad) return bad;
      }
      if (step.operation === 'update' && (!step.record || Object.keys(step.record).length === 0)) {
        return `${where}: update requires record`;
      }
      if (step.operation === 'delete' && step.record !== undefined) {
        return `${where}: delete must not carry record`;
      }
    }

    for (const [key, value] of Object.entries(step.record ?? {})) {
      if (!/^[A-Za-z0-9_]+$/.test(key)) return `${where}: invalid field name "${key}"`;
      // Salesforce rejects Id inside a PATCH body — the target lives in `id`.
      if (key.toLowerCase() === 'id') return `${where}: never put Id inside record — the target goes in the id slot`;
      if (typeof value === 'string' && /@\{/.test(value)) {
        const bad = checkToken(value, `field "${key}"`);
        if (bad) return bad;
      }
    }

    if (step.operation === 'insert' && step.ref) insertRefsSoFar.add(step.ref);
  }
  return null;
}

export const deployCapabilities: Capability[] = [
  {
    name: 'validate_deploy',
    title: 'Validate a metadata deploy (checkOnly)',
    description:
      'Build a deploy package and validate it against the org with checkOnly=true — ' +
      'nothing is committed. Returns the change summary (destructive changes flagged), ' +
      'validation/test results, and blast radius; puts a confirmation code on the ' +
      'human-only approval page. Normally OMIT test_level — the org then applies its ' +
      'own default (production runs local tests for Apex packages automatically and ' +
      'refuses an explicit NoTestRun). ' +
      'An in-progress result means call validate_deploy again to check on it.',
    grant: 'metadata_write',
    writeClass: true,
    inputSchema: {
      connection: z.string().describe('Target connection alias (or id) — name it unmissably to the human.'),
      components: z
        .array(
          z.object({
            type: z
              .string()
              .describe(
                'ApexClass, ApexTrigger, ApexPage, Flow, CustomObject, PermissionSet, ' +
                  'CustomTab, FlexiPage, CustomApplication, ReportType, GlobalValueSet, ' +
                  'ConnectedApp, NamedCredential, ExternalCredential, PlatformEventChannel(Member), ' +
                  'ManagedEventSubscription, Layout, CustomMetadata (records, dotted ' +
                  'Type.Record names), or child types CustomField / ValidationRule / ' +
                  'CustomLabel / ListView / RecordType.',
              ),
            api_name: z.string().describe('Full API name; children dotted (Account.MyField__c).'),
            content: z
              .string()
              .optional()
              .describe(
                'Full source for file types; for child types, the XML block exactly as ' +
                  'retrieve_metadata returns it (e.g. <fields>…</fields>). Exactly one of ' +
                  'content or content_file is required.',
              ),
            content_file: z
              .string()
              .optional()
              .describe(
                'Absolute path to a file holding the source, read byte-exactly instead of ' +
                  'content. PREFER THIS for large components — retyping tens of KB of XML ' +
                  'risks a silent one-character corruption. The file must sit under ' +
                  "Contrail's staging directory (the error message prints the exact path), " +
                  'under its snapshots directory, or under a directory the human listed in ' +
                  'deploy.allowedSourceRoots. Read at validation time and frozen into the ' +
                  'approved package, so editing it afterwards cannot change what deploys.',
              ),
          }),
        )
        .max(50)
        .optional()
        .describe('Components to create or update.'),
      destructive: z
        .array(z.object({ type: z.string(), api_name: z.string() }))
        .max(50)
        .optional()
        .describe('Components to DELETE. Deletions are destructive and flagged prominently.'),
      test_level: z
        .enum(['NoTestRun', 'RunLocalTests', 'RunSpecifiedTests', 'RunAllTestsInOrg'])
        .optional()
        .describe(
          "OMIT unless you have a reason: the org then applies its own default — " +
            'sandboxes run no tests; production runs local tests when the package ' +
            'carries Apex and none otherwise. Production REFUSES an explicit ' +
            'NoTestRun, so never send it there (a no-Apex prod deploy just omits ' +
            'this). RunSpecifiedTests needs run_tests.',
        ),
      run_tests: z
        .array(z.string())
        .max(50)
        .optional()
        .describe('Test classes for RunSpecifiedTests.'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as {
          connection: string;
          components?: Array<{
            type: string;
            api_name: string;
            content?: string;
            content_file?: string;
          }>;
          destructive?: Array<{ type: string; api_name: string }>;
          test_level?: TestLevel;
          run_tests?: string[];
        };
        const conn = requireConnection(deps, args.connection, 'validate_deploy');
        // Resolve file-backed components to bytes BEFORE anything else: the
        // package is built and frozen from what we read here, so this is the
        // single point where "what will be deployed" is decided.
        const components = (args.components ?? []).map((c) => {
          const hasInline = typeof c.content === 'string';
          if (hasInline && c.content_file) {
            throw new Error(
              `${c.type} ${c.api_name}: pass content OR content_file, not both — ` +
                'Contrail will not guess which one you meant to deploy.',
            );
          }
          if (!hasInline && !c.content_file) {
            throw new Error(
              `${c.type} ${c.api_name}: needs content or content_file. For large ` +
                `components write the source under ${stagingDir()} and pass content_file.`,
            );
          }
          if (c.content_file) {
            const src = resolveSourceFile(c.content_file, deps.config.deploy.allowedSourceRoots);
            return {
              type: c.type,
              api_name: c.api_name,
              content: src.content,
              source_path: src.sourcePath,
              source_sha256: src.sourceSha256,
            };
          }
          return { type: c.type, api_name: c.api_name, content: c.content as string };
        });
        const destructive = args.destructive ?? [];
        if (components.length + destructive.length === 0) {
          return fail('Provide at least one component or destructive entry.');
        }
        if (args.test_level === 'RunSpecifiedTests' && !(args.run_tests?.length)) {
          return fail('RunSpecifiedTests requires run_tests.');
        }
        const outcome = await deps.deploys.validateDeploy(conn, {
          components,
          destructive,
          // Unspecified stays unspecified all the way to the SOAP call — the
          // org's default behavior is the only choice production accepts for
          // a no-Apex package (it rejects an explicit NoTestRun).
          testLevel: args.test_level,
          runTests: args.run_tests ?? [],
        });
        switch (outcome.status) {
          case 'in_progress':
            return ok(
              { progress: outcome.progress, started_at: outcome.started_at },
              'Validation is still running — call validate_deploy again with the same connection to check on it.',
            );
          case 'failed':
            return fail(`Validation errored: ${outcome.error}`);
          case 'complete': {
            const r = outcome.result;
            if (!r.validation_passed) {
              return ok(r.failure ?? {}, 'Validation FAILED — no confirmation code was issued.');
            }
            return ok(
              { ...r.summary, approval_page: r.approval },
              `Validation passed. TARGET: ${conn.alias} (${conn.orgType}). ${APPROVAL_INSTRUCTIONS}`,
            );
          }
        }
      }),
  },
  {
    name: 'deactivate_flow',
    title: 'Deactivate a flow',
    description:
      'Deactivate a flow (turn off its active version) — to switch off automation, or as the ' +
      'first step before trying to delete a flow. Routes through the same two-step approval as ' +
      'any write: this validates the change and opens the approval page; the human reads the ' +
      'code back to execute_deploy. Note: deleting a flow via the Metadata API is unreliable ' +
      'even after deactivation ("insufficient access rights on cross-reference id"); if a ' +
      'destructive delete fails, delete the flow in Setup → Flows.',
    grant: 'metadata_write',
    writeClass: true,
    inputSchema: {
      connection: z.string().describe('Target connection alias (or id).'),
      flow: z.string().describe('Flow API name (DeveloperName).'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; flow: string };
        const conn = requireConnection(deps, args.connection, 'deactivate_flow');
        if (!/^[A-Za-z0-9_]+$/.test(args.flow)) return fail('invalid flow API name');
        const outcome = await deps.deploys.validateDeploy(conn, {
          components: [
            { type: 'FlowDefinition', api_name: args.flow, content: flowDeactivationXml() },
          ],
          destructive: [],
          // No test level: an explicit NoTestRun would make production refuse
          // to deactivate a flow at all; omitted, the org waves a no-Apex
          // package through everywhere.
          runTests: [],
        });
        switch (outcome.status) {
          case 'in_progress':
            return ok(
              { progress: outcome.progress, started_at: outcome.started_at },
              'Still validating — call deactivate_flow again with the same flow to check on it.',
            );
          case 'failed':
            return fail(`Deactivation validation errored: ${outcome.error}`);
          case 'complete': {
            const r = outcome.result;
            if (!r.validation_passed) {
              return ok(r.failure ?? {}, 'Validation FAILED — no confirmation code was issued.');
            }
            return ok(
              { ...r.summary, approval_page: r.approval },
              `Deactivation of flow "${args.flow}" validated. TARGET: ${conn.alias} ` +
                `(${conn.orgType}). ${APPROVAL_INSTRUCTIONS} Execute it with execute_deploy.`,
            );
          }
        }
      }),
  },
  {
    name: 'execute_deploy',
    title: 'Execute a validated deploy',
    description:
      'Execute the most recently validated deploy. Approval flow depends on the surface: in ' +
      'the desktop app, call WITHOUT a confirmation code — the user approves in Deploy Review ' +
      'and this call waits for their decision. With the localhost approval page, pass the code ' +
      'the human read from the page. Never guess, fabricate, or reuse a code; codes are ' +
      'single-use, expire in ~1h, and any new validation on the connection replaces them.',
    grant: 'metadata_write',
    writeClass: true,
    inputSchema: {
      connection: z.string().describe('Target connection alias (or id).'),
      confirmation_code: z
        .string()
        .optional()
        .describe(
          'Only when the human read a code from the approval page (format XXXX-XXXX). ' +
            'Omit in the desktop app — approval is native.',
        ),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; confirmation_code?: string };
        const conn = requireConnection(deps, args.connection, 'execute_deploy');
        if (!args.confirmation_code) {
          // Codeless calls are the DESKTOP's native-approval path, which the
          // desktop executor intercepts BEFORE the engine. Reaching here
          // means there is nothing pending to approve.
          return fail(
            'No confirmation code and no pending native approval. Validate first; then in the ' +
              'desktop app call again without a code, or with the approval page pass its code.',
          );
        }
        const outcome = await deps.deploys.executeDeploy(conn, args.confirmation_code);
        switch (outcome.status) {
          case 'in_progress':
            return ok(
              { progress: outcome.progress, started_at: outcome.started_at },
              'Deploy is still running — call execute_deploy again with the same connection ' +
                'and code to check on it.',
            );
          case 'failed':
            return fail(`Deploy errored: ${outcome.error}`);
          case 'complete':
            return ok(outcome.result);
        }
      }),
  },
  {
    name: 'dml_propose',
    title: 'Propose a data change (two-step)',
    description:
      'Stage a data change with a before/after preview. Nothing touches the org until the ' +
      'human reads the confirmation code from the approval page and you pass it to ' +
      'dml_execute. TWO SHAPES: (a) flat — one operation on one object, max 200 rows, ' +
      'all-or-none; (b) a PLAN — 2–25 ordered steps, one record each, where a later step ' +
      'references an earlier INSERT step\'s created id with the whole-value token ' +
      '"@{ref.id}" (in field values, or as the id of an update/delete). Use a plan to seed ' +
      'linked test data in ONE approval: e.g. insert Account (ref "acct") → insert Contact ' +
      '{AccountId: "@{acct.id}"} → … → update "@{opp.id}". The org resolves the tokens ' +
      'server-side. all_or_none (default true) rolls the whole plan back on any failure; ' +
      'false keeps successful steps and fails only dependents — the approval page states ' +
      'which mode the human is approving.',
    grant: 'data_write',
    writeClass: true,
    inputSchema: {
      connection: z.string().describe('Target connection alias (or id).'),
      operation: z
        .enum(['insert', 'update', 'delete'])
        .optional()
        .describe('Flat shape only. Omit when sending steps.'),
      object: z
        .string()
        .optional()
        .describe('Flat shape only: SObject API name, e.g. Account or Invoice__c.'),
      records: z
        .array(z.record(z.unknown()))
        .max(200)
        .optional()
        .describe('Flat insert/update: field maps (update rows must include Id).'),
      ids: z
        .array(z.string())
        .max(200)
        .optional()
        .describe('Flat delete: record ids.'),
      steps: z
        .array(
          z.object({
            ref: z
              .string()
              .max(40)
              .optional()
              .describe('Handle for this step\'s created id; letters/digits/_, must start with a letter.'),
            operation: z.enum(['insert', 'update', 'delete']),
            object: z.string(),
            record: z
              .record(z.unknown())
              .optional()
              .describe('insert/update: the field map. Never include Id — the target goes in `id`.'),
            id: z
              .string()
              .optional()
              .describe('update/delete: a literal record id or "@{ref.id}".'),
          }),
        )
        .min(2)
        .max(25)
        .optional()
        .describe('Plan shape: ordered steps, one record each. Mutually exclusive with operation/object.'),
      all_or_none: z
        .boolean()
        .optional()
        .describe('Plan shape: default true (atomic). false = keep successes, fail dependents.'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as {
          connection: string;
          operation?: 'insert' | 'update' | 'delete';
          object?: string;
          records?: Array<Record<string, unknown>>;
          ids?: string[];
          steps?: DmlPlanStep[];
          all_or_none?: boolean;
        };
        const conn = requireConnection(deps, args.connection, 'dml_propose');

        if (args.steps) {
          const bad = validateDmlPlan(args);
          if (bad) return fail(bad);
          const preview = await deps.deploys.proposeDml(conn, {
            plan: true,
            version: 2,
            all_or_none: args.all_or_none ?? true,
            steps: args.steps,
          });
          return ok(
            preview,
            `Proposed — nothing executed. TARGET: ${conn.alias} (${conn.orgType}). ${APPROVAL_INSTRUCTIONS}`,
          );
        }

        if (args.all_or_none !== undefined) {
          return fail('all_or_none applies only to plans (steps) — the flat shape is always all-or-none.');
        }
        if (!args.operation || !args.object) {
          return fail('Provide either steps (a plan) or operation + object (flat).');
        }
        if (!/^[A-Za-z0-9_]+$/.test(args.object)) return fail('invalid object API name');
        if (/__mdt$/i.test(args.object)) {
          return fail(
            `${args.object} is a custom metadata type — its records are METADATA, not ` +
              `data, and the REST API cannot write them. Deploy the record instead: ` +
              `validate_deploy with type CustomMetadata, api_name "<Type>.<Record>" ` +
              `(type name without __mdt).`,
          );
        }
        if (args.operation === 'delete') {
          if (!args.ids?.length) return fail('delete requires ids.');
          if (args.ids.some((i) => !ID_RE.test(i))) return fail('invalid record id in ids.');
        } else {
          if (!args.records?.length) return fail(`${args.operation} requires records.`);
          for (const r of args.records) {
            for (const key of Object.keys(r)) {
              if (!/^[A-Za-z0-9_]+$/.test(key)) return fail(`invalid field name "${key}"`);
            }
            for (const v of Object.values(r)) {
              if (typeof v === 'string' && /@\{/.test(v)) {
                return fail('reference tokens ("@{ref.id}") are only valid inside a plan (steps).');
              }
            }
            if (args.operation === 'update' && !ID_RE.test(String(r.Id ?? r.id ?? ''))) {
              return fail('every update record needs a valid Id.');
            }
          }
        }
        const preview = await deps.deploys.proposeDml(conn, {
          operation: args.operation,
          object: args.object,
          records: args.records,
          ids: args.ids,
        });
        return ok(
          preview,
          `Proposed — nothing executed. TARGET: ${conn.alias} (${conn.orgType}). ${APPROVAL_INSTRUCTIONS}`,
        );
      }),
  },
  {
    name: 'dml_execute',
    title: 'Execute a proposed data change',
    description:
      'Execute the most recently proposed data change. In the desktop app, call WITHOUT a ' +
      'confirmation code — the user approves in Deploy Review and this call waits for their ' +
      'decision. With the localhost approval page, pass the code the human read from the ' +
      'page. Single-use, ~1h expiry, invalidated by a new proposal on the same connection.',
    grant: 'data_write',
    writeClass: true,
    inputSchema: {
      connection: z.string().describe('Target connection alias (or id).'),
      confirmation_code: z
        .string()
        .optional()
        .describe(
          'Only when the human read a code from the approval page (format XXXX-XXXX). ' +
            'Omit in the desktop app — approval is native.',
        ),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; confirmation_code?: string };
        const conn = requireConnection(deps, args.connection, 'dml_execute');
        if (!args.confirmation_code) {
          return fail(
            'No confirmation code and no pending native approval. Propose first; then in the ' +
              'desktop app call again without a code, or with the approval page pass its code.',
          );
        }
        const result = await deps.deploys.executeDml(conn, args.confirmation_code);
        return ok(result);
      }),
  },
  {
    name: 'apex_propose',
    title: 'Propose an anonymous Apex script (two-step)',
    description:
      'Stage an anonymous Apex script for human approval. This is the ONLY path to ' +
      'executeAnonymous: nothing runs until the human approves the script — shown ' +
      "verbatim — in Deploy Review, and it runs with the HUMAN's permissions, touching " +
      'anything their user can. DML it performs COMMITS on success; an uncaught ' +
      'exception rolls the whole script back. There is no dry-run — the org compiles and ' +
      'executes in one shot at execute, and a compile error spends the approval like any ' +
      'failed write. Max 32,000 chars (executeAnonymous is a URL-encoded GET); split ' +
      'longer work into multiple proposals. The script returns no output — write ' +
      'System.debug and set a trace flag first (set_trace_flag) if you need to see the log.',
    grant: 'data_write',
    writeClass: true,
    inputSchema: {
      connection: z
        .string()
        .describe('Target connection alias (or id) — name it unmissably to the human.'),
      code: z
        .string()
        .min(1)
        .max(32_000)
        .describe('The anonymous Apex source, verbatim (this is the script, NOT a confirmation code).'),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; code: string };
        const conn = requireConnection(deps, args.connection, 'apex_propose');
        if (args.code.trim().length === 0) return fail('The script is empty.');
        const preview = await deps.deploys.proposeApex(conn, args.code);
        return ok(
          preview,
          `Proposed — nothing executed. TARGET: ${conn.alias} (${conn.orgType}). ${APPROVAL_INSTRUCTIONS}`,
        );
      }),
  },
  {
    name: 'apex_execute',
    title: 'Execute a proposed anonymous Apex script',
    description:
      'Execute the most recently proposed anonymous Apex script. In the desktop app, call ' +
      'WITHOUT a confirmation code — the user approves in Deploy Review and this call ' +
      'waits for their decision. With the localhost approval page, pass the code the human ' +
      'read from the page. Single-use, ~1h expiry, invalidated by a new apex_propose on ' +
      "the same connection. On success the script's DML is committed; compile and runtime " +
      'errors are returned honestly and spend the approval.',
    grant: 'data_write',
    writeClass: true,
    inputSchema: {
      connection: z.string().describe('Target connection alias (or id).'),
      confirmation_code: z
        .string()
        .optional()
        .describe(
          'Only when the human read a code from the approval page (format XXXX-XXXX). ' +
            'Omit in the desktop app — approval is native.',
        ),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; confirmation_code?: string };
        const conn = requireConnection(deps, args.connection, 'apex_execute');
        if (!args.confirmation_code) {
          return fail(
            'No confirmation code and no pending native approval. Propose first; then in the ' +
              'desktop app call again without a code, or with the approval page pass its code.',
          );
        }
        const result = await deps.deploys.executeApex(conn, args.confirmation_code);
        return ok(result);
      }),
  },
  {
    name: 'bulk_load_propose',
    title: 'Propose a bulk data load from CSV files (two-step)',
    description:
      'Stage a multi-file Bulk API 2.0 data load behind the approval ritual. Rows go ' +
      'FILE → ORG and never through this conversation: prepare UTF-8, comma-delimited ' +
      'CSVs in a linked project folder (API-name headers; cross-object references as ' +
      'relationship-by-external-ID columns like "Account.External_Id__c", resolved ' +
      'org-side), then name one file per step by its {folder, path} coordinates from ' +
      'list_project_files. Steps execute SEQUENTIALLY in the order given — parents ' +
      'before children. Each file is scanned (headers, row count) and FROZEN at ' +
      'propose; the human approves the whole plan in Deploy Review with counts and ' +
      'hashes per step. Bulk steps are separate org-side jobs with NO cross-job ' +
      'rollback; delete steps are SOFT deletes (Recycle Bin) and their CSV is a ' +
      'single Id column. For small test-data seeding (≤200 rows) prefer dml_propose.',
    grant: 'data_write',
    writeClass: true,
    inputSchema: {
      connection: z
        .string()
        .describe('Target connection alias (or id) — name it unmissably to the human.'),
      steps: z
        .array(
          z.object({
            folder: z
              .string()
              .describe('Linked project folder name (as listed by list_project_files).'),
            path: z
              .string()
              .describe("The CSV's path relative to that folder (forward slashes)."),
            object: z.string().describe('SObject API name, e.g. Account or Invoice__c.'),
            operation: z.enum(['insert', 'upsert', 'delete']),
            external_id_field: z
              .string()
              .optional()
              .describe(
                "upsert only (required there): the match field. Pass 'Id' to update by " +
                  'record id. Must be a column in the CSV.',
              ),
            abs_path: z
              .string()
              .optional()
              .describe(
                'Host-injected. Never set this yourself — it is stripped and re-resolved ' +
                  'from {folder, path} by the desktop app.',
              ),
          }),
        )
        .min(1)
        .max(50)
        .describe('Ordered steps — one CSV each, executed sequentially.'),
      stop_on_failure: z
        .boolean()
        .optional()
        .describe(
          'Default true: a step with failed rows halts the remaining steps (rows already ' +
            'loaded STAY — bulk has no cross-job rollback). false runs every step.',
        ),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as {
          connection: string;
          steps: Array<{
            folder: string;
            path: string;
            object: string;
            operation: 'insert' | 'upsert' | 'delete';
            external_id_field?: string;
            abs_path?: string;
          }>;
          stop_on_failure?: boolean;
        };
        const conn = requireConnection(deps, args.connection, 'bulk_load_propose');
        // SECURITY INVARIANT: the engine only ever receives paths the HOST
        // resolved. agentRuntime strips any agent-supplied abs_path and
        // re-resolves each {folder, path} against the session's own project's
        // linked folders before this handler runs. A step arriving here
        // without abs_path means the call did not come through that gate.
        const missing = args.steps.find((s) => !s.abs_path);
        if (missing) {
          return fail(
            'File coordinates are resolved by the desktop app from {folder, path} — ' +
              'direct filesystem paths are not accepted. Link the folder holding the ' +
              "CSVs in the project's Docs tab and name files by folder + relative path.",
          );
        }
        const preview = await deps.deploys.proposeBulkLoad(conn, {
          stopOnFailure: args.stop_on_failure ?? true,
          steps: args.steps.map((s) => ({
            sourcePath: s.abs_path!,
            displayName: `${s.folder}/${s.path}`,
            object: s.object,
            operation: s.operation,
            ...(s.external_id_field ? { externalIdField: s.external_id_field } : {}),
          })),
        });
        return ok(
          preview,
          `Proposed — nothing loaded. TARGET: ${conn.alias} (${conn.orgType}). ${APPROVAL_INSTRUCTIONS}`,
        );
      }),
  },
  {
    name: 'bulk_load_execute',
    title: 'Execute a proposed bulk data load',
    description:
      'Run the most recently proposed bulk load plan: sequential Bulk API 2.0 ingest ' +
      'jobs from the CSVs frozen at propose. In the desktop app, call WITHOUT a ' +
      'confirmation code — the user approves in Deploy Review and this call waits for ' +
      'their decision. With the localhost approval page, pass the code the human read ' +
      'from the page. Large jobs take minutes: an in-progress result means call again ' +
      'the same way to check on it. Failed and unprocessed rows come back as CSV file ' +
      'paths (never row data); rows loaded by completed steps are never rolled back.',
    grant: 'data_write',
    writeClass: true,
    inputSchema: {
      connection: z.string().describe('Target connection alias (or id).'),
      confirmation_code: z
        .string()
        .optional()
        .describe(
          'Only when the human read a code from the approval page (format XXXX-XXXX). ' +
            'Omit in the desktop app — approval is native.',
        ),
    },
    handler: (deps, rawArgs) =>
      guarded(async () => {
        const args = rawArgs as { connection: string; confirmation_code?: string };
        const conn = requireConnection(deps, args.connection, 'bulk_load_execute');
        if (!args.confirmation_code) {
          return fail(
            'No confirmation code and no pending native approval. Propose first; then in the ' +
              'desktop app call again without a code, or with the approval page pass its code.',
          );
        }
        const outcome = await deps.deploys.executeBulkLoad(conn, args.confirmation_code);
        switch (outcome.status) {
          case 'in_progress':
            return ok(
              { progress: outcome.progress, started_at: outcome.started_at },
              'The bulk load is still running — call bulk_load_execute again the same way ' +
                'to check on it.',
            );
          case 'failed':
            return fail(`Bulk load errored: ${outcome.error}`);
          case 'complete':
            return ok(outcome.result);
        }
      }),
  },
];
