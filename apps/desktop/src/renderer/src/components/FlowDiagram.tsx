import { useMemo } from 'react';
import type { FlowGraphView } from '@contrail/shared';

/**
 * Read-only flow canvas: BFS-layered layout, boxes colored by element kind,
 * fault edges dashed red, decision/scheduled edges labeled. Hand-rolled SVG —
 * no chart library, CSP-clean, and honest about very large flows (falls back
 * to XML above the node cap rather than rendering soup).
 */

const NODE_W = 176;
const NODE_H = 50;
const GAP_X = 208;
const GAP_Y = 118;
const MAX_NODES = 120;

const KIND_COLORS: Record<string, string> = {
  start: 'var(--env-sandbox)',
  decision: 'var(--env-developer)',
  action: 'var(--accent)',
  subflow: 'var(--accent)',
  recordLookup: 'var(--env-scratch)',
  recordCreate: 'var(--env-scratch)',
  recordUpdate: 'var(--env-scratch)',
  recordDelete: 'var(--env-production)',
  screen: '#3dd6c3',
  loop: '#d6b43d',
  wait: '#d6b43d',
  assignment: 'var(--env-other)',
  transform: 'var(--env-other)',
  collection: 'var(--env-other)',
  customError: 'var(--env-production)',
  rollback: 'var(--env-production)',
  stage: 'var(--env-developer)',
};

const KIND_LABELS: Record<string, string> = {
  recordLookup: 'Get Records',
  recordCreate: 'Create Records',
  recordUpdate: 'Update Records',
  recordDelete: 'Delete Records',
  action: 'Action',
  subflow: 'Subflow',
  decision: 'Decision',
  assignment: 'Assignment',
  screen: 'Screen',
  loop: 'Loop',
  wait: 'Wait',
  transform: 'Transform',
  collection: 'Collection',
  customError: 'Custom Error',
  rollback: 'Roll Back Records',
  stage: 'Stage',
  start: '',
};

interface Placed {
  name: string;
  label: string;
  kind: string;
  detail: string | null;
  x: number;
  y: number;
}

/**
 * Top-to-bottom layered layout, Salesforce-auto-layout style:
 *   - BFS depth from Start = row (unreached chains re-root below the graph
 *     instead of piling into one wall of nodes);
 *   - within each row, nodes order by the average position of their parents
 *     (one barycenter sweep — kills most edge crossings);
 *   - rows are centered relative to the widest row.
 */
function layout(graph: FlowGraphView): { placed: Map<string, Placed>; width: number; height: number } {
  const depth = new Map<string, number>();
  const bfs = (root: string, startDepth: number): void => {
    const queue: Array<{ name: string; d: number }> = [{ name: root, d: startDepth }];
    depth.set(root, startDepth);
    while (queue.length > 0) {
      const { name, d } = queue.shift() as { name: string; d: number };
      for (const edge of graph.edges) {
        if (edge.from !== name || depth.has(edge.to)) continue;
        depth.set(edge.to, d + 1);
        queue.push({ name: edge.to, d: d + 1 });
      }
    }
  };
  bfs('__start', 0);
  // Re-root unreached chains (elements only wired via targets we could not
  // resolve, or genuinely disconnected) below the main graph, preserving
  // their internal structure.
  for (;;) {
    const unplaced = graph.nodes.filter((n) => !depth.has(n.name));
    if (unplaced.length === 0) break;
    const unplacedNames = new Set(unplaced.map((n) => n.name));
    const root =
      unplaced.find(
        (n) => !graph.edges.some((e) => e.to === n.name && unplacedNames.has(e.from)),
      ) ?? unplaced[0];
    if (!root) break;
    bfs(root.name, Math.max(0, ...depth.values()) + 1);
  }

  const rows = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const d = depth.get(node.name) ?? 0;
    const row = rows.get(d) ?? [];
    row.push(node.name);
    rows.set(d, row);
  }

  // Barycenter sweep: order each row by mean parent index in the row above.
  const rowIndex = new Map<string, number>();
  const orderedDepths = [...rows.keys()].sort((a, b) => a - b);
  for (const d of orderedDepths) {
    const row = rows.get(d) ?? [];
    if (d === orderedDepths[0]) {
      row.forEach((name, i) => rowIndex.set(name, i));
      continue;
    }
    const scored = row.map((name) => {
      const parents = graph.edges
        .filter((e) => e.to === name && rowIndex.has(e.from))
        .map((e) => rowIndex.get(e.from) as number);
      const score =
        parents.length > 0 ? parents.reduce((a, b) => a + b, 0) / parents.length : Number.MAX_SAFE_INTEGER;
      return { name, score };
    });
    scored.sort((a, b) => a.score - b.score);
    scored.forEach((s, i) => rowIndex.set(s.name, i));
    rows.set(
      d,
      scored.map((s) => s.name),
    );
  }

  const widest = Math.max(...[...rows.values()].map((r) => r.length));
  const canvasWidth = 40 + widest * GAP_X;
  const placed = new Map<string, Placed>();
  let height = 0;
  for (const node of graph.nodes) {
    const d = depth.get(node.name) ?? 0;
    const row = rows.get(d) ?? [];
    const idx = row.indexOf(node.name);
    const rowWidth = row.length * GAP_X;
    const x = (canvasWidth - rowWidth) / 2 + idx * GAP_X + (GAP_X - NODE_W) / 2;
    const y = 20 + d * GAP_Y;
    placed.set(node.name, { ...node, x, y });
    height = Math.max(height, y + NODE_H + 20);
  }
  return { placed, width: canvasWidth, height };
}

function edgePath(a: Placed, b: Placed): string {
  const x1 = a.x + NODE_W / 2;
  const y1 = a.y + NODE_H;
  const x2 = b.x + NODE_W / 2;
  const y2 = b.y;
  if (y2 > y1) {
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }
  // Back-edge (loop): swing out to the side of both nodes.
  const side = Math.max(x1, x2) + NODE_W;
  return `M ${x1} ${y1} C ${side} ${y1 + 30}, ${side} ${y2 - 30}, ${x2} ${y2}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export function FlowDiagram({ graph }: { graph: FlowGraphView }) {
  const { placed, width, height } = useMemo(() => layout(graph), [graph]);

  if (graph.nodes.length > MAX_NODES) {
    return (
      <div className="empty">
        This flow has {graph.nodes.length} elements — too many for the diagram view. The XML tab
        has the full definition.
      </div>
    );
  }

  return (
    <div className="flow-canvas">
      {graph.trigger && <p className="conn-detail">Trigger: {graph.trigger}</p>}
      <div className="flow-scroll">
        <svg width={width} height={height}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-dim)" />
            </marker>
            <marker id="arrow-fault" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--env-production)" />
            </marker>
          </defs>
          {graph.edges.map((edge, i) => {
            const a = placed.get(edge.from);
            const b = placed.get(edge.to);
            if (!a || !b) return null;
            const fault = edge.kind === 'fault';
            const midX = (a.x + NODE_W + b.x) / 2;
            const midY = (a.y + b.y + NODE_H) / 2;
            return (
              <g key={i}>
                <path
                  d={edgePath(a, b)}
                  fill="none"
                  stroke={fault ? 'var(--env-production)' : 'var(--text-dim)'}
                  strokeWidth={1.4}
                  strokeDasharray={fault ? '5 4' : undefined}
                  markerEnd={fault ? 'url(#arrow-fault)' : 'url(#arrow)'}
                  opacity={0.85}
                />
                {edge.label && (
                  <text x={midX} y={midY - 5} textAnchor="middle" className="flow-edge-label">
                    {truncate(edge.label, 24)}
                  </text>
                )}
              </g>
            );
          })}
          {[...placed.values()].map((node) => (
            <g key={node.name}>
              <rect
                x={node.x}
                y={node.y}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                className="flow-node"
                stroke={KIND_COLORS[node.kind] ?? 'var(--border)'}
              />
              <text x={node.x + 10} y={node.y + 20} className="flow-node-title">
                {truncate(node.label, 22)}
              </text>
              <text x={node.x + 10} y={node.y + 37} className="flow-node-kind">
                {truncate(
                  [KIND_LABELS[node.kind] ?? node.kind, node.detail].filter(Boolean).join(' · '),
                  26,
                )}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {graph.unresolved.length > 0 && (
        <p className="conn-detail">
          Unresolved connector targets: {graph.unresolved.join(', ')}
        </p>
      )}
    </div>
  );
}
