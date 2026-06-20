import { describe, expect, it } from "vitest";
import {
  DetectedLoop,
  LoopType,
  VariableFile,
  buildEdgeGeoms,
  buildNodeBoxes,
  collectEdges,
  computeBadges,
  emptyVariable,
} from "@neoloopy/cld-canvas";
import { RoutingScene, Selection, routePointerDown } from "../src/view/pointerRouting";

function node(id: string, x: number, y: number, links: string[] = []): VariableFile {
  return {
    ...emptyVariable(id, id),
    x,
    y,
    links: links.map((to) => ({ to, polarity: "+", delay: false, indirect: false, nonlinear: false })),
  };
}

// Two nodes 200 apart with A→B, plus a loop badge sitting on B (with B→A so it's a cycle).
function scene(loops: DetectedLoop[] = []): RoutingScene {
  const nodes = [node("a", 0, 0, ["b"]), node("b", 200, 0, ["a"])];
  const boxes = buildNodeBoxes(nodes);
  const edges = buildEdgeGeoms(collectEdges(nodes), boxes, new Map());
  const badges = computeBadges(loops, boxes);
  return { boxes, edges, badges };
}

const noSel: Selection = { node: null, edge: null, loop: null };

describe("routePointerDown", () => {
  it("empty space → pan", () => {
    expect(routePointerDown(scene(), { x: 0, y: 500 }, 1, noSel)).toEqual({ kind: "pan" });
  });

  it("an unselected node → selectNode", () => {
    expect(routePointerDown(scene(), { x: 0, y: 0 }, 1, noSel)).toEqual({
      kind: "selectNode",
      node: "a",
    });
  });

  it("the already-selected node → moveNode", () => {
    const sel: Selection = { node: "a", edge: null, loop: null };
    expect(routePointerDown(scene(), { x: 0, y: 0 }, 1, sel)).toEqual({
      kind: "moveNode",
      node: "a",
    });
  });

  it("an edge between nodes → selectEdge", () => {
    // Midpoint of the A→B arc is near (100, ~y-offset for the bow).
    const s = scene();
    const mid = s.edges[0].mid;
    expect(routePointerDown(s, mid, 1, noSel)).toEqual({ kind: "selectEdge", edge: s.edges[0].id });
  });

  it("the selected node's connect-ring (no node under cursor) → drawLink", () => {
    const sel: Selection = { node: "a", edge: null, loop: null };
    // Just outside node a's rim: box is ~30 wide, 34 tall → ~25px out, within the 20+tol band.
    const intent = routePointerDown(scene(), { x: 0, y: 33 }, 1, sel);
    expect(intent).toEqual({ kind: "drawLink", from: "a" });
  });

  it("the selected edge's grab zone (no node under cursor) → bowEdge", () => {
    const s = scene();
    const sel: Selection = { node: null, edge: s.edges[0].id, loop: null };
    const intent = routePointerDown(s, s.edges[0].mid, 1, sel);
    expect(intent.kind).toBe("bowEdge");
  });

  it("a loop badge that is not yet selected → selectBadge", () => {
    const loop = new DetectedLoop(["a", "b"], LoopType.reinforcing);
    const s = scene([loop]);
    const badgePt = s.badges.get(loop.key)!;
    expect(routePointerDown(s, badgePt, 1, noSel)).toEqual({
      kind: "selectBadge",
      loop: loop.key,
    });
  });

  it("the already-selected loop badge → moveBadge", () => {
    const loop = new DetectedLoop(["a", "b"], LoopType.reinforcing);
    const s = scene([loop]);
    const badgePt = s.badges.get(loop.key)!;
    const sel: Selection = { node: null, edge: null, loop: loop.key };
    expect(routePointerDown(s, badgePt, 1, sel)).toEqual({ kind: "moveBadge", loop: loop.key });
  });

  it("badge beats an edge it overlaps", () => {
    // A badge sits at the member centroid (100,0), which is also near the edge.
    const loop = new DetectedLoop(["a", "b"], LoopType.reinforcing);
    const s = scene([loop]);
    const badgePt = s.badges.get(loop.key)!;
    const intent = routePointerDown(s, badgePt, 1, noSel);
    expect(intent.kind).toBe("selectBadge");
  });
});
