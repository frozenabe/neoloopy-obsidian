/**
 * SceneCache — builds the renderable `Scene` (node boxes, curved edges, loop
 * badges) from a `GraphView`, and caches the heavy parts:
 *
 *  - **Label-width memo:** each distinct label is measured once (via the canvas
 *    `measureText`), not per node per rebuild.
 *  - **Dirty-tracking:** a rebuild is skipped — the previous `Scene` object is
 *    returned by reference — when no geometric input changed (graph identity,
 *    node positions/labels/types, link curvature, bow signs, badge overrides).
 *    Idle renders and live-edit reloads stop rebuilding geometry needlessly; a
 *    drag still rebuilds because the moved node changes the signature.
 *
 * Pure of canvas-view state: it owns only its measure context and memo, and is
 * handed the graph + interaction caches to build from.
 */

import { Camera, Point } from "./camera";
import {
  DiagramViewMode,
  buildEdgeGeoms,
  buildNodeBoxes,
  buildSfdPipeGeoms,
  collectCldMaterialProjectionEdges,
  collectInfoEdges,
  computeBadges,
  loopsForMode,
  sceneBounds,
  sfdRenderPositions,
} from "./geometry";
import { GraphView } from "../engine/engine";
import { Scene, LABEL_FONT, LABEL_TRACKING } from "./painter";

/** Measure a label's pixel width at the canvas label font. */
export type LabelMeasurer = (label: string) => number;

/**
 * A canvas-backed label measurer matching the painter font (and the app's
 * `NodeBox.sizeFor`). Falls back to the character-count estimate that
 * `buildNodeBoxes` uses when there's no canvas (tests/headless), so box sizing
 * stays deterministic either way.
 */
export function canvasLabelMeasurer(): LabelMeasurer {
  const ctx =
    typeof activeDocument !== "undefined"
      ? activeDocument.createElement("canvas").getContext("2d")
      : null;
  if (!ctx) return (label) => label.length * 7.2;
  return (label) => {
    ctx.font = "600 13px " + LABEL_FONT;
    (ctx as unknown as { letterSpacing: string }).letterSpacing = LABEL_TRACKING;
    return ctx.measureText(label).width;
  };
}

export class SceneCache {
  private readonly rawMeasure: LabelMeasurer;
  private readonly widthMemo = new Map<string, number>();

  private scene: Scene | null = null;
  private lastGraph: GraphView | null = null;
  private lastSig: string | null = null;

  constructor(rawMeasure: LabelMeasurer = canvasLabelMeasurer()) {
    this.rawMeasure = rawMeasure;
  }

  /** Measure a label width, memoized so each distinct label costs one measure. */
  private measure(label: string): number {
    let w = this.widthMemo.get(label);
    if (w === undefined) {
      w = this.rawMeasure(label);
      this.widthMemo.set(label, w);
    }
    return w;
  }

  /** Drop the label-width memo — call if the measure font/context ever changes. */
  invalidateMeasurements(): void {
    this.widthMemo.clear();
  }

  /** Force the next `build` to recompute even if the signature is unchanged. */
  invalidate(): void {
    this.lastGraph = null;
    this.lastSig = null;
  }

  /**
   * Build (or reuse) the `Scene` for `graph`. Returns the previous `Scene` by
   * reference when no geometric input moved; otherwise recomputes boxes, edges,
   * and badges. Returns `null` for a null graph.
   */
  build(
    graph: GraphView | null,
    bowSigns: Map<string, number>,
    badgeOverrides: Map<string, Point>,
    mode: DiagramViewMode = "cld",
  ): Scene | null {
    if (!graph) {
      this.scene = null;
      this.lastGraph = null;
      this.lastSig = null;
      return null;
    }
    const sig = this.signature(graph, bowSigns, badgeOverrides, mode);
    if (this.scene && graph === this.lastGraph && sig === this.lastSig) return this.scene;

    const boxes = buildNodeBoxes(
      graph.nodes,
      (s) => this.measure(s),
      mode === "sfd" ? sfdRenderPositions(graph.nodes) : undefined,
    );
    const edgeRefs = collectInfoEdges(graph.nodes, mode);
    if (mode === "cld") {
      edgeRefs.push(...collectCldMaterialProjectionEdges(graph.nodes, graph.loops));
    }
    const edges = buildEdgeGeoms(edgeRefs, boxes, bowSigns);
    const pipes = mode === "sfd" ? buildSfdPipeGeoms(graph.nodes, boxes) : [];
    const loops = loopsForMode(graph.loops, mode);
    const badges = computeBadges(loops, boxes, badgeOverrides);
    this.scene = {
      mode,
      nodes: graph.nodes,
      boxes,
      edges,
      pipes,
      loops,
      labels: graph.labels,
      badges,
    };
    this.lastGraph = graph;
    // `buildEdgeGeoms` freezes a bow sign for each previously-unseen edge *into*
    // `bowSigns`, which feeds the signature — so the pre-build `sig` is already
    // stale. Record the post-build signature instead, or the next unchanged call
    // would needlessly rebuild once before the cache settles.
    this.lastSig = this.signature(graph, bowSigns, badgeOverrides, mode);
    return this.scene;
  }

  /**
   * Fit `camera` to the current scene's node bounds. No-op (returns `false`)
   * when there's no scene, no nodes, or a zero-sized viewport — the caller keeps
   * the "fit only once" policy via its own camera-memory flag.
   */
  fit(camera: Camera, width: number, height: number): boolean {
    if (!this.scene || this.scene.boxes.size === 0) return false;
    if (width === 0 || height === 0) return false;
    camera.fit(sceneBounds(this.scene.boxes, this.scene.pipes), width, height);
    return true;
  }

  /**
   * A cheap signature of every input that changes box/edge/badge geometry:
   * node id·position·type·label and each outgoing link's target·curvature (a bow
   * drag mutates curvature in place), plus the frozen bow signs and the
   * session-only badge overrides. Link polarity/flags don't affect geometry and
   * arrive via a fresh graph (caught by the identity check), so they're omitted.
   */
  private signature(
    graph: GraphView,
    bowSigns: Map<string, number>,
    badgeOverrides: Map<string, Point>,
    mode: DiagramViewMode,
  ): string {
    const parts: string[] = [mode];
    for (const n of graph.nodes) {
      const sfd = n.extra["sfd"];
      const sfdSig =
        sfd && typeof sfd === "object" && !Array.isArray(sfd)
          ? `${String((sfd as Record<string, unknown>)["x"] ?? "")},${String((sfd as Record<string, unknown>)["y"] ?? "")}`
          : "";
      const flow = n.extra["flow"];
      const flowSig =
        flow && typeof flow === "object" && !Array.isArray(flow)
          ? `${String((flow as Record<string, unknown>)["from"] ?? "")}->${String((flow as Record<string, unknown>)["to"] ?? "")}`
          : "";
      parts.push(`${n.id}:${n.x}:${n.y}:${sfdSig}:${n.type}:${n.label}:${flowSig}`);
      for (const l of n.links) parts.push(`>${l.to}:${l.curvature ?? ""}`);
    }
    parts.push("|");
    for (const [k, v] of bowSigns) parts.push(`${k}=${v}`);
    parts.push("|");
    for (const [k, p] of badgeOverrides) parts.push(`${k}=${p.x},${p.y}`);
    parts.push("|");
    for (const l of graph.loops) {
      parts.push(l.key);
      for (const leg of l.canvasPath?.legs ?? []) {
        parts.push(
          leg.kind === "causal"
            ? `c:${leg.edgeId}`
            : `m:${leg.flowId}>${leg.stockId}:${leg.cldEdgeId}:${leg.polarity}`,
        );
      }
    }
    return parts.join(";");
  }
}
