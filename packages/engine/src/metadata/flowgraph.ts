import { extractChildBlocks } from '../snapshot/indexer.js';

/**
 * Flow XML → a node/edge graph for the desktop's diagram view. Best-effort
 * structural read of Flow Builder metadata: every canvas element becomes a
 * node; connectors (normal, fault, decision rules, loop next/end, scheduled
 * paths) become labeled edges. Same regex-block idiom as the indexer.
 */

export type FlowNodeKind =
  | 'start'
  | 'assignment'
  | 'decision'
  | 'recordLookup'
  | 'recordCreate'
  | 'recordUpdate'
  | 'recordDelete'
  | 'screen'
  | 'loop'
  | 'subflow'
  | 'action'
  | 'wait'
  | 'transform'
  | 'collection'
  | 'customError'
  | 'rollback'
  | 'stage'
  | 'end';

export interface FlowGraphNode {
  name: string;
  label: string;
  kind: FlowNodeKind;
  /** Extra context: action name for actions, object for record ops. */
  detail: string | null;
  /** Inspector rows: decision criteria, query filters, assignments, … */
  props: Array<{ name: string; value: string }>;
  /** The element's raw XML block — the inspector's ground-truth fallback. */
  xml: string;
}

export type FlowEdgeKind = 'normal' | 'fault' | 'decision' | 'loop_next' | 'loop_end';

export interface FlowGraphEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  /** Rule/path label for decision and scheduled-path edges. */
  label: string | null;
}

export interface FlowGraph {
  label: string | null;
  processType: string | null;
  status: string | null;
  /** Trigger description assembled from the start element. */
  trigger: string | null;
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  /** Elements referenced by connectors but not defined (partial/exotic flows). */
  unresolved: string[];
}

const ELEMENT_KINDS: Array<[string, FlowNodeKind]> = [
  ['assignments', 'assignment'],
  ['decisions', 'decision'],
  ['recordLookups', 'recordLookup'],
  ['recordCreates', 'recordCreate'],
  ['recordUpdates', 'recordUpdate'],
  ['recordDeletes', 'recordDelete'],
  ['screens', 'screen'],
  ['loops', 'loop'],
  ['subflows', 'subflow'],
  ['actionCalls', 'action'],
  ['apexPluginCalls', 'action'],
  ['waits', 'wait'],
  ['transforms', 'transform'],
  ['collectionProcessors', 'collection'],
  ['customErrors', 'customError'],
  ['recordRollbacks', 'rollback'],
  ['orchestratedStages', 'stage'],
];

function tagValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? null;
}

/**
 * The element's OWN <name> — not the first <name> descendant. Process
 * Builder-generated flows open every element with <processMetadataValues>
 * blocks whose children include their own <name> tags, so first-match naming
 * registered those nodes under a metadata key ("index", "referenceTargetField")
 * and every connector pointing at the real name came back unresolved. Strip
 * the nested wrappers that legitimately carry <name> children, then match.
 */
function elementName(block: string): string | null {
  const cleaned = block
    .replace(/<processMetadataValues>[\s\S]*?<\/processMetadataValues>/g, '')
    .replace(/<inputParameters>[\s\S]*?<\/inputParameters>/g, '')
    .replace(/<outputParameters>[\s\S]*?<\/outputParameters>/g, '');
  return tagValue(cleaned, 'name');
}

/** First targetReference inside the FIRST occurrence of the given connector tag. */
function connectorTarget(block: string, connectorTag: string): string | null {
  const match = block.match(
    new RegExp(`<${connectorTag}>[\\s\\S]*?<targetReference>([\\s\\S]*?)</targetReference>[\\s\\S]*?</${connectorTag}>`),
  );
  return match?.[1]?.trim() ?? null;
}

/** Render a Flow value block (<elementReference>/<stringValue>/…) as display text. */
function valueText(block: string): string {
  const ref = tagValue(block, 'elementReference');
  if (ref != null) return `{!${ref}}`;
  for (const tag of ['stringValue', 'numberValue', 'booleanValue', 'dateValue', 'dateTimeValue', 'apexValue']) {
    const v = tagValue(block, tag);
    if (v != null) return v;
  }
  if (/<value\s*\/>|<value>\s*<\/value>/.test(block)) return '(empty)';
  return '';
}

/** "field operator value" line from a condition/filter block. */
function conditionText(block: string): string {
  const left =
    tagValue(block, 'leftValueReference') ?? tagValue(block, 'field') ?? '?';
  const operator = tagValue(block, 'operator') ?? '=';
  const rightBlock = block.match(/<(rightValue|value)>([\s\S]*?)<\/\1>/);
  const right = rightBlock ? valueText(rightBlock[2] ?? '') : '';
  return `${left} ${operator}${right ? ' ' + right : ''}`;
}

/** Best-effort per-kind inspector rows. Crash-safe: unknown shapes yield []. */
function extractProps(block: string, kind: FlowNodeKind): Array<{ name: string; value: string }> {
  const props: Array<{ name: string; value: string }> = [];
  const push = (name: string, value: string | null): void => {
    if (value) props.push({ name, value });
  };
  if (kind === 'decision') {
    for (const rule of extractChildBlocks(block, 'rules')) {
      const conditions = extractChildBlocks(rule, 'conditions').map(conditionText);
      const logic = tagValue(rule, 'conditionLogic');
      push(
        tagValue(rule, 'label') ?? tagValue(rule, 'name') ?? 'rule',
        conditions.join(logic === 'or' ? ' OR ' : ' AND ') || '(no conditions)',
      );
    }
    push('default', tagValue(block, 'defaultConnectorLabel'));
  } else if (kind === 'recordLookup' || kind === 'recordUpdate' || kind === 'recordDelete') {
    push('object', tagValue(block, 'object'));
    const filters = extractChildBlocks(block, 'filters').map(conditionText);
    if (filters.length > 0) {
      const logic = tagValue(block, 'filterLogic');
      push('filters', filters.join(logic === 'or' ? ' OR ' : ' AND '));
    }
    push('sort', tagValue(block, 'sortField'));
    push('first record only', tagValue(block, 'getFirstRecordOnly'));
    for (const assignment of extractChildBlocks(block, 'inputAssignments')) {
      push(tagValue(assignment, 'field') ?? 'field', valueText(assignment));
    }
  } else if (kind === 'recordCreate') {
    push('object', tagValue(block, 'object'));
    for (const assignment of extractChildBlocks(block, 'inputAssignments')) {
      push(tagValue(assignment, 'field') ?? 'field', valueText(assignment));
    }
  } else if (kind === 'assignment') {
    for (const item of extractChildBlocks(block, 'assignmentItems')) {
      const target = tagValue(item, 'assignToReference') ?? '?';
      const operator = tagValue(item, 'operator') ?? 'Assign';
      props.push({ name: target, value: `${operator} ${valueText(item)}`.trim() });
    }
  } else if (kind === 'action') {
    push('action', tagValue(block, 'actionName'));
    push('type', tagValue(block, 'actionType'));
    for (const param of extractChildBlocks(block, 'inputParameters')) {
      push(tagValue(param, 'name') ?? 'param', valueText(param));
    }
  } else if (kind === 'subflow') {
    push('flow', tagValue(block, 'flowName'));
    for (const assignment of extractChildBlocks(block, 'inputAssignments')) {
      push(tagValue(assignment, 'name') ?? 'input', valueText(assignment));
    }
  } else if (kind === 'loop') {
    push('collection', tagValue(block, 'collectionReference'));
    push('order', tagValue(block, 'iterationOrder'));
  } else if (kind === 'start') {
    push('object', tagValue(block, 'object'));
    push('trigger', tagValue(block, 'triggerType'));
    push('on', tagValue(block, 'recordTriggerType'));
    const filters = extractChildBlocks(block, 'filters').map(conditionText);
    if (filters.length > 0) {
      const logic = tagValue(block, 'filterLogic');
      push('entry criteria', filters.join(logic === 'or' ? ' OR ' : ' AND '));
    }
    push('requires record changed', tagValue(block, 'doesRequireRecordChangedToMeetCriteria'));
    for (const path of extractChildBlocks(block, 'scheduledPaths')) {
      const offset = [tagValue(path, 'offsetNumber'), tagValue(path, 'offsetUnit')]
        .filter(Boolean)
        .join(' ');
      push(`path: ${tagValue(path, 'label') ?? tagValue(path, 'name') ?? 'scheduled'}`, offset || 'immediate');
    }
  } else if (kind === 'collection') {
    push('type', tagValue(block, 'collectionProcessorType'));
    push('collection', tagValue(block, 'collectionReference'));
  }
  return props;
}

export function parseFlowGraph(xml: string): FlowGraph {
  const nodes: FlowGraphNode[] = [];
  const edges: FlowGraphEdge[] = [];
  const defined = new Set<string>();

  // Top-level flow facts. The flow's own <label> is the first label OUTSIDE
  // any element block — cheapest reliable read: strip element blocks first.
  let outer = xml;
  for (const [tag] of ELEMENT_KINDS) {
    outer = outer.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
  }
  const flowLabel = tagValue(outer, 'label');
  const processType = tagValue(outer, 'processType');
  const status = tagValue(outer, 'status');

  for (const [tag, kind] of ELEMENT_KINDS) {
    for (const block of extractChildBlocks(xml, tag)) {
      const name = elementName(block);
      if (!name) continue;
      defined.add(name);
      let detail: string | null = null;
      if (kind === 'action') detail = tagValue(block, 'actionName') ?? tagValue(block, 'apexClass');
      else if (kind === 'recordLookup' || kind === 'recordCreate' || kind === 'recordUpdate' || kind === 'recordDelete')
        detail = tagValue(block, 'object');
      else if (kind === 'subflow') detail = tagValue(block, 'flowName');
      else if (kind === 'collection') detail = tagValue(block, 'collectionProcessorType');
      nodes.push({
        name,
        label: tagValue(block, 'label') ?? name,
        kind,
        detail,
        props: extractProps(block, kind),
        xml: block.trim(),
      });

      if (kind === 'decision') {
        for (const rule of extractChildBlocks(block, 'rules')) {
          const target = connectorTarget(rule, 'connector');
          if (target) {
            edges.push({
              from: name,
              to: target,
              kind: 'decision',
              label: tagValue(rule, 'label') ?? tagValue(rule, 'name'),
            });
          }
        }
        const def = connectorTarget(block, 'defaultConnector');
        if (def) {
          edges.push({
            from: name,
            to: def,
            kind: 'decision',
            label: tagValue(block, 'defaultConnectorLabel') ?? 'default',
          });
        }
      } else if (kind === 'loop') {
        const next = connectorTarget(block, 'nextValueConnector');
        if (next) edges.push({ from: name, to: next, kind: 'loop_next', label: 'each item' });
        const done = connectorTarget(block, 'noMoreValuesConnector');
        if (done) edges.push({ from: name, to: done, kind: 'loop_end', label: 'after last' });
      } else {
        // waits carry connectors inside waitEvents; generic elements carry one.
        if (kind === 'wait') {
          for (const event of extractChildBlocks(block, 'waitEvents')) {
            const target = connectorTarget(event, 'connector');
            if (target) {
              edges.push({
                from: name,
                to: target,
                kind: 'normal',
                label: tagValue(event, 'label') ?? tagValue(event, 'name'),
              });
            }
          }
        }
        const target = connectorTarget(block, 'connector');
        if (target) edges.push({ from: name, to: target, kind: 'normal', label: null });
      }
      const fault = connectorTarget(block, 'faultConnector');
      if (fault) edges.push({ from: name, to: fault, kind: 'fault', label: 'fault' });
    }
  }

  // The start element: object/trigger facts + entry edge(s).
  const startBlocks = extractChildBlocks(xml, 'start');
  const startBlock = startBlocks[0] ?? null;
  let trigger: string | null = null;
  defined.add('__start');
  nodes.unshift({
    name: '__start',
    label: 'Start',
    kind: 'start',
    detail: null,
    props: startBlock ? extractProps(startBlock, 'start') : [],
    xml: startBlock?.trim() ?? '',
  });
  if (startBlock) {
    const object = tagValue(startBlock, 'object');
    const triggerType = tagValue(startBlock, 'triggerType');
    const recordTriggerType = tagValue(startBlock, 'recordTriggerType');
    trigger =
      [triggerType, recordTriggerType && `on ${recordTriggerType}`, object && `of ${object}`]
        .filter(Boolean)
        .join(' ') || null;
    const direct = connectorTarget(startBlock, 'connector');
    if (direct) edges.push({ from: '__start', to: direct, kind: 'normal', label: null });
    for (const path of extractChildBlocks(startBlock, 'scheduledPaths')) {
      const target = connectorTarget(path, 'connector');
      if (target) {
        edges.push({
          from: '__start',
          to: target,
          kind: 'normal',
          label: tagValue(path, 'label') ?? tagValue(path, 'name') ?? 'scheduled',
        });
      }
    }
  } else {
    const legacy = tagValue(xml, 'startElementReference');
    if (legacy) edges.push({ from: '__start', to: legacy, kind: 'normal', label: null });
  }

  const unresolved = [...new Set(edges.map((e) => e.to).filter((t) => !defined.has(t)))];
  return { label: flowLabel, processType, status, trigger, nodes, edges, unresolved };
}

// ── flow-to-flow node comparison (diff drill-in highlighting) ────────────

export interface FlowNodeChanges {
  /** Present in both versions with different element XML. */
  changed: string[];
  /** Only in version B. */
  addedInB: string[];
  /** Only in version A. */
  removedInB: string[];
}

/** Whitespace-insensitive block equality — reordered elements still differ,
 * but reformatting alone must not read as a change. */
function normalizeBlock(xml: string): string {
  return xml
    .replace(/>\s+</g, '><') // inter-tag whitespace is pure formatting
    .replace(/\s+/g, ' ')
    .trim();
}

export function diffFlowNodes(a: FlowGraph, b: FlowGraph): FlowNodeChanges {
  const byNameA = new Map(a.nodes.map((n) => [n.name.toLowerCase(), n]));
  const byNameB = new Map(b.nodes.map((n) => [n.name.toLowerCase(), n]));
  const changed: string[] = [];
  const addedInB: string[] = [];
  const removedInB: string[] = [];
  for (const node of b.nodes) {
    const other = byNameA.get(node.name.toLowerCase());
    if (!other) {
      addedInB.push(node.name);
    } else if (normalizeBlock(other.xml) !== normalizeBlock(node.xml)) {
      changed.push(node.name);
    }
  }
  for (const node of a.nodes) {
    if (!byNameB.has(node.name.toLowerCase())) removedInB.push(node.name);
  }
  return { changed, addedInB, removedInB };
}
