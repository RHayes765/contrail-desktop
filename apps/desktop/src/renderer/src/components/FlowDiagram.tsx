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
const MIN_ROW_GAP = 78; // clear space between a node's bottom and the next row
const PILL_H = 20;
const LABEL_STEP = 20;
const MAX_NODES = 120;

/**
 * Salesforce Flow Builder's own grouping: internal logic orange, data
 * operations pink, external actions/interaction blue, start green.
 */
const SF_ORANGE = '#dd7a01';
const SF_PINK = '#ff538a';
const SF_BLUE = '#1b96ff';
const SF_GREEN = '#2e844a';

const KIND_COLORS: Record<string, string> = {
  start: SF_GREEN,
  // internal logic
  decision: SF_ORANGE,
  assignment: SF_ORANGE,
  transform: SF_ORANGE,
  loop: SF_ORANGE,
  collection: SF_ORANGE,
  wait: SF_ORANGE,
  customError: SF_ORANGE,
  stage: SF_ORANGE,
  // data operations
  recordLookup: SF_PINK,
  recordCreate: SF_PINK,
  recordUpdate: SF_PINK,
  recordDelete: SF_PINK,
  rollback: SF_PINK,
  // external actions & interaction
  action: SF_BLUE,
  subflow: SF_BLUE,
  screen: SF_BLUE,
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

/** Per-source attachment stack: go-to pills first, then branch labels. */
interface SourceStack {
  gotoCount: number;
  labeledCount: number;
  /** Pixel depth of everything hanging under the node. */
  stackPx: number;
}

function stackFor(gotoCount: number, labeledCount: number): number {
  const pills = gotoCount > 0 ? 6 + gotoCount * (PILL_H + 3) : 6;
  const labels = labeledCount > 0 ? 14 + labeledCount * LABEL_STEP : 0;
  return pills + labels;
}

function layout(graph: FlowGraphView): {
  placed: Map<string, Placed>;
  width: number;
  height: number;
  depth: Map<string, number>;
  stacks: Map<string, SourceStack>;
  rowGap: number;
} {
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

  // Classify per-source BEFORE pixel placement: a drawable edge targets the
  // next row down; everything else becomes a go-to pill. The deepest
  // attachment stack sets the row gap, so labels can never collide with the
  // next row no matter how many branches a decision has.
  const stacks = new Map<string, SourceStack>();
  let maxStack = 0;
  for (const node of graph.nodes) {
    const out = graph.edges.filter((e) => e.from === node.name);
    const drawable = out.filter((e) => (depth.get(e.to) ?? -99) === (depth.get(node.name) ?? 0) + 1);
    const gotoCount = out.length - drawable.length;
    const labeledCount = drawable.filter((e) => e.label).length;
    const stackPx = stackFor(gotoCount, labeledCount);
    stacks.set(node.name, { gotoCount, labeledCount, stackPx });
    maxStack = Math.max(maxStack, stackPx);
  }
  // Room for source-side stacks below nodes AND end-labels above targets
  // (two alternating bands) — labels can never reach into either.
  const rowGap = Math.max(MIN_ROW_GAP + 30, maxStack + 2 * LABEL_STEP + 26);
  const gapY = NODE_H + rowGap;

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
    const y = 20 + d * gapY;
    placed.set(node.name, { ...node, x, y });
    height = Math.max(height, y + NODE_H + 20);
  }
  return { placed, width: canvasWidth, height, depth, stacks, rowGap };
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
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
  depth: Map<string, number>,
  stacks: Map<string, SourceStack>,
): { drawn: DrawnEdge[]; pills: GoToPill[] } {
  const drawn: DrawnEdge[] = [];
  const pills: GoToPill[] = [];
  const bySource = new Map<string, typeof graph.edges>();
  const inboundCount = new Map<string, number>();
  const inboundSeen = new Map<string, number>();
  for (const edge of graph.edges) {
    const list = bySource.get(edge.from) ?? [];
    list.push(edge);
    bySource.set(edge.from, list);
    if ((depth.get(edge.to) ?? -99) === (depth.get(edge.from) ?? 0) + 1) {
      inboundCount.set(edge.to, (inboundCount.get(edge.to) ?? 0) + 1);
    }
  }
  for (const [from, edges] of bySource) {
    const a = placed.get(from);
    if (!a) continue;
    // Same classification the layout sized the rows for: next row = drawable.
    const drawable = edges.filter(
      (e) => (depth.get(e.to) ?? -99) === (depth.get(from) ?? 0) + 1,
    );
    const gotos = edges.filter((e) => !drawable.includes(e));

    // Go-to pills stack under the node, one per line.
    const pillsBase = a.y + NODE_H + 6;
    gotos.forEach((edge, i) => {
      const target = placed.get(edge.to);
      pills.push({
        x: a.x,
        y: pillsBase + i * (PILL_H + 3),
        text: `${edge.label ? edge.label + ' ' : ''}→ ${truncate(target?.label ?? edge.to, 20)}`,
        target: edge.to,
        fault: edge.kind === 'fault',
      });
    });
    const stackPx = stacks.get(from)?.stackPx ?? 0;

    drawable.forEach((edge, i) => {
      const b = placed.get(edge.to) as Placed;
      const spread = (i - (drawable.length - 1) / 2) * 22;
      const x1 = a.x + NODE_W / 2 + spread;
      const y1 = a.y + NODE_H;
      // Arrival spread: converging edges each get their own landing x on the
      // target, so final segments never merge — and each end-label gets its
      // own column right above where its line lands.
      const arrivals = inboundCount.get(edge.to) ?? 1;
      const slot = inboundSeen.get(edge.to) ?? 0;
      inboundSeen.set(edge.to, slot + 1);
      const arrivalSpread =
        arrivals > 1 ? (slot - (arrivals - 1) / 2) * Math.min(34, (NODE_W - 24) / arrivals) : 0;
      const x2 = b.x + NODE_W / 2 + arrivalSpread;
      const y2 = b.y;
      const jogY = Math.min(y2 - LABEL_STEP - 12, y1 + stackPx + 18);
      drawn.push({
        path:
          Math.abs(x1 - x2) < 2
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} L ${x1} ${jogY} L ${x2} ${jogY} L ${x2} ${y2}`,
        fault: edge.kind === 'fault',
        label: edge.label,
        // Labels ride the END of the line: on the arrival segment, just
        // above the target, alternating two bands when arrivals are dense.
        labelX: x2,
        labelY: y2 - 10 - (slot % 2) * LABEL_STEP,
      });
    });
  }
  return { drawn, pills };
}

type FlowNode = FlowGraphView['nodes'][number];

/** Diff-mode node marking: which nodes changed/appeared/disappeared. */
export type FlowHighlights = Record<string, 'changed' | 'added' | 'removed'>;

const HIGHLIGHT_COLORS: Record<'changed' | 'added' | 'removed', string> = {
  changed: 'var(--env-scratch)',
  added: 'var(--env-sandbox)',
  removed: 'var(--env-production)',
};

function Canvas({
  graph,
  onJump,
  selected,
  onSelect,
  highlights,
}: {
  graph: FlowGraphView;
  onJump: (name: string) => void;
  selected: string | null;
  onSelect: (node: FlowNode) => void;
  highlights?: FlowHighlights;
}) {
  const { placed, width, height, depth, stacks } = useMemo(() => layout(graph), [graph]);
  const { drawn, pills } = useMemo(
    () => planEdges(graph, placed, depth, stacks),
    [graph, placed, depth, stacks],
  );
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
      {[...placed.values()].map((node) => {
        const full = graph.nodes.find((n) => n.name === node.name);
        const mark = highlights?.[node.name];
        return (
          <g
            key={node.name}
            id={`flow-node-${node.name}`}
            className="flow-node-hit"
            onClick={() => full && onSelect(full)}
          >
            {mark && (
              <rect
                x={node.x - 5}
                y={node.y - 5}
                width={NODE_W + 10}
                height={NODE_H + 10}
                rx={11}
                fill="none"
                stroke={HIGHLIGHT_COLORS[mark]}
                strokeWidth={2.5}
                strokeDasharray={mark === 'changed' ? '6 4' : undefined}
                opacity={0.9}
              />
            )}
            <rect
              x={node.x}
              y={node.y}
              width={NODE_W}
              height={NODE_H}
              rx={8}
              className={selected === node.name ? 'flow-node selected' : 'flow-node'}
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
        );
      })}
    </svg>
  );
}

/** Flow Builder-style attribute panel for the clicked node. */
function InspectorPanel({ node, onClose }: { node: FlowNode; onClose: () => void }) {
  const [showXml, setShowXml] = useState(false);
  return (
    <div className="flow-inspector">
      <div className="flow-inspector-head">
        <div>
          <div className="conn-alias">{node.label}</div>
          <div className="conn-detail">
            {KIND_LABELS[node.kind] ?? node.kind}
            {node.detail && ` · ${node.detail}`}
          </div>
        </div>
        <button onClick={onClose}>✕</button>
      </div>
      {node.props.length > 0 ? (
        <table className="flow-props">
          <tbody>
            {node.props.map((p, i) => (
              <tr key={i}>
                <td className="flow-prop-name">{p.name}</td>
                <td className="flow-prop-value">{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="conn-detail">No parsed attributes for this element kind.</p>
      )}
      {node.xml && (
        <>
          <button className="flow-xml-toggle" onClick={() => setShowXml((v) => !v)}>
            {showXml ? 'Hide element XML' : 'Element XML'}
          </button>
          {showXml && <pre className="meta-source flow-inspector-xml">{node.xml}</pre>}
        </>
      )}
    </div>
  );
}

export function FlowDiagram({
  graph,
  highlights,
}: {
  graph: FlowGraphView;
  highlights?: FlowHighlights;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const [selected, setSelected] = useState<FlowNode | null>(null);

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
      {highlights && Object.keys(highlights).length > 0 && (
        <p className="conn-detail flow-legend">
          <span className="flow-legend-swatch changed" /> changed
          <span className="flow-legend-swatch added" /> added
          <span className="flow-legend-swatch removed" /> removed
        </p>
      )}
      <div className="flow-stage">
        <div className="flow-scroll">
          <Canvas
            graph={graph}
            onJump={jump}
            selected={selected?.name ?? null}
            onSelect={(node) => setSelected((cur) => (cur?.name === node.name ? null : node))}
            highlights={highlights}
          />
        </div>
        {selected && <InspectorPanel node={selected} onClose={() => setSelected(null)} />}
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
