"use client";

import * as React from "react";
import { Minus, Plus, RotateCcw, Workflow } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type NodeKind = "neutral" | "info" | "warning" | "success" | "danger" | "muted";

type NodeSpec = {
  id: string;
  label: string;
  cx: number;
  cy: number;
  kind: NodeKind;
};

const VIEW_W = 1980;
const VIEW_H = 460;
const BOX_W = 120;
const BOX_H = 32;

const TOP_Y = 160;
const CANCEL_Y = 400;

const NODES: NodeSpec[] = [
  { id: "BACKLOG", label: "BACKLOG", cx: 90, cy: TOP_Y, kind: "neutral" },
  { id: "TODO", label: "TODO", cx: 290, cy: TOP_Y, kind: "info" },
  { id: "PLANNING", label: "PLANNING", cx: 490, cy: TOP_Y, kind: "info" },
  { id: "IMPLEMENTING", label: "IMPLEMENTING", cx: 720, cy: TOP_Y, kind: "info" },
  { id: "AI-REVIEW", label: "AI-REVIEW", cx: 940, cy: TOP_Y, kind: "warning" },
  { id: "VERIFYING", label: "VERIFYING", cx: 1160, cy: TOP_Y, kind: "warning" },
  { id: "PUBLISHING", label: "PUBLISHING", cx: 1380, cy: TOP_Y, kind: "info" },
  { id: "NEEDS_REVIEW", label: "NEEDS_REVIEW", cx: 1620, cy: TOP_Y, kind: "warning" },
  { id: "DONE", label: "DONE", cx: 1860, cy: TOP_Y, kind: "success" },
  { id: "CANCELED", label: "CANCELED", cx: 1860, cy: CANCEL_Y, kind: "muted" },
];

const nodeById = (id: string): NodeSpec => {
  const n = NODES.find((node) => node.id === id);
  if (!n) throw new Error(`unknown node ${id}`);
  return n;
};

const KIND_FILL: Record<NodeKind, string> = {
  neutral: "rgb(var(--surface))",
  info: "rgb(var(--info))",
  warning: "rgb(var(--warning))",
  success: "rgb(var(--success))",
  danger: "rgb(var(--danger))",
  muted: "rgb(var(--muted))",
};

const KIND_STROKE: Record<NodeKind, string> = {
  neutral: "rgb(var(--border-strong))",
  info: "rgb(var(--info))",
  warning: "rgb(var(--warning))",
  success: "rgb(var(--success))",
  danger: "rgb(var(--danger))",
  muted: "rgb(var(--muted))",
};

const KIND_TEXT: Record<NodeKind, string> = {
  neutral: "rgb(var(--text))",
  info: "#ffffff",
  warning: "#ffffff",
  success: "#ffffff",
  danger: "#ffffff",
  muted: "#ffffff",
};

function Node({ node }: { node: NodeSpec }) {
  return (
    <g>
      <rect
        x={node.cx - BOX_W / 2}
        y={node.cy - BOX_H / 2}
        width={BOX_W}
        height={BOX_H}
        rx={4}
        ry={4}
        style={{ fill: KIND_FILL[node.kind], stroke: KIND_STROKE[node.kind] }}
        strokeWidth={1}
      />
      <text
        x={node.cx}
        y={node.cy}
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fill: KIND_TEXT[node.kind] }}
        fontSize={12}
        fontWeight={500}
        fontFamily="var(--font-ubuntu), system-ui, sans-serif"
      >
        {node.label}
      </text>
    </g>
  );
}

function EdgeLabel({
  x,
  y,
  text,
  color,
  anchor = "middle",
  haloWidth = 6,
}: {
  x: number;
  y: number;
  text: string;
  color: string;
  anchor?: "start" | "middle" | "end";
  haloWidth?: number;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={12}
      fontWeight={500}
      style={{ fill: color }}
      stroke="rgb(var(--bg))"
      strokeWidth={haloWidth}
      strokeLinejoin="round"
      paintOrder="stroke"
      fontFamily="var(--font-ubuntu-mono), monospace"
    >
      {text}
    </text>
  );
}

function rightEdge(node: NodeSpec) {
  return { x: node.cx + BOX_W / 2, y: node.cy };
}
function leftEdge(node: NodeSpec) {
  return { x: node.cx - BOX_W / 2, y: node.cy };
}

// `part` decides which half of the edge to render. Lines/arrowheads go
// FIRST (below nodes); labels go LAST (above nodes) so text reads even
// when the line is shorter than the label.

function ForwardEdge({
  from,
  to,
  label,
  part = "all",
}: {
  from: string;
  to: string;
  label: string;
  part?: "all" | "line" | "label";
}) {
  const a = rightEdge(nodeById(from));
  const b = leftEdge(nodeById(to));
  const midX = (a.x + b.x) / 2;
  return (
    <g>
      {part !== "label" && (
        <line
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke="rgb(var(--text))"
          strokeWidth={1.5}
          markerEnd="url(#arrow-fwd)"
        />
      )}
      {part !== "line" && (
        <EdgeLabel x={midX} y={a.y - 10} text={label} color="rgb(var(--text))" haloWidth={8} />
      )}
    </g>
  );
}

function DeclineEdge({
  from,
  to,
  label,
  part = "all",
}: {
  from: string;
  to: string;
  label: string;
  part?: "all" | "line" | "label";
}) {
  const src = nodeById(from);
  const dst = nodeById(to);
  const a = { x: src.cx, y: src.cy + BOX_H / 2 };
  const b = { x: dst.cx, y: dst.cy + BOX_H / 2 };
  const dip = Math.max(50, Math.abs(a.x - b.x) * 0.35);
  const cy = a.y + dip;
  const path = `M ${a.x} ${a.y} C ${a.x} ${cy}, ${b.x} ${cy}, ${b.x} ${b.y}`;
  return (
    <g>
      {part !== "label" && (
        <path
          d={path}
          fill="none"
          stroke="rgb(var(--warning))"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          markerEnd="url(#arrow-warning)"
        />
      )}
      {part !== "line" && (
        <EdgeLabel
          x={(a.x + b.x) / 2}
          y={a.y + dip * 0.75 + 14}
          text={label}
          color="rgb(var(--warning))"
          haloWidth={8}
        />
      )}
    </g>
  );
}

function SkipEdge({
  from,
  to,
  label,
  part = "all",
}: {
  from: string;
  to: string;
  label: string;
  part?: "all" | "line" | "label";
}) {
  const src = nodeById(from);
  const dst = nodeById(to);
  const a = { x: src.cx, y: src.cy - BOX_H / 2 };
  const b = { x: dst.cx, y: dst.cy - BOX_H / 2 };
  const rise = Math.max(35, Math.abs(a.x - b.x) * 0.15);
  const cy = a.y - rise;
  const path = `M ${a.x} ${a.y} C ${a.x} ${cy}, ${b.x} ${cy}, ${b.x} ${b.y}`;
  return (
    <g>
      {part !== "label" && (
        <path
          d={path}
          fill="none"
          stroke="rgb(var(--info))"
          strokeWidth={1.5}
          strokeDasharray="2 3"
          markerEnd="url(#arrow-info)"
        />
      )}
      {part !== "line" && (
        <EdgeLabel
          x={(a.x + b.x) / 2}
          y={cy - 6}
          text={label}
          color="rgb(var(--info))"
          haloWidth={8}
        />
      )}
    </g>
  );
}

function CancelEdge({ part = "all" }: { part?: "all" | "line" | "label" }) {
  const dst = nodeById("CANCELED");
  const ax = 800;
  const ay = CANCEL_Y;
  const b = leftEdge(dst);
  return (
    <g>
      {part !== "line" && (
        <EdgeLabel x={ax} y={ay - 16} text="any non-terminal task" color="rgb(var(--muted))" anchor="start" haloWidth={8} />
      )}
      {part !== "label" && (
        <line
          x1={ax}
          y1={ay}
          x2={b.x}
          y2={b.y}
          stroke="rgb(var(--muted))"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          markerEnd="url(#arrow-muted)"
        />
      )}
      {part !== "line" && (
        <EdgeLabel x={(ax + b.x) / 2} y={ay - 6} text="human cancel" color="rgb(var(--muted))" haloWidth={8} />
      )}
    </g>
  );
}

// Linear left→right happy path. PLANNING → NEEDS_REVIEW(plan) is shown
// implicitly via the human-approve label on PLANNING → IMPLEMENTING; the
// plan-kind sub-detour is described in the legend. Same for retry / Solve
// with Sonnet, which would force a back-arrow over PUBLISHING.
const FORWARD_EDGES: { from: string; to: string; label: string }[] = [
  { from: "BACKLOG", to: "TODO", label: "human" },
  { from: "TODO", to: "PLANNING", label: "auto pick" },
  { from: "PLANNING", to: "IMPLEMENTING", label: "Opus → human approve plan" },
  { from: "IMPLEMENTING", to: "AI-REVIEW", label: "Sonnet" },
  { from: "AI-REVIEW", to: "VERIFYING", label: "review approve" },
  { from: "VERIFYING", to: "PUBLISHING", label: "Sonnet verified" },
  { from: "PUBLISHING", to: "NEEDS_REVIEW", label: "deliverable | conflict" },
  { from: "NEEDS_REVIEW", to: "DONE", label: "human approve" },
];

// Decline arcs curve under the main row.
const DECLINE_EDGES: { from: string; to: string; label: string }[] = [
  { from: "AI-REVIEW", to: "IMPLEMENTING", label: "review decline" },
  { from: "VERIFYING", to: "IMPLEMENTING", label: "verify fail" },
  { from: "NEEDS_REVIEW", to: "IMPLEMENTING", label: "human decline" },
];

const SKIP_EDGES: { from: string; to: string; label: string }[] = [
  { from: "TODO", to: "IMPLEMENTING", label: "skip_plan" },
  { from: "PLANNING", to: "IMPLEMENTING", label: "skip_plan_review" },
  { from: "IMPLEMENTING", to: "VERIFYING", label: "skip_ai_review" },
  { from: "AI-REVIEW", to: "PUBLISHING", label: "skip_verify" },
  // A2: auto_publish + project.allow_auto_finish → merge straight to DONE.
  { from: "PUBLISHING", to: "DONE", label: "auto-finish" },
];

function Arrowhead({ id, color }: { id: string; color: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX={9}
      refY={5}
      markerWidth={6}
      markerHeight={6}
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
    </marker>
  );
}

function WorkflowGraphSVG() {
  return (
    <svg
      role="img"
      aria-label="Task workflow diagram: states, transitions, models, and gating"
      width={VIEW_W}
      height={VIEW_H}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      style={{ display: "block" }}
    >
      <defs>
        <Arrowhead id="arrow-fwd" color="rgb(var(--text))" />
        <Arrowhead id="arrow-warning" color="rgb(var(--warning))" />
        <Arrowhead id="arrow-info" color="rgb(var(--info))" />
        <Arrowhead id="arrow-muted" color="rgb(var(--muted))" />
      </defs>

      {SKIP_EDGES.map((e) => (
        <SkipEdge key={`s-line-${e.from}-${e.to}`} part="line" {...e} />
      ))}

      {FORWARD_EDGES.map((e) => (
        <ForwardEdge key={`f-line-${e.from}-${e.to}`} part="line" {...e} />
      ))}

      {DECLINE_EDGES.map((e) => (
        <DeclineEdge key={`d-line-${e.from}-${e.to}`} part="line" {...e} />
      ))}

      <CancelEdge part="line" />

      {NODES.map((n) => (
        <Node key={n.id} node={n} />
      ))}

      {/* Labels render LAST so they overlay node fills when the label is
          wider than the gap between two adjacent nodes. */}
      {SKIP_EDGES.map((e) => (
        <SkipEdge key={`s-label-${e.from}-${e.to}`} part="label" {...e} />
      ))}

      {FORWARD_EDGES.map((e) => (
        <ForwardEdge key={`f-label-${e.from}-${e.to}`} part="label" {...e} />
      ))}

      {DECLINE_EDGES.map((e) => (
        <DeclineEdge key={`d-label-${e.from}-${e.to}`} part="label" {...e} />
      ))}

      <CancelEdge part="label" />
    </svg>
  );
}

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.2;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function PanZoomCanvas() {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = React.useState(false);
  const dragRef = React.useRef<
    | { startX: number; startY: number; panX: number; panY: number; pointerId: number }
    | null
  >(null);

  const fitToContainer = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const z = Math.min(w / VIEW_W, h / VIEW_H);
    setZoom(z);
    setPan({ x: (w - VIEW_W * z) / 2, y: (h - VIEW_H * z) / 2 });
  }, []);

  React.useEffect(() => {
    fitToContainer();
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fitToContainer());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitToContainer]);

  const zoomBy = (delta: number, originPx?: { x: number; y: number }) => {
    setZoom((z) => {
      const next = clamp(z + delta, ZOOM_MIN, ZOOM_MAX);
      if (originPx) {
        setPan((p) => {
          const factor = next / z;
          return {
            x: originPx.x - (originPx.x - p.x) * factor,
            y: originPx.y - (originPx.y - p.y) * factor,
          };
        });
      }
      return next;
    });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
      pointerId: e.pointerId,
    };
    setIsDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({
      x: d.panX + (e.clientX - d.startX),
      y: d.panY + (e.clientY - d.startY),
    });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(d.pointerId);
    } catch {
      // pointer already released
    }
    dragRef.current = null;
    setIsDragging(false);
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const origin = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    zoomBy(e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP, origin);
  };

  return (
    <div className="relative border border-border rounded bg-bg h-1/2 min-h-0 md:h-auto md:flex-1">
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden touch-none select-none"
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
            width: VIEW_W,
            height: VIEW_H,
          }}
        >
          <WorkflowGraphSVG />
        </div>
      </div>

      <div className="absolute top-2 right-2 flex flex-col gap-1 z-10">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => zoomBy(ZOOM_STEP)}
          className="h-8 w-8 inline-flex items-center justify-center rounded border border-border bg-surface text-text hover:bg-border"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => zoomBy(-ZOOM_STEP)}
          className="h-8 w-8 inline-flex items-center justify-center rounded border border-border bg-surface text-text hover:bg-border"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Reset view"
          onClick={fitToContainer}
          className="h-8 w-8 inline-flex items-center justify-center rounded border border-border bg-surface text-text hover:bg-border"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      </div>

      <div className="absolute bottom-2 left-2 z-10 text-[10px] font-mono text-text-2 bg-surface/90 border border-border rounded px-1.5 py-0.5">
        drag to pan · ctrl+wheel to zoom · {Math.round(zoom * 100)}%
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="h-1/2 overflow-y-auto md:h-auto md:overflow-visible grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-xs text-text-2 pr-1">
      <div>
        <div className="font-medium text-text mb-1">Models</div>
        <ul className="space-y-0.5">
          <li><span className="font-mono text-text-2">auto</span> — <span className="font-mono text-info">TODO</span> pick (deterministic SQL, no model)</li>
          <li><span className="font-mono text-ai">Opus</span> — <span className="font-mono text-info">PLANNING</span>; <span className="font-mono text-warning">AI-REVIEW</span> only when contested (a prior review cycle exists since the last human comment)</li>
          <li><span className="font-mono text-ai">Sonnet</span> — <span className="font-mono text-info">IMPLEMENTING</span>, <span className="font-mono text-warning">VERIFYING</span>, first <span className="font-mono text-warning">AI-REVIEW</span> pass of a task, escalation auto-resolver; <span className="font-mono text-info">PUBLISHING</span> only on the conflict resolver (happy path is LLM-free)</li>
          <li><span className="font-mono text-human">human</span> — <span className="font-mono text-warning">NEEDS_REVIEW</span> (plan / deliverable / conflict / empty / verify / question / declined / stuck), <span className="font-mono text-muted">cancel</span></li>
        </ul>
      </div>
      <div>
        <div className="font-medium text-text mb-1">Mode (prompt shaping only)</div>
        <ul className="space-y-0.5">
          <li><span className="font-mono text-primary">dev</span> — modifies code → SOLID / DRY / KISS / YAGNI</li>
          <li><span className="font-mono text-text">non-dev</span> — research, docs, ops → CLEAR + DRY + KISS</li>
          <li>Does not change the path — only how AI is prompted.</li>
        </ul>
      </div>
      <div>
        <div className="font-medium text-text mb-1">Publish policy <span className="font-mono text-text-3">(project, task may override)</span></div>
        <ul className="space-y-0.5">
          <li><span className="font-mono text-text-3">no repo</span> — <span className="font-mono text-info">PUBLISHING</span> copies staged files to <span className="font-mono">folder_path</span>; approve → <span className="font-mono text-success">DONE</span> (or auto-finish straight to <span className="font-mono text-success">DONE</span> when the task is armed + <span className="font-mono">allow_auto_finish</span>). Rejects <span className="font-mono text-primary">mode=dev</span>.</li>
          <li><span className="font-mono">create_pr</span> + <span className="font-mono">push_remote</span> <span className="text-text-3">(auto = from the repo&apos;s remote)</span> — <span className="font-mono text-success">on</span>: open a PR; <span className="font-mono">create_pr off</span>: push the branch with <span className="text-text-3">no PR</span>; <span className="font-mono">push off</span>: local merge only.</li>
          <li><span className="font-mono">merge_to_main</span> — <span className="font-mono text-success">on</span>: approve/auto-finish merges; <span className="font-mono text-muted">off</span>: krill never merges — you merge the PR/branch yourself, approve just marks <span className="font-mono text-success">DONE</span>.</li>
          <li><span className="font-mono">draft_pr</span> — opens a draft; auto-finish suppressed; approve marks ready then squash-merges. <span className="font-mono">delete_branch_on_done</span> — remove the branch when merged.</li>
        </ul>
      </div>
      <div>
        <div className="font-medium text-text mb-1"><span className="font-mono text-warning">NEEDS_REVIEW</span> kinds &amp; CTAs</div>
        <ul className="space-y-0.5">
          <li><span className="font-mono text-warning">plan</span> — entered after <span className="font-mono text-info">PLANNING</span>. Diagram folds it into the <span className="font-mono">PLANNING → IMPLEMENTING</span> arrow. Approve → <span className="font-mono text-info">IMPLEMENTING</span>; decline → back to <span className="font-mono text-info">PLANNING</span>.</li>
          <li><span className="font-mono text-warning">deliverable</span> — entered after a clean PUBLISHING. Approve → <span className="font-mono text-success">DONE</span> (PR squash-merge when has_repo); decline → <span className="font-mono text-info">IMPLEMENTING</span>.</li>
          <li><span className="font-mono text-warning">conflict</span> — has_repo only. Retry PUBLISHING (re-runs the deterministic merge), Solve with Sonnet (shown only when <span className="font-mono">publishing_solve_conflicts=false</span>), or decline → <span className="font-mono text-info">IMPLEMENTING</span>.</li>
          <li><span className="font-mono text-warning">verify</span> — VERIFYING failed past <span className="font-mono">max_ai_decline_cycles</span> (couldn&apos;t prove the change meets <span className="font-mono">acceptance</span>). Back to <span className="font-mono text-info">IMPLEMENTING</span> to redo, or override straight to <span className="font-mono text-info">PUBLISHING</span>.</li>
          <li><span className="font-mono text-warning">declined</span> — <span className="font-mono text-warning">AI-REVIEW</span> rejected the change past the brake. The deliverable EXISTS but was declined (distinct from <span className="font-mono">deliverable</span> = approved-pending-merge). Human redirects to <span className="font-mono text-info">IMPLEMENTING</span> or ships it anyway.</li>
          <li><span className="font-mono text-warning">question</span> — a stage hit a judgment fork. The <span className="font-mono">escalation_auto_resolve</span> Sonnet pass also deferred (or is off, or the task is past its escalation cap), so a human picks from the recorded options; the answer resumes the origin stage.</li>
          <li><span className="font-mono text-warning">empty</span> — IMPLEMENTING produced no commits / nothing to ship. No artifact to approve — re-run <span className="font-mono text-info">IMPLEMENTING</span> or cancel.</li>
          <li><span className="font-mono text-warning">stuck</span> — a stage couldn&apos;t conclude at all: AI-REVIEW reached no verdict after <span className="font-mono">max_ai_decline_cycles</span> runs, or the task sat past 3× <span className="font-mono">max_stage_duration</span> (stuck-scanner force-park). Every task concludes at a human gate — unstick, then move it back to retry.</li>
        </ul>
      </div>
      <div>
        <div className="font-medium text-text mb-1">Skip flags &amp; force</div>
        <ul className="space-y-0.5">
          <li><span className="font-mono text-muted">skip_plan</span> — picker routes <span className="font-mono text-info">TODO</span> straight to <span className="font-mono text-info">IMPLEMENTING</span> (no PLANNING tick; setup runs lazily in IMPLEMENTING). Implies skip_plan_review.</li>
          <li><span className="font-mono text-muted">skip_plan_review</span> — auto-approve plan, no <span className="text-human">human</span> gate. Ignored when skip_plan is on.</li>
          <li><span className="font-mono text-muted">skip_ai_review</span> — <span className="font-mono text-info">IMPLEMENTING</span> skips <span className="font-mono text-warning">AI-REVIEW</span>, into <span className="font-mono text-warning">VERIFYING</span>.</li>
          <li><span className="font-mono text-muted">skip_verify</span> — skip <span className="font-mono text-warning">VERIFYING</span> (don&apos;t run the change); go to <span className="font-mono text-info">PUBLISHING</span>. Default ON for non-dev, OFF for dev. Auto-set on docs-only diffs and by a <span className="font-mono">static_sufficient</span> AI-REVIEW approve (fully-static diff); auto-set never overrides an explicit human choice.</li>
          <li><span className="font-mono text-success">auto_publish</span> — with project <span className="font-mono">allow_auto_finish</span>, <span className="font-mono text-info">PUBLISHING</span> merges straight to <span className="font-mono text-success">DONE</span>, no <span className="text-human">human</span> gate (AI-review still runs). On repos, suppressed when <span className="font-mono">merge_to_main</span> is off, the PR is a draft, or the merge would leave a remote behind; on no-repo projects it always finishes (no merge, so none of those apply).</li>
          <li><span className="font-mono text-warning">max_ai_decline_cycles</span> — after N <span className="text-ai">AI</span> auto-actions without progress (counted per stage), park for a human at the kind that fits: <span className="font-mono text-warning">declined</span> (AI-REVIEW decline), <span className="font-mono text-warning">stuck</span> (AI-REVIEW no-verdict), <span className="font-mono text-warning">verify</span> (VERIFYING), or <span className="font-mono text-warning">conflict</span> (PUBLISHING). Also caps lifetime escalations per task — past it, the auto-resolver is skipped.</li>
        </ul>
      </div>
      <div>
        <div className="font-medium text-text mb-1">Blocked &amp; MCP</div>
        <ul className="space-y-0.5">
          <li><span className="font-mono text-warning">blocked</span> — a stage hit something interactive it can&apos;t answer headless (MCP auth / CLI login). The task pauses (the picker skips it) and a <span className="font-mono">blocker</span> appears in the board banner. Clear it → the next tick re-runs the stage.</li>
          <li><span className="text-ai">MCP</span> — stages load your user MCP servers (e.g. Supabase) alongside krill&apos;s task tools, so a task can make real external changes. <span className="font-mono">KRILL_STRICT_MCP=1</span> isolates to krill&apos;s tools only.</li>
          <li><span className="text-ai">A3 breaker</span> — repeated auto-finish failures pause the project.</li>
          <li><span className="font-mono text-warning">worker dead</span> — a restart orphans in-flight claims; the stuck scanner auto-releases them within a minute (re-picked next tick). <span className="font-mono">Recover</span> stays as the manual override.</li>
        </ul>
      </div>
    </div>
  );
}

export function WorkflowModal() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="default"
          aria-label="Workflow"
          title="Workflow"
          className="w-9 px-0"
        >
          <Workflow className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Workflow"
        description="States, transitions, models, and gating"
        size="large"
        className="!max-w-[calc(100vw-1rem)] md:!max-w-[calc(100vw-20vh)] !w-[calc(100vw-1rem)] md:!w-[calc(100vw-2rem)] !h-[calc(100vh-2rem)] sm:!h-[85vh]"
      >
        <div className="flex-1 min-h-0 flex flex-col gap-3 px-6 py-4">
          <PanZoomCanvas />
          <Legend />
        </div>
      </DialogContent>
    </Dialog>
  );
}
