/**
 * Pure pointer-down routing — the canvas's hit-test priority distilled into a
 * single side-effect-free decision. `onPointerDown` in the view does the I/O
 * (capture, select, set drag state, render); this decides *what* a press at a
 * world point means, given the current scene + selection, so the priority order
 * is testable in isolation.
 *
 * Priority (unchanged from the native app's `_onPointerDown`):
 *   1. a loop badge under the cursor — drag it if it's already selected, else
 *      just select it (a badge relocates only once it is the active loop);
 *   2. the selected node's connect-ring (with no node under the cursor) — draw
 *      a link from it;
 *   3. the selected edge's generous grab zone (with no node under the cursor) —
 *      bow it;
 *   4. a node — move it if it was already selected, else select it (selection
 *      first: a node drags only once it is the active selection);
 *   5. an edge — select it;
 *   6. empty space — clear the selection and pan.
 */

import {
  EdgeGeom,
  NodeBox,
  Point,
  hitBadge,
  hitEdge,
  hitNode,
  inConnectBand,
  nearSelectedEdge,
} from "@neoloopy/cld-canvas";

/** The slice of the scene routing inspects. The painter's `Scene` satisfies it. */
export interface RoutingScene {
  badges: Map<string, Point>;
  boxes: Map<string, NodeBox>;
  edges: EdgeGeom[];
}

export interface Selection {
  node: string | null;
  edge: string | null;
  loop: string | null;
}

export type PointerIntent =
  | { kind: "moveBadge"; loop: string }
  | { kind: "selectBadge"; loop: string }
  | { kind: "drawLink"; from: string }
  | { kind: "bowEdge"; edge: EdgeGeom }
  | { kind: "moveNode"; node: string }
  | { kind: "selectNode"; node: string }
  | { kind: "selectEdge"; edge: string }
  | { kind: "pan" };

/** Connect-ring band tolerance, in world units, matching the view (10/scale). */
const CONNECT_TOL = 10;

export function routePointerDown(
  scene: RoutingScene,
  world: Point,
  scale: number,
  sel: Selection,
): PointerIntent {
  // 1. Loop badge wins over edges (it can sit atop them).
  const badge = hitBadge(scene.badges, world, scale);
  if (badge) {
    return sel.loop === badge
      ? { kind: "moveBadge", loop: badge }
      : { kind: "selectBadge", loop: badge };
  }

  const overNode = hitNode(scene.boxes, world);

  // 2. Draw a link from the selected node's connect-ring.
  if (sel.node) {
    const box = scene.boxes.get(sel.node);
    if (box && inConnectBand(box, world, CONNECT_TOL / scale) && overNode === null) {
      return { kind: "drawLink", from: sel.node };
    }
  }

  // 3. Bow the already-selected edge (a node under the cursor still wins).
  if (sel.edge && overNode === null) {
    const g = scene.edges.find((e) => e.id === sel.edge);
    if (g && nearSelectedEdge(g, world, scale)) {
      return { kind: "bowEdge", edge: g };
    }
  }

  // 4. A node — drag it only if already selected, else select.
  if (overNode) {
    return sel.node === overNode
      ? { kind: "moveNode", node: overNode }
      : { kind: "selectNode", node: overNode };
  }

  // 5. An edge.
  const edge = hitEdge(scene.edges, world, scale);
  if (edge) return { kind: "selectEdge", edge };

  // 6. Empty space.
  return { kind: "pan" };
}
