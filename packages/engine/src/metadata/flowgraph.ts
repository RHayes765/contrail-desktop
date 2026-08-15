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
  | 'end';

export interface FlowGraphNode {
  name: string;
  label: string;
  kind: FlowNodeKind;
  /** Extra context: action name for actions, object for record ops. */
  detail: string | null;
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
  ['waits', 'wait'],
];

function tagValue(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? null;
}

/** First targetReference inside the FIRST occurrence of the given connector tag. */
function connectorTarget(block: string, connectorTag: string): string | null {
  const match = block.match(
    new RegExp(`<${connectorTag}>[\\s\\S]*?<targetReference>([\\s\\S]*?)</targetReference>[\\s\\S]*?</${connectorTag}>`),
  );
  return match?.[1]?.trim() ?? null;
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
      const name = tagValue(block, 'name');
      if (!name) continue;
      defined.add(name);
      let detail: string | null = null;
      if (kind === 'action') detail = tagValue(block, 'actionName');
      else if (kind.startsWith('record')) detail = tagValue(block, 'object');
      else if (kind === 'subflow') detail = tagValue(block, 'flowName');
      nodes.push({ name, label: tagValue(block, 'label') ?? name, kind, detail });

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
  nodes.unshift({ name: '__start', label: 'Start', kind: 'start', detail: null });
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
