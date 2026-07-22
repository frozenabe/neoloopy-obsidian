/**
 * Canvas geometry — node boxes, curved-edge construction, decoration anchors,
 * loop-badge placement, and hit-testing. A faithful port of the geometry in
 * `app/lib/painters/graph_painter.dart`: edges are TRUE CIRCULAR arcs through
 * start → apex → end (constant curvature, so dragging an edge out bulges it into
 * a round arc, not a pinched parabola), trimmed to the node rims. Pure module —
 * no `obsidian`, no canvas — so the math is unit-testable.
 */

import { DetectedLoop, VariableFile, VaultLink } from "../engine/types";
import { materialPipeLegId } from "../engine/quantCanvasLoops";
import {
  isCloud,
  isMaterialLink,
  resolveFlowSpec,
  sfdPositionsFor,
} from "../engine/sfd";
import { Bounds, Point } from "./camera";

export type DiagramViewMode = "cld" | "sfd";

/** Loops whose complete representation exists in the requested canvas view. */
export function loopsForMode(
  loops: DetectedLoop[],
  mode: DiagramViewMode,
): DetectedLoop[] {
  return mode === "sfd"
    ? loops.filter((loop) =>
        loop.canvasPath !== undefined &&
        (loop.identityMode === "qualitative" || loop.canvasPath.hasMaterialLeg))
    : loops;
}

/** Keep a selected badge only when that exact loop exists in the next view. */
export function retainedLoopKeyForMode(
  loops: DetectedLoop[],
  selectedKey: string | null,
  mode: DiagramViewMode,
): string | null {
  if (selectedKey === null) return null;
  const selected = loops.find((loop) => loop.key === selectedKey);
  return selected && loopsForMode([selected], mode).length === 1
    ? selected.key
    : null;
}

export interface NodeBox {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  type: string;
}

export interface EdgeRef {
  id: string;
  source: string;
  target: string;
  link: VaultLink;
  /** View-only topology (for example a CLD material projection).
   *  Rendered normally, but never participates in edge hit/edit routing. */
  renderOnly?: boolean;
}

export interface EdgeGeom extends EdgeRef {
  points: Point[]; // trimmed visible polyline (stroke + hit-testing)
  mid: Point;
  midAngle: number;
  delay: Point;
  delayAngle: number;
  nl: Point;
  nlAngle: number;
  arrowTip: Point;
  arrowAngle: number;
}

export interface SfdPipeGeom {
  id: string;
  flowId: string;
  from: string;
  to: string;
  fromPoint: Point;
  valvePoint: Point;
  toPoint: Point;
  fromCloud: Point | null;
  toCloud: Point | null;
  axisAngle: number;
}

/**
 * Node (x,y) is the box center, matching the Dart painter + autoLayout.
 *
 * The app's painter (`NodeBox.sizeFor`) sizes each box to the *measured* label
 * width plus padding — `max(60, textWidth + (flow ? 40 : 36))`, height 40 for a
 * stock else 34. Pass `measure` (a canvas `measureText` at the label font) to
 * match it exactly; without one (tests/headless) fall back to the same
 * character-count estimate `layout.boxSize`/`autoLayout` use, so positions stay
 * deterministic.
 */
export function buildNodeBoxes(
  nodes: VariableFile[],
  measure?: (label: string) => number,
  positions?: Map<string, Point>,
): Map<string, NodeBox> {
  const m = new Map<string, NodeBox>();
  for (const n of nodes) {
    const label = n.label || n.id;
    const h = n.type === "stock" ? 40 : 34;
    const extra = n.type === "flow" ? 40 : 36;
    const textW = measure ? measure(label) : label.length * 7.2;
    const w = Math.max(60, textW + extra);
    const p = positions?.get(n.id) ?? n;
    m.set(n.id, { id: n.id, cx: p.x, cy: p.y, w, h, type: n.type });
  }
  return m;
}

export function collectEdges(nodes: VariableFile[]): EdgeRef[] {
  const out: EdgeRef[] = [];
  for (const n of nodes) {
    for (const l of n.links) {
      out.push({ id: `${n.id}__${l.to}`, source: n.id, target: l.to, link: l });
    }
  }
  return out;
}

export function collectInfoEdges(nodes: VariableFile[], mode: DiagramViewMode): EdgeRef[] {
  if (mode === "cld") return collectEdges(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: EdgeRef[] = [];
  for (const n of nodes) {
    for (const l of n.links) {
      if (isMaterialLink(n, l, byId)) continue;
      out.push({ id: `${n.id}__${l.to}`, source: n.id, target: l.to, link: l });
    }
  }
  return out;
}

/**
 * Minimum non-persistent causal projections needed to close fully resolved
 * quantitative loops in CLD notation. A matching declared connector is already
 * present in `collectEdges`; only legs whose resolver assigned a synthetic
 * `cldEdgeId` are emitted here. These refs are `renderOnly`, so they cannot be
 * selected, bowed, deleted, or serialized as authored causal links.
 */
export function collectCldMaterialProjectionEdges(
  nodes: VariableFile[],
  loops: DetectedLoop[],
): EdgeRef[] {
  const persistedIds = new Set(collectEdges(nodes).map((edge) => edge.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const emitted = new Set<string>();
  const out: EdgeRef[] = [];
  for (const loop of loops) {
    for (const leg of loop.canvasPath?.legs ?? []) {
      if (leg.kind !== "material") continue;
      if (persistedIds.has(leg.cldEdgeId) || !emitted.add(leg.cldEdgeId)) continue;
      if (!byId.has(leg.flowId) || !byId.has(leg.stockId)) continue;
      out.push({
        id: leg.cldEdgeId,
        source: leg.flowId,
        target: leg.stockId,
        link: {
          to: leg.stockId,
          polarity: leg.polarity < 0 ? "-" : "+",
          delay: false,
          indirect: false,
          nonlinear: false,
        },
        renderOnly: true,
      });
    }
  }
  return out;
}

export function sfdRenderPositions(nodes: VariableFile[]): Map<string, Point> {
  return sfdPositionsFor(nodes);
}

export function buildSfdPipeGeoms(nodes: VariableFile[], boxes: Map<string, NodeBox>): SfdPipeGeom[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: SfdPipeGeom[] = [];
  for (const flow of nodes) {
    if (flow.type !== "flow") continue;
    const spec = resolveFlowSpec(flow, byId);
    if (!spec) continue;
    const valveBox = boxes.get(flow.id);
    if (!valveBox) continue;
    const valvePoint = { x: valveBox.cx, y: valveBox.cy };
    const fromStock = !isCloud(spec.from) && byId.get(spec.from)?.type === "stock" ? boxes.get(spec.from) : undefined;
    const toStock = !isCloud(spec.to) && byId.get(spec.to)?.type === "stock" ? boxes.get(spec.to) : undefined;
    const fromReal = fromStock ? { x: fromStock.cx, y: fromStock.cy } : null;
    const toReal = toStock ? { x: toStock.cx, y: toStock.cy } : null;
    const fromCloud = fromStock ? null : awayCloud(valvePoint, toReal, -1);
    const toCloud = toStock ? null : awayCloud(valvePoint, fromReal, 1);
    const fromPoint = fromStock ? rimPoint(fromStock, valvePoint) : fromCloud as Point;
    const toPoint = toStock ? rimPoint(toStock, valvePoint) : toCloud as Point;
    out.push({
      id: `pipe__${flow.id}`,
      flowId: flow.id,
      from: spec.from,
      to: spec.to,
      fromPoint,
      valvePoint,
      toPoint,
      fromCloud,
      toCloud,
      axisAngle: Math.atan2(toPoint.y - fromPoint.y, toPoint.x - fromPoint.x),
    });
  }
  return out;
}

function awayCloud(flow: Point, other: Point | null, sign: number): Point {
  if (other) {
    const dx = flow.x - other.x;
    const dy = flow.y - other.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: flow.x + (dx / len) * 80, y: flow.y + (dy / len) * 80 };
  }
  return { x: flow.x + sign * 80, y: flow.y };
}

/**
 * @param bowCache Per-edge frozen bow signs (keyed by edge id). Lone edges pick
 *   a bow side from the graph centroid **once** and reuse it; without this, a
 *   node drag moves the centroid and can flip an unrelated edge to the far side.
 *   Pass a stable Map (cleared per model) to get app-faithful, jitter-free arcs.
 */
export function buildEdgeGeoms(
  edges: EdgeRef[],
  boxes: Map<string, NodeBox>,
  bowCache?: Map<string, number>,
): EdgeGeom[] {
  const present = edges.filter(
    (e) => boxes.has(e.source) && boxes.has(e.target),
  );
  const dirSet = new Set(present.map((e) => `${e.source}>${e.target}`));
  const explicitBowSigns = new Map<string, number>();
  for (const edge of present) {
    const curvature = edge.link.curvature;
    if (curvature === undefined || !Number.isFinite(curvature) || curvature === 0) continue;
    const key = `${edge.source}>${edge.target}`;
    const sign = Math.sign(curvature);
    const previous = explicitBowSigns.get(key);
    // Duplicate authored connectors with conflicting bows do not select the
    // automatic reciprocal's side. The normal default remains deterministic.
    explicitBowSigns.set(key, previous === undefined || previous === sign ? sign : 0);
  }
  const centroid = centroidOf(boxes);
  return present.map((e) => geomFor(
    e,
    boxes,
    dirSet,
    centroid,
    bowCache,
    explicitBowSigns.get(`${e.target}>${e.source}`),
  ));
}

function centroidOf(boxes: Map<string, NodeBox>): Point {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const b of boxes.values()) {
    sx += b.cx;
    sy += b.cy;
    n++;
  }
  return n === 0 ? { x: 0, y: 0 } : { x: sx / n, y: sy / n };
}

function geomFor(
  e: EdgeRef,
  boxes: Map<string, NodeBox>,
  dirSet: Set<string>,
  centroid: Point,
  bowCache?: Map<string, number>,
  reverseExplicitBowSign?: number,
): EdgeGeom {
  const a = boxes.get(e.source) as NodeBox;
  const b = boxes.get(e.target) as NodeBox;
  if (e.source === e.target) return selfLoop(e, a);

  const S: Point = { x: a.cx, y: a.cy };
  const E: Point = { x: b.cx, y: b.cy };
  const dx = E.x - S.x;
  const dy = E.y - S.y;
  const len = Math.hypot(dx, dy) || 1;
  const mx = (S.x + E.x) / 2;
  const my = (S.y + E.y) / 2;
  const nx = -dy / len; // perpendicular unit
  const ny = dx / len;
  const mag = len * 0.18 + 18;

  let bow: number;
  if (e.link.curvature !== undefined) {
    // User-set curve: curvature is the signed apex offset from the chord
    // midpoint along the perpendicular (set by dragging the edge).
    bow = e.link.curvature;
  } else if (dirSet.has(`${e.target}>${e.source}`)) {
    // Reciprocal pair: matching signed bows split across the opposite chord
    // normals. When the reverse connector was hand-bowed, mirror its sign so
    // this automatic connector cannot collapse onto the authored curve.
    bow = mag * (reverseExplicitBowSign === -1 ? -1 : 1);
  } else {
    // Lone edge — bow away from the graph centroid so loops read as circles,
    // but FREEZE the chosen side per edge: a later node drag shifts the centroid
    // and would otherwise flip an unrelated edge to the other side mid-drag.
    let sign = bowCache?.get(e.id);
    if (sign === undefined) {
      const ox = mx - centroid.x;
      const oy = my - centroid.y;
      sign = nx * ox + ny * oy >= 0 ? 1 : -1;
      bowCache?.set(e.id, sign);
    }
    bow = mag * sign;
  }
  // Apex = the chord midpoint pushed out by the signed bow. The visible edge is
  // a TRUE CIRCULAR arc through start → apex → end (round, constant-curvature),
  // matching the app's `_circleCenter` arc — so dragging an edge out bulges it
  // into a circle, not a pinched parabola. Endpoints trim to each node's rim
  // (aimed at the apex); falls back to a straight chord when nearly collinear.
  const apex: Point = { x: mx + nx * bow, y: my + ny * bow };
  const start = rimPoint(a, apex);
  const end = rimPoint(b, apex);
  const center = circleCenter(start, apex, end);
  let points: Point[];
  if (!center) {
    points = [start, end];
  } else {
    const r = Math.hypot(start.x - center.x, start.y - center.y);
    const a0 = Math.atan2(start.y - center.y, start.x - center.x);
    const a1 = Math.atan2(end.y - center.y, end.x - center.x);
    const am = Math.atan2(apex.y - center.y, apex.x - center.x);
    const toEnd = norm2pi(a1 - a0);
    const toMid = norm2pi(am - a0);
    // sweep in the direction that passes through the apex
    const sweep = toMid < toEnd ? toEnd : toEnd - 2 * Math.PI;
    const N = 24;
    points = [];
    for (let i = 0; i <= N; i++) {
      const ang = a0 + sweep * (i / N);
      points.push({ x: center.x + r * Math.cos(ang), y: center.y + r * Math.sin(ang) });
    }
  }
  return decorate(e, points);
}

/** Circumcircle center of three points; null when (nearly) collinear. */
function circleCenter(a: Point, b: Point, c: Point): Point | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
}

/** March from a box center toward `toward` until just outside the rim. */
function rimPoint(box: NodeBox, toward: Point): Point {
  const c0: Point = { x: box.cx, y: box.cy };
  const dx = toward.x - c0.x;
  const dy = toward.y - c0.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return c0;
  const sx = dx / dist;
  const sy = dy / dist;
  for (let d = 0; d < dist; d += 1.5) {
    const p = { x: c0.x + sx * d, y: c0.y + sy * d };
    if (!inBox(p, box, 0)) return p;
  }
  return c0;
}

/** Wrap an angle into [0, 2π). */
function norm2pi(x: number): number {
  let v = x;
  while (v < 0) v += 2 * Math.PI;
  while (v >= 2 * Math.PI) v -= 2 * Math.PI;
  return v;
}

function selfLoop(e: EdgeRef, a: NodeBox): EdgeGeom {
  const r = Math.max(a.w, a.h) / 2 + 16;
  const cx = a.cx;
  const cy = a.cy - a.h / 2 - r;
  const N = 40;
  const points: Point[] = [];
  for (let i = 0; i <= N; i++) {
    const ang = -Math.PI * 0.85 + Math.PI * 1.7 * (i / N);
    points.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
  }
  return decorate(e, points);
}

function decorate(e: EdgeRef, points: Point[]): EdgeGeom {
  const pts = points.length >= 2 ? points : [points[0] ?? { x: 0, y: 0 }, points[0] ?? { x: 0, y: 0 }];
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const mid = atFraction(pts, 0.5);
  const delay = atFraction(pts, 0.34);
  const nl = atFraction(pts, 0.66);
  return {
    ...e,
    points: pts,
    mid: mid.point,
    midAngle: mid.angle,
    delay: delay.point,
    delayAngle: delay.angle,
    nl: nl.point,
    nlAngle: nl.angle,
    arrowTip: last,
    arrowAngle: Math.atan2(last.y - prev.y, last.x - prev.x),
  };
}

/** Point + tangent angle at fraction `f` of a polyline's arc length. */
function atFraction(pts: Point[], f: number): { point: Point; angle: number } {
  if (pts.length < 2) return { point: pts[0] ?? { x: 0, y: 0 }, angle: 0 };
  let total = 0;
  const seg: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(d);
    total += d;
  }
  let target = f * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const r = seg[i] === 0 ? 0 : target / seg[i];
      return {
        point: { x: a.x + (b.x - a.x) * r, y: a.y + (b.y - a.y) * r },
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
    target -= seg[i];
  }
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  return { point: b, angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

function inBox(p: Point, box: NodeBox, pad: number): boolean {
  return (
    Math.abs(p.x - box.cx) <= box.w / 2 + pad &&
    Math.abs(p.y - box.cy) <= box.h / 2 + pad
  );
}

// ---- loop badges -----------------------------------------------------------

/**
 * Loop-badge centers — centroid of member nodes, then light overlap spread.
 * `overrides` (loop.key → world point) pins badges the user has dragged: a pinned
 * badge sits exactly where it was dropped and does not move during relaxation;
 * unpinned badges relax around it. Mirrors the app's `loopBadgeOverrides`
 * (session-only, keyed by loop key — not persisted to the vault).
 */
export function computeBadges(
  loops: DetectedLoop[],
  boxes: Map<string, NodeBox>,
  overrides?: Map<string, Point>,
): Map<string, Point> {
  const pos = new Map<string, Point>();
  const pinned = new Set<string>();
  for (const lp of loops) {
    const ov = overrides?.get(lp.key);
    if (ov) {
      pos.set(lp.key, { x: ov.x, y: ov.y });
      pinned.add(lp.key);
      continue;
    }
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (const id of new Set(lp.nodeIds)) {
      const b = boxes.get(id);
      if (b) {
        sx += b.cx;
        sy += b.cy;
        c++;
      }
    }
    if (c > 0) pos.set(lp.key, { x: sx / c, y: sy / c });
  }
  const keys = [...pos.keys()];
  const MIN = 44;
  for (let iter = 0; iter < 50; iter++) {
    let moved = false;
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const pPin = pinned.has(keys[i]);
        const qPin = pinned.has(keys[j]);
        if (pPin && qPin) continue; // both dropped by hand — leave them
        const p = pos.get(keys[i]) as Point;
        const q = pos.get(keys[j]) as Point;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d < MIN && d > 0.001) {
          const ux = dx / d;
          const uy = dy / d;
          // A pinned badge holds; its partner takes the whole push.
          const pushP = pPin ? 0 : qPin ? MIN - d : (MIN - d) / 2;
          const pushQ = qPin ? 0 : pPin ? MIN - d : (MIN - d) / 2;
          p.x -= ux * pushP;
          p.y -= uy * pushP;
          q.x += ux * pushQ;
          q.y += uy * pushQ;
          moved = true;
        } else if (d <= 0.001) {
          if (!qPin) {
            q.x += MIN / 2;
            moved = true;
          } else if (!pPin) {
            p.x -= MIN / 2;
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
  return pos;
}

/**
 * Directed edge ids (`source__target`, matching `collectEdges`) that close a
 * detected loop's cycle. `nodeIds` is the open path, so the last node wraps back
 * to the first. Used to highlight the loop when its badge is selected.
 */
export function loopEdgeIds(loop: DetectedLoop): Set<string> {
  if (loop.canvasPath) {
    return new Set(loop.canvasPath.legs.map((leg) =>
      leg.kind === "causal" ? leg.edgeId : leg.cldEdgeId,
    ));
  }
  const ids = loop.nodeIds;
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    out.add(`${ids[i]}__${ids[(i + 1) % ids.length]}`);
  }
  return out;
}

/** Exact material pipe legs (`flowId` + `stockId`) belonging to a resolved loop. */
export function loopPipeLegIds(loop: DetectedLoop): Set<string> {
  if (!loop.canvasPath) return new Set();
  return new Set(
    loop.canvasPath.legs
      .filter((leg) => leg.kind === "material")
      .map((leg) => materialPipeLegId(leg.flowId, leg.stockId)),
  );
}

// ---- hit testing -----------------------------------------------------------

export function hitNode(boxes: Map<string, NodeBox>, p: Point): string | null {
  const arr = [...boxes.values()];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (inBox(p, arr[i], 4)) return arr[i].id;
  }
  return null;
}

export function hitEdge(
  geoms: EdgeGeom[],
  p: Point,
  scale: number,
): string | null {
  const tol = 14 / scale;
  let best: string | null = null;
  let bestD = tol;
  for (const g of geoms) {
    if (g.renderOnly) continue;
    for (let i = 0; i + 1 < g.points.length; i++) {
      const d = distToSegment(p, g.points[i], g.points[i + 1]);
      if (d < bestD) {
        bestD = d;
        best = g.id;
      }
    }
  }
  return best;
}

/**
 * Generous grab zone for an already-selected edge, mirroring the native app's
 * `_nearSelectedEdge`: within 26/scale of the midpoint handle, OR within
 * 22/scale of the curve. Bowing uses this (not the tight 14/scale `hitEdge`
 * select zone) so "select then drag to bow" is reliable instead of needing a
 * pixel-perfect second press on the line.
 */
export function nearSelectedEdge(g: EdgeGeom, p: Point, scale: number): boolean {
  if (g.renderOnly) return false;
  if (Math.hypot(g.mid.x - p.x, g.mid.y - p.y) < 26 / scale) return true;
  let best = Infinity;
  for (let i = 0; i + 1 < g.points.length; i++) {
    const d = distToSegment(p, g.points[i], g.points[i + 1]);
    if (d < best) best = d;
  }
  return best < 22 / scale;
}

export function hitBadge(
  badges: Map<string, Point>,
  p: Point,
  scale: number,
): string | null {
  const tol = 22 / scale;
  let best: string | null = null;
  let bestD = tol;
  for (const [key, c] of badges) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = key;
    }
  }
  return best;
}

/** True if `p` is in the connect-ring band just outside a node's rim. */
export function inConnectBand(
  box: NodeBox,
  p: Point,
  tol: number,
  gap = 20,
): boolean {
  return inBox(p, box, gap + tol) && !inBox(p, box, 0);
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function nodeBounds(boxes: Map<string, NodeBox>): Bounds {
  if (boxes.size === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes.values()) {
    minX = Math.min(minX, b.cx - b.w / 2);
    minY = Math.min(minY, b.cy - b.h / 2);
    maxX = Math.max(maxX, b.cx + b.w / 2);
    maxY = Math.max(maxY, b.cy + b.h / 2);
  }
  return { minX, minY, maxX, maxY };
}

export function sceneBounds(boxes: Map<string, NodeBox>, pipes: SfdPipeGeom[] = []): Bounds {
  const bb = nodeBounds(boxes);
  let { minX, minY, maxX, maxY } = bb;
  for (const pipe of pipes) {
    for (const p of [
      pipe.fromPoint,
      pipe.valvePoint,
      pipe.toPoint,
      pipe.fromCloud,
      pipe.toCloud,
    ]) {
      if (!p) continue;
      minX = Math.min(minX, p.x - 24);
      minY = Math.min(minY, p.y - 18);
      maxX = Math.max(maxX, p.x + 24);
      maxY = Math.max(maxY, p.y + 18);
    }
  }
  return { minX, minY, maxX, maxY };
}
