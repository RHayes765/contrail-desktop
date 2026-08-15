import { useEffect, useMemo, useState } from 'react';
import type { FlowGraphView } from '@contrail/shared';

/**
 * Read-only flow canvas, Salesforce-auto-layout style:
 *   - top-to-bottom layered layout, straight right-angle connectors;
 *   - ONLY adjacent-row edges are drawn — anything longer, backward, or
 *     sideways terminates in a "Go To" pill naming its target (that pill
 *     trick is what keeps Flow Builder's own canvas legible);
 *   - fault paths dashed red; branch labels in small pills on the line;
 *   - fullscreen pop-out for big monitors.
 * Hand-rolled SVG — no chart library, CSP-clean.
 */

const NODE_W = 176;
const NODE_H = 50;
const GAP_X = 208;
const GAP_Y = 128;
const PILL_H = 20;
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

  // Barycenter sweep: order each row by mean parent position above.
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

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Straight right-angle connector: down, across at the midpoint, down. */
function orthogonalPath(x1: number, y1: number, x2: number, y2: number): string {
  if (Math.abs(x1 - x2) < 2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;
}

interface DrawnEdge {
  path: string;
  fault: boolean;
  label: string | null;
  labelX: number;
  labelY: number;
}

interface GoToPill {
  x: number;
  y: number;
  text: string;
  target: string;
  fault: boolean;
}

function planEdges(
  graph: FlowGraphView,
  placed: Map<string, Placed>,
): { drawn: DrawnEdge[]; pills: GoToPill[] } {
  const drawn: DrawnEdge[] = [];
  const pills: GoToPill[] = [];
  // Group out-edges per source so drops and pills spread instead of stacking.
  const bySource = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const list = bySource.get(edge.from) ?? [];
    list.push(edge);
    bySource.set(edge.from, list);
  }
  for (const [from, edges] of bySource) {
    const a = placed.get(from);
    if (!a) continue;
    // Drawable = target exactly one row below (the Flow Builder rule of thumb).
    const drawable = edges.filter((e) => {
      const b = placed.get(e.to);
      return b != null && b.y > a.y && b.y - a.y <= GAP_Y + NODE_H;
    });
    const gotos = edges.filter((e) => !drawable.includes(e));

    drawable.forEach((edge, i) => {
      const b = placed.get(edge.to) as Placed;
      const spread = (i - (drawable.length - 1) / 2) * 22;
      const x1 = a.x + NODE_W / 2 + spread;
      const y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2;
      const y2 = b.y;
      drawn.push({
        path: orthogonalPath(x1, y1, x2, y2),
        fault: edge.kind === 'fault',
        label: edge.label,
        // Branch labels sit on the vertical drop just under the source —
        // spread with the drop so parallel branches never collide.
        labelX: x1,
        labelY: y1 + 26,
      });
    });
    gotos.forEach((edge, i) => {
      const target = placed.get(edge.to);
      pills.push({
        x: a.x,
        y: a.y + NODE_H + 6 + i * (PILL_H + 3),
        text: `${edge.label ? edge.label + ' ' : ''}→ ${truncate(target?.label ?? edge.to, 20)}`,
        target: edge.to,
        fault: edge.kind === 'fault',
      });
    });
  }
  return { drawn, pills };
}

function Canvas({
  graph,
  onJump,
}: {
  graph: FlowGraphView;
  onJump: (name: string) => void;
}) {
  const { placed, width, height } = useMemo(() => layout(graph), [graph]);
  const { drawn, pills } = useMemo(() => planEdges(graph, placed), [graph, placed]);
  // Pills extend below nodes — pad the canvas.
  const fullHeight = height + 60;

  return (
    <svg width={width} height={fullHeight}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-dim)" />
        </marker>
        <marker id="arrow-fault" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--env-production)" />
        </marker>
      </defs>
      {drawn.map((edge, i) => (
        <g key={`e${i}`}>
          <path
            d={edge.path}
            fill="none"
            stroke={edge.fault ? 'var(--env-production)' : 'var(--text-dim)'}
            strokeWidth={1.3}
            strokeDasharray={edge.fault ? '5 4' : undefined}
            markerEnd={edge.fault ? 'url(#arrow-fault)' : 'url(#arrow)'}
            opacity={0.8}
          />
          {edge.label && (
            <g>
              <rect
                x={edge.labelX - edge.label.length * 3.1 - 6}
                y={edge.labelY - 11}
                width={Math.min(edge.label.length, 24) * 6.2 + 12}
                height={16}
                rx={8}
                className="flow-label-pill"
              />
              <text x={edge.labelX} y={edge.labelY} textAnchor="middle" className="flow-edge-label">
                {truncate(edge.label, 24)}
              </text>
            </g>
          )}
        </g>
      ))}
      {pills.map((pill, i) => (
        <g key={`p${i}`} className="flow-goto" onClick={() => onJump(pill.target)}>
          <rect
            x={pill.x}
            y={pill.y}
            width={Math.min(pill.text.length, 34) * 6.1 + 14}
            height={PILL_H}
            rx={10}
            className={pill.fault ? 'flow-goto-pill fault' : 'flow-goto-pill'}
          />
          <text x={pill.x + 8} y={pill.y + 14} className="flow-goto-text">
            {truncate(pill.text, 34)}
          </text>
        </g>
      ))}
      {[...placed.values()].map((node) => (
        <g key={node.name} id={`flow-node-${node.name}`}>
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
  );
}

export function FlowDiagram({ graph }: { graph: FlowGraphView }) {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  if (graph.nodes.length > MAX_NODES) {
    return (
      <div className="empty">
        This flow has {graph.nodes.length} elements — too many for the diagram view. The XML tab
        has the full definition.
      </div>
    );
  }

  const jump = (name: string) => {
    document.getElementById(`flow-node-${name}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'center',
    });
  };

  const body = (
    <>
      {graph.trigger && <p className="conn-detail">Trigger: {graph.trigger}</p>}
      <div className="flow-scroll">
        <Canvas graph={graph} onJump={jump} />
      </div>
      {graph.unresolved.length > 0 && (
        <p className="conn-detail">Unresolved connector targets: {graph.unresolved.join(', ')}</p>
      )}
    </>
  );

  if (fullscreen) {
    return (
      <div className="flow-fullscreen">
        <div className="flow-fullscreen-head">
          <span className="viewer-title">{graph.label ?? 'Flow'}</span>
          <button onClick={() => setFullscreen(false)}>Close (Esc)</button>
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="flow-canvas">
      <div className="flow-canvas-head">
        <button onClick={() => setFullscreen(true)}>⛶ Expand</button>
      </div>
      {body}
    </div>
  );
}
