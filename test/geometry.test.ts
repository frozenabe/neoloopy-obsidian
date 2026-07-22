import { describe, it, expect } from "vitest";
import {
  DetectedLoop,
  LoopType,
  VariableFile,
  VaultLink,
  buildNodeBoxes,
  buildEdgeGeoms,
  collectEdges,
  computeBadges,
  distToSegment,
  emptyVariable,
  hitEdge,
  hitNode,
  inConnectBand,
  loopEdgeIds,
  nearSelectedEdge,
  nodeBounds,
} from "@neoloopy/cld-canvas";

function node(id: string, x: number, y: number, links: VaultLink[] = []): VariableFile {
  return { ...emptyVariable(id, id), x, y, links };
}

function link(to: string): VaultLink {
  return { to, polarity: "+", delay: false, indirect: false, nonlinear: false };
}

describe("node boxes + bounds", () => {
  it("centers a box on the node position", () => {
    const boxes = buildNodeBoxes([node("a", 100, 200)]);
    const b = boxes.get("a")!;
    expect(b.cx).toBe(100);
    expect(b.cy).toBe(200);
    expect(b.w).toBeGreaterThan(0);
  });

  it("computes world bounds across nodes", () => {
    const boxes = buildNodeBoxes([node("a", 0, 0), node("b", 200, 100)]);
    const bb = nodeBounds(boxes);
    expect(bb.minX).toBeLessThan(0);
    expect(bb.maxX).toBeGreaterThan(200);
  });
});

describe("edge geometry", () => {
  it("builds a trimmed polyline with an arrowhead near the target", () => {
    const nodes = [node("a", 0, 0, [link("b")]), node("b", 300, 0)];
    const boxes = buildNodeBoxes(nodes);
    const geoms = buildEdgeGeoms(collectEdges(nodes), boxes);
    expect(geoms).toHaveLength(1);
    const g = geoms[0];
    expect(g.points.length).toBeGreaterThanOrEqual(2);
    // arrow tip lands left of the target center (at its rim)
    expect(g.arrowTip.x).toBeLessThan(300);
    expect(g.arrowTip.x).toBeGreaterThan(150);
  });

  it("bows reciprocal edges to opposite sides", () => {
    const nodes = [node("a", 0, 0, [link("b")]), node("b", 300, 0, [link("a")])];
    const boxes = buildNodeBoxes(nodes);
    const geoms = buildEdgeGeoms(collectEdges(nodes), boxes);
    const ab = geoms.find((g) => g.source === "a")!;
    const ba = geoms.find((g) => g.source === "b")!;
    // their midpoints bow to opposite sides of the chord (opposite y signs)
    expect(Math.sign(ab.mid.y) * Math.sign(ba.mid.y)).toBeLessThan(0);
  });

  it("keeps an automatic reciprocal edge opposite an authored reverse curvature", () => {
    const automatic = link("b");
    const authored: VaultLink = { ...link("a"), curvature: -66 };
    const nodes = [node("a", 0, 0, [automatic]), node("b", 300, 0, [authored])];
    const geoms = buildEdgeGeoms(collectEdges(nodes), buildNodeBoxes(nodes));
    const ab = geoms.find((edge) => edge.source === "a")!;
    const ba = geoms.find((edge) => edge.source === "b")!;

    // Futures Demo stores a hand-bowed Population -> Births connector and an
    // automatic legacy Births -> Population material link. They must not paint
    // on the same geometric side and masquerade as one broken CLD edge.
    expect(Math.sign(ab.mid.y) * Math.sign(ba.mid.y)).toBeLessThan(0);
  });

  it("skips edges whose endpoints are missing", () => {
    const nodes = [node("a", 0, 0, [link("ghost")])];
    const boxes = buildNodeBoxes(nodes);
    expect(buildEdgeGeoms(collectEdges(nodes), boxes)).toHaveLength(0);
  });

  it("honors an explicit link curvature as the signed apex offset", () => {
    const pos: VaultLink = { ...link("b"), curvature: 60 };
    const nodes = [node("a", 0, 0, [pos]), node("b", 300, 0)];
    let g = buildEdgeGeoms(collectEdges(nodes), buildNodeBoxes(nodes))[0];
    // horizontal chord → perpendicular is +y; a positive curvature bows down.
    expect(g.mid.y).toBeGreaterThan(25);

    const neg: VaultLink = { ...link("b"), curvature: -60 };
    const nodes2 = [node("a", 0, 0, [neg]), node("b", 300, 0)];
    g = buildEdgeGeoms(collectEdges(nodes2), buildNodeBoxes(nodes2))[0];
    expect(g.mid.y).toBeLessThan(-25);
  });

  it("freezes a lone edge's bow side when an unrelated node moves the centroid", () => {
    const cache = new Map<string, number>();
    // a→b is the lone edge; c (+ its position) dominates the centroid.
    const build = (cy: number) => {
      const nodes = [node("a", 0, 0, [link("b")]), node("b", 200, 0), node("c", 100, cy)];
      return buildEdgeGeoms(collectEdges(nodes), buildNodeBoxes(nodes), cache).find(
        (e) => e.source === "a",
      )!;
    };
    const side = Math.sign(build(-400).mid.y);
    // Yank c to the opposite side: without the cache this would flip a→b's bow.
    expect(Math.sign(build(400).mid.y)).toBe(side);
    expect(Math.sign(build(4000).mid.y)).toBe(side);
  });
});

describe("loop edge ids", () => {
  it("derives the wrap-around directed edges that close a cycle", () => {
    const loop = new DetectedLoop(["a", "b", "c"], LoopType.reinforcing);
    expect(loopEdgeIds(loop)).toEqual(new Set(["a__b", "b__c", "c__a"]));
  });

  it("handles a two-node loop", () => {
    const loop = new DetectedLoop(["a", "b"], LoopType.balancing);
    expect(loopEdgeIds(loop)).toEqual(new Set(["a__b", "b__a"]));
  });
});

describe("hit testing", () => {
  it("hits a node within its inflated box", () => {
    const boxes = buildNodeBoxes([node("a", 0, 0)]);
    expect(hitNode(boxes, { x: 0, y: 0 })).toBe("a");
    expect(hitNode(boxes, { x: 9999, y: 9999 })).toBeNull();
  });

  it("connect-band excludes the node interior, includes the ring", () => {
    const box = buildNodeBoxes([node("a", 0, 0)]).get("a")!;
    expect(inConnectBand(box, { x: 0, y: 0 }, 5)).toBe(false); // inside body
    expect(inConnectBand(box, { x: 0, y: box.h / 2 + 10 }, 5)).toBe(true); // in ring
  });

  it("distToSegment measures perpendicular distance", () => {
    expect(distToSegment({ x: 0, y: 5 }, { x: -10, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
  });

  it("nearSelectedEdge grabs a wider bow zone than hitEdge (22 curve / 26 handle vs 14)", () => {
    // straight horizontal edge a→b so the polyline lies on y≈0 and mid≈(150,0).
    const straight: VaultLink = { ...link("b"), curvature: 0 };
    const boxes = buildNodeBoxes([node("a", 0, 0, [straight]), node("b", 300, 0)]);
    const g = buildEdgeGeoms(collectEdges([node("a", 0, 0, [straight]), node("b", 300, 0)]), boxes)[0];

    // ~18px off the curve near the far end (away from the midpoint handle):
    // inside the 22 bow zone, but outside the 14 select zone — so "select then
    // drag to bow" catches it where a plain edge-hit would miss, like the app.
    const nearCurve = { x: 240, y: 18 };
    expect(nearSelectedEdge(g, nearCurve, 1)).toBe(true);
    expect(hitEdge([g], nearCurve, 1)).toBeNull();

    // the midpoint handle has the bigger 26 reach (24px above mid → grabbed).
    expect(nearSelectedEdge(g, { x: g.mid.x, y: 24 }, 1)).toBe(true);
    expect(nearSelectedEdge(g, { x: g.mid.x, y: 28 }, 1)).toBe(false);

    // tolerances scale with zoom: at scale 2 the 22/26 world zones halve, so the
    // same 18px-off point now sits outside the 11px world bow zone.
    expect(nearSelectedEdge(g, nearCurve, 2)).toBe(false);
  });
});

describe("loop badges", () => {
  it("separates two badges that would otherwise overlap", () => {
    const boxes = buildNodeBoxes([node("a", 0, 0), node("b", 10, 0)]);
    const loops = [
      new DetectedLoop(["a", "b"], LoopType.reinforcing),
      new DetectedLoop(["a", "b"], LoopType.balancing),
    ];
    const pos = computeBadges(loops, boxes);
    const p = pos.get(loops[0].key)!;
    const q = pos.get(loops[1].key)!;
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(40);
  });
});
