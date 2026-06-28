/**
 * Canvas painter — renders a prepared scene (node boxes, curved edges, loop
 * badges) with the app's visual language ported from
 * `app/lib/painters/graph_painter.dart`. Pure: takes a 2D context + scene +
 * camera + theme + interaction state and draws. Deferred flourishes (valence/CLA
 * marks) are tracked in Status.md; the core CLD reading — node types, arc edges
 * with polarity chips, R/B badges, the subsystem-link corner mark, and selection
 * + live-edit highlight — is here. Per-node
 * quantitative detail lives in the ƒx node-menu modal, not on the canvas.
 */

import { Camera, Point } from "./camera";
import { Theme, groupSwatch, swatchBorder, swatchFill, swatchInk, withAlpha } from "./theme";
import { EdgeGeom, NodeBox } from "./geometry";
import { DetectedLoop, LoopType, VariableFile } from "../engine/types";

export interface Scene {
  nodes: VariableFile[];
  boxes: Map<string, NodeBox>;
  edges: EdgeGeom[];
  loops: DetectedLoop[];
  labels: Map<string, string>;
  badges: Map<string, Point>;
}

/** A selected loop's members, so the painter can spotlight just that cycle. */
export interface LoopHighlight {
  edgeIds: Set<string>;
  nodeIds: Set<string>;
  type: LoopType;
}

export interface PaintUi {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectedLoopKey: string | null;
  liveNodeIds: Set<string>;
  /** Live link being drawn: from node id to a world point. */
  linkPreview: { from: string; to: Point } | null;
  /** Node whose connect-ring is currently armed/hovered. */
  connectNodeId: string | null;
  /** Edges/nodes of the selected loop; non-members dim. Null = no spotlight. */
  loopHighlight: LoopHighlight | null;
  /** 0..1 pulse clock for the selected node's halo (0 = static). */
  pulsePhase: number;
  /** 0..1 marching-ants clock tracing highlighted loop edges. */
  flowPhase: number;
}

const EDGE_WIDTH = [1.6, 2.5, 3.4];

/**
 * Canvas label font. The desktop app renders its canvas text in Helvetica Neue
 * (`ThemeData.fontFamily` in `app/lib/main.dart`) at weight 600. A
 * `var(--font-interface)` inside a canvas `font` string is NOT resolved by the
 * 2D context — the weight silently falls back to 400 and the family to the
 * system UI font — so the family and weight are spelled out concretely here to
 * match the app pixel-for-pixel. The monospace badge font mirrors Dart's
 * generic `'monospace'`.
 */
export const LABEL_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const MONO_FONT = "monospace";
/** Matches the app's `letterSpacing: -0.1` on every canvas label. */
export const LABEL_TRACKING = "-0.1px";

/** Set canvas letter-spacing without depending on it being in the DOM lib. */
function setLetterSpacing(ctx: CanvasRenderingContext2D, v: string): void {
  (ctx as unknown as { letterSpacing: string }).letterSpacing = v;
}

export function paint(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  camera: Camera,
  theme: Theme,
  ui: PaintUi,
): void {
  ctx.setTransform(ui.dpr, 0, 0, ui.dpr, 0, 0);
  ctx.fillStyle = theme.paper;
  ctx.fillRect(0, 0, ui.cssWidth, ui.cssHeight);
  drawGrid(ctx, camera, theme, ui);

  ctx.translate(camera.tx, camera.ty);
  ctx.scale(camera.scale, camera.scale);

  const hl = ui.loopHighlight;
  for (const g of scene.edges) {
    drawEdge(ctx, g, theme, g.id === ui.selectedEdgeId, hl, ui.flowPhase);
  }
  for (const n of scene.nodes) {
    const box = scene.boxes.get(n.id);
    if (box) {
      drawNode(
        ctx,
        box,
        n,
        theme,
        n.id === ui.selectedNodeId,
        ui.liveNodeIds.has(n.id),
        hl ? !hl.nodeIds.has(n.id) : false,
        n.id === ui.selectedNodeId ? ui.pulsePhase : 0,
      );
    }
  }
  for (const lp of scene.loops) {
    const c = scene.badges.get(lp.key);
    if (c) {
      drawBadge(
        ctx,
        c,
        scene.labels.get(lp.key) ?? "",
        lp.type,
        theme,
        lp.key === ui.selectedLoopKey,
        loopClockwise(lp.nodeIds, scene.boxes),
      );
    }
  }
  if (ui.linkPreview) {
    const box = scene.boxes.get(ui.linkPreview.from);
    if (box) drawLinkPreview(ctx, { x: box.cx, y: box.cy }, ui.linkPreview.to, theme);
  }
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  theme: Theme,
  ui: PaintUi,
): void {
  if (camera.scale < 0.25) return;
  const step = 32;
  const tl = camera.toWorld(0, 0);
  const br = camera.toWorld(ui.cssWidth, ui.cssHeight);
  const x0 = Math.floor(tl.x / step) * step;
  const y0 = Math.floor(tl.y / step) * step;
  ctx.fillStyle = withAlpha(theme.line, theme.dark ? 0.6 : 0.9);
  for (let wx = x0; wx <= br.x; wx += step) {
    for (let wy = y0; wy <= br.y; wy += step) {
      const p = camera.toScreen(wx, wy);
      ctx.fillRect(p.x, p.y, 1, 1);
    }
  }
}

/** Append a rounded-rect sub-path to the current path (no beginPath). */
function roundRectInto(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  roundRectInto(ctx, x, y, w, h, r);
}

function circle(ctx: CanvasRenderingContext2D, c: Point, r: number): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  box: NodeBox,
  node: VariableFile,
  theme: Theme,
  selected: boolean,
  live: boolean,
  dim: boolean,
  pulse: number,
): void {
  const x = box.cx - box.w / 2;
  const y = box.cy - box.h / 2;
  const r = box.type === "stock" ? 5 : box.h / 2;

  ctx.save();
  if (dim) ctx.globalAlpha = 0.18;

  if (selected) {
    // Soft teal shade radiating from the rim — the app's `Motion.selectPulse`:
    // a blurred ring (inflated stadium minus the node body) that swells and
    // fades, drawn instead of any hard outline. Ported from the Dart
    // MaskFilter.blur shade, so under reduced motion (pulse=0) it rests as a
    // quiet glow hugging the node.
    const grow = 6 + 26 * pulse;
    ctx.save();
    ctx.filter = "blur(5px)";
    ctx.beginPath();
    roundRectInto(ctx, x - grow, y - grow, box.w + grow * 2, box.h + grow * 2, (box.h + grow * 2) / 2);
    roundRectInto(ctx, x, y, box.w, box.h, r);
    ctx.fillStyle = withAlpha(theme.teal, 0.26 * (1 - pulse));
    ctx.fill("evenodd");
    ctx.restore();
  }

  if (live) {
    roundRect(ctx, x - 11, y - 11, box.w + 22, box.h + 22, 22);
    ctx.fillStyle = withAlpha(theme.live, 0.12);
    ctx.fill();
    roundRect(ctx, x - 6, y - 6, box.w + 12, box.h + 12, 18);
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.live;
    ctx.stroke();
  }
  if (selected) {
    // Thin steady ring at the connect radius marks the drag-to-link boundary
    // (a solid hairline in the app, not a dashed ring).
    const gap = 20;
    roundRect(ctx, x - gap, y - gap, box.w + gap * 2, box.h + gap * 2, (box.h + gap * 2) / 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(theme.teal, 0.55);
    ctx.stroke();
  }

  // Optional group tint: soft fill + ink + border, dodging the reserved R/B/live
  // hues. Selection / live / loop colors render around it and still win. Ported
  // from the app's `_paintNode` (stock keeps its graphite border regardless).
  const swatch = groupSwatch(node.group);
  roundRect(ctx, x, y, box.w, box.h, r);
  ctx.fillStyle = swatch ? swatchFill(swatch, theme.dark) : theme.surface;
  ctx.fill();
  ctx.lineWidth = box.type === "stock" ? 1.6 : 1.3;
  ctx.strokeStyle =
    swatch && box.type !== "stock"
      ? swatchBorder(swatch, theme.dark)
      : box.type === "stock"
        ? theme.graphite
        : theme.line2;
  ctx.stroke();

  if (box.type === "stock") {
    ctx.strokeStyle = theme.graphite;
    ctx.lineWidth = 2.4;
    for (const bx of [x + 1, x + box.w - 1]) {
      ctx.beginPath();
      ctx.moveTo(bx, y + 6);
      ctx.lineTo(bx, y + box.h - 6);
      ctx.stroke();
    }
  } else if (box.type === "flow") {
    drawValve(ctx, x + 13, box.cy, theme);
  }

  ctx.fillStyle = swatch ? swatchInk(swatch, theme.dark) : theme.ink;
  ctx.font = "600 13px " + LABEL_FONT;
  setLetterSpacing(ctx, LABEL_TRACKING);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const labelX = box.cx + (box.type === "flow" ? 8 : 0);
  const maxW = box.w - (box.type === "flow" ? 26 : 14);
  ctx.fillText(fitText(ctx, node.label, maxW), labelX, box.cy);

  // Top-LEFT corner badge when the node drills into a child model (`subsystem`
  // link set). Empty string is falsy in JS, so this mirrors Dart's
  // `subsystem != null && subsystem.isNotEmpty`.
  if (node.subsystem) drawSubsystemMark(ctx, x + 10, y + 10, theme);

  ctx.restore();
}

/**
 * Stacked-sheets "layers" glyph marking that a node has a connected subsystem,
 * in subtle theme ink (`ink2`) so it reads as "open me" while staying distinct
 * from selection teal and loop R/B hues. Mirrors `_paintSubsystemMark` (which
 * paints Material `Icons.layers`) in `app/lib/painters/graph_painter.dart`;
 * hand-drawn here because a canvas 2D context can't resolve the Material icon
 * font. Centered on (cx, cy) within a ~16px box, matching the app's
 * `rect.left + 10, rect.top + 10` placement.
 */
function drawSubsystemMark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  theme: Theme,
): void {
  ctx.strokeStyle = theme.ink2;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // Front sheet: a rhombus filling the upper half of the icon box.
  ctx.beginPath();
  ctx.moveTo(cx, cy - 7);
  ctx.lineTo(cx + 7, cy - 2.5);
  ctx.lineTo(cx, cy + 2);
  ctx.lineTo(cx - 7, cy - 2.5);
  ctx.closePath();
  ctx.stroke();
  // Back sheet: a chevron peeking out beneath the front rhombus.
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy + 0.5);
  ctx.lineTo(cx, cy + 5);
  ctx.lineTo(cx + 7, cy + 0.5);
  ctx.stroke();
}

function drawValve(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  theme: Theme,
): void {
  // Stock-and-flow valve: two triangles meeting tip-to-tip as a vertical
  // hourglass (⧗) — bases horizontal at top and bottom, apexes pinching at the
  // center so the horizontal flow line threads the waist. Each sub-path must be
  // closed so its outer base edge is drawn — otherwise the four spokes read as
  // an ✕, not a valve (matches the Dart painter).
  ctx.strokeStyle = theme.graphite;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy - 6);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx + 6, cy - 6);
  ctx.closePath();
  ctx.moveTo(cx - 6, cy + 6);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx + 6, cy + 6);
  ctx.closePath();
  ctx.stroke();
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  g: EdgeGeom,
  theme: Theme,
  selected: boolean,
  hl: LoopHighlight | null,
  flowPhase: number,
): void {
  const inLoop = hl ? hl.edgeIds.has(g.id) : false;
  const dim = hl ? !inLoop : false;
  const loopColor = inLoop ? (hl?.type === LoopType.reinforcing ? theme.teal : theme.amber) : null;

  ctx.save();
  if (dim) ctx.globalAlpha = 0.16;

  const w = EDGE_WIDTH[Math.max(0, Math.min(2, g.link.weight ?? 0))];
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Soft glow: a wide, faint band under a highlighted loop's edges (loop hue)
  // or a selected edge (teal), so the active line pops off the canvas.
  if (loopColor) {
    tracePath(ctx, g.points);
    ctx.lineWidth = 9;
    ctx.strokeStyle = withAlpha(loopColor, 0.22);
    ctx.stroke();
  } else if (selected) {
    tracePath(ctx, g.points);
    ctx.lineWidth = 7;
    ctx.strokeStyle = withAlpha(theme.teal, 0.22);
    ctx.stroke();
  }

  if (loopColor) {
    // Highlighted loop edge: coloured marching ants ONLY (no continuous line
    // under them), gaps left open over the glow — the app's `_drawMarching`.
    tracePath(ctx, g.points);
    ctx.lineWidth = 3.4;
    ctx.strokeStyle = loopColor;
    ctx.setLineDash([7, 6]);
    ctx.lineDashOffset = -(flowPhase * 13);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  } else if (g.link.indirect) {
    // Cosmetic dotted line (independent of polarity).
    tracePath(ctx, g.points);
    ctx.lineWidth = w;
    ctx.strokeStyle = theme.graphite;
    ctx.setLineDash([1, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    tracePath(ctx, g.points);
    ctx.lineWidth = selected ? w + 0.8 : w;
    ctx.strokeStyle = selected ? theme.teal : theme.graphite;
    ctx.stroke();
  }

  const arrowColor = loopColor ?? theme.graphite;
  drawArrow(ctx, g.arrowTip, g.arrowAngle, arrowColor);
  if (g.link.delay) drawDelay(ctx, g.delay, g.delayAngle, theme);
  if (g.link.nonlinear) drawNonlinear(ctx, g.nl, g.nlAngle, theme);
  drawPolarityChip(ctx, g.mid, g.link.polarity, theme, selected);
  ctx.restore();
}

function tracePath(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  tip: Point,
  angle: number,
  color: string,
): void {
  const size = 12;
  const perp = size * 0.5;
  const bx = tip.x - Math.cos(angle) * size;
  const by = tip.y - Math.sin(angle) * size;
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(bx + nx * perp, by + ny * perp);
  ctx.lineTo(bx - nx * perp, by - ny * perp);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawPolarityChip(
  ctx: CanvasRenderingContext2D,
  c: Point,
  polarity: "+" | "-",
  theme: Theme,
  selected: boolean,
): void {
  circle(ctx, c, 9);
  ctx.fillStyle = theme.surface;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = theme.line2;
  ctx.stroke();
  if (selected) {
    circle(ctx, c, 13);
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.teal;
    ctx.stroke();
  }
  ctx.fillStyle = theme.ink;
  ctx.font = "700 15px " + LABEL_FONT;
  setLetterSpacing(ctx, LABEL_TRACKING);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // En-dash (U+2013) for the negative glyph, matching the app.
  ctx.fillText(polarity === "-" ? "–" : "+", c.x, c.y + 0.5);
}

function drawDelay(
  ctx: CanvasRenderingContext2D,
  c: Point,
  angle: number,
  theme: Theme,
): void {
  ctx.save();
  ctx.translate(c.x, c.y);
  // Delay ticks read as a "‖" CROSSING the edge: each tick perpendicular to the
  // flow, the pair offset along it. Rotating by the tangent angle (not +90°)
  // makes the two vertical bars stand across the line, not lie along it.
  ctx.rotate(angle);
  ctx.strokeStyle = theme.graphite;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  for (const dx of [-2.6, 2.6]) {
    ctx.beginPath();
    ctx.moveTo(dx, -6);
    ctx.lineTo(dx, 6);
    ctx.stroke();
  }
  ctx.restore();
}

function drawNonlinear(
  ctx: CanvasRenderingContext2D,
  c: Point,
  angle: number,
  theme: Theme,
): void {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(angle + Math.PI / 2);
  ctx.strokeStyle = theme.graphite;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let x = -8; x <= 8; x += 1) {
    const y = 3 * Math.sin((x / 6) * Math.PI * 2);
    if (x === -8) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** True when the loop's member nodes wind clockwise on screen (y-down), so the
 *  badge's rotor matches the real flow direction. Mirrors `loopClockwise` in the
 *  app's CanvasController. */
function loopClockwise(nodeIds: string[], boxes: Map<string, NodeBox>): boolean {
  const order: string[] = [];
  for (const id of nodeIds) {
    if (order.length && order[order.length - 1] === id) continue;
    order.push(id);
  }
  if (order.length > 1 && order[0] === order[order.length - 1]) order.pop();
  const poly: Point[] = [];
  for (const id of order) {
    const b = boxes.get(id);
    if (b) poly.push({ x: b.cx, y: b.cy });
  }
  if (poly.length < 3) return true;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % poly.length];
    a += p0.x * p1.y - p1.x * p0.y;
  }
  return a > 0;
}

function drawBadge(
  ctx: CanvasRenderingContext2D,
  c: Point,
  label: string,
  type: LoopType,
  theme: Theme,
  selected: boolean,
  clockwise: boolean,
): void {
  const r = selected ? 19 : 14;
  const reinforcing = type === LoopType.reinforcing;
  const color = reinforcing ? theme.tealInk : theme.amberInk;
  const soft = reinforcing ? theme.tealSoft : theme.amberSoft;

  if (selected) {
    circle(ctx, c, r + 5);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  circle(ctx, c, r);
  ctx.fillStyle = theme.surface;
  ctx.fill();
  circle(ctx, c, r);
  ctx.fillStyle = withAlpha(soft, 0.6);
  ctx.fill();
  circle(ctx, c, r);
  ctx.lineWidth = selected ? 1.8 : 1.4;
  ctx.strokeStyle = color;
  ctx.stroke();

  // Circular loop arrow on the emphasised (selected) badge, sweeping in the
  // loop's real flow direction — the app's `_loopBadge` rotor.
  if (selected) {
    const ar = 24;
    const start = clockwise ? -Math.PI * 0.55 : Math.PI * 0.55;
    const sweep = (clockwise ? 1 : -1) * Math.PI * 1.5;
    const end = start + sweep;
    ctx.beginPath();
    ctx.arc(c.x, c.y, ar, start, end, sweep < 0);
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    ctx.strokeStyle = color;
    ctx.stroke();
    const dir = clockwise ? 1 : -1;
    const tan = { x: -Math.sin(end) * dir, y: Math.cos(end) * dir };
    const perp = { x: -tan.y, y: tan.x };
    const tip = { x: c.x + Math.cos(end) * ar, y: c.y + Math.sin(end) * ar };
    const s = 5;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - tan.x * s + perp.x * (s * 0.5), tip.y - tan.y * s + perp.y * (s * 0.5));
    ctx.lineTo(tip.x - tan.x * s - perp.x * (s * 0.5), tip.y - tan.y * s - perp.y * (s * 0.5));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  let size = selected ? 17 : 13;
  if (label.length >= 3) size -= 4;
  else if (label.length === 2) size -= 2;
  ctx.fillStyle = color;
  ctx.font = `800 ${size}px ${MONO_FONT}`;
  setLetterSpacing(ctx, "0px");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, c.x, c.y + 0.5);
}

function drawLinkPreview(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  theme: Theme,
): void {
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = theme.teal;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  circle(ctx, to, 4);
  ctx.fillStyle = theme.teal;
  ctx.fill();
}

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) {
    s = s.slice(0, -1);
  }
  return s + "…";
}
