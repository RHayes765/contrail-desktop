import { useMemo } from 'react';
import type { FlowGraphView } from '@contrail/shared';

/**
 * Read-only flow canvas: BFS-layered layout, boxes colored by element kind,
 * fault edges dashed red, decision/scheduled edges labeled. Hand-rolled SVG —
 * no chart library, CSP-clean, and honest about very large flows (falls back
 * to XML above the node cap rather than rendering soup).
 */

const NODE_W = 172;
const NODE_H = 50;
const GAP_X = 230;
const GAP_Y = 78;
const MAX_NODES = 80;

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

function layout(graph: FlowGraphView): { placed: Map<string, Placed>; width: number; height: number } {
  // BFS depth from __start = column; loop-back/visited edges don't advance.
  const depth = new Map<string, number>();
  const queue: Array<{ name: string; d: number }> = [{ name: '__start', d: 0 }];
  depth.set('__start', 0);
  while (queue.length > 0) {
    const { name, d } = queue.shift() as { name: string; d: number };
    for (const edge of graph.edges) {
      if (edge.from !== name || depth.has(edge.to)) continue;
      depth.set(edge.to, d + 1);
      queue.push({ name: edge.to, d: d + 1 });
    }
  }
  // Orphans (unreached nodes) go in a trailing column.
  const maxDepth = Math.max(0, ...depth.values());
  for (const node of graph.nodes) {
    if (!depth.has(node.name)) depth.set(node.name, maxDepth + 1);
  }

  const columns = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const d = depth.get(node.name) ?? 0;
    const col = columns.get(d) ?? [];
    col.push(node.name);
    columns.set(d, col);
  }

  const placed = new Map<string, Placed>();
  let width = 0;
  let height = 0;
  for (const node of graph.nodes) {
    const d = depth.get(node.name) ?? 0;
    const col = columns.get(d) ?? [];
    const row = col.indexOf(node.name);
    const x = 20 + d * GAP_X;
    const y = 20 + row * GAP_Y;
    placed.set(node.name, { ...node, x, y });
    width = Math.max(width, x + NODE_W + 20);
    height = Math.max(height, y + NODE_H + 20);
  }
  return { placed, width, height };
}

function edgePath(a: Placed, b: Placed): string {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  if (x2 > x1) {
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }
  // Back-edge (loop): route under both nodes.
  const drop = Math.max(y1, y2) + NODE_H;
  return `M ${x1} ${y1} C ${x1 + 40} ${drop}, ${x2 - 40} ${drop}, ${x2} ${y2}`;
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
