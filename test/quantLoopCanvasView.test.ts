import { describe, expect, it } from "vitest";
import {
  CanvasLoopPath,
  DetectedLoop,
  GraphView,
  LoopGraph,
  LoopType,
  SceneCache,
  VariableFile,
  buildEdgeGeoms,
  buildNodeBoxes,
  discoverCanvasLoops,
  emptyVariable,
  hitEdge,
  loopHighlightFor,
  loopPipeLegIds,
  materialPipeLegVisualState,
  materialPipeLegId,
} from "@neoloopy/cld-canvas";
import { routePointerDown } from "../src/view/pointerRouting";

const link = (to: string, polarity: "+" | "-" = "+") => ({
  to,
  polarity,
  delay: false,
  indirect: false,
  nonlinear: false,
});

function variable(
  id: string,
  label: string,
  type: VariableFile["type"],
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): VariableFile {
  return { ...emptyVariable(id, label), type, x, y, extra };
}

function graph(nodes: VariableFile[], loops: DetectedLoop[]): GraphView {
  return {
    folder: "",
    manifest: {
      id: "model",
      name: "Model",
      schemaVersion: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      created: "",
      modified: "",
      order: 0,
      extra: { mode: "quantitative" },
    },
    nodes,
    loops,
    labels: new Map(loops.map((loop, index) => [
      loop.key,
      `${loop.type === LoopType.reinforcing ? "R" : "B"}${index + 1}`,
    ])),
    quant: true,
  };
}

describe("CRITICAL quantitative loop canvas representation", () => {
  it("keeps the Futures legacy material closure visible, badged, and exact in CLD and SFD", () => {
    const birthRate = variable("birth-rate", "BirthRate", "auxiliary", -120, 150, {
      quant: { equation: "0.03" },
    });
    birthRate.links = [link("births")];
    const births = variable("births", "Births", "flow", 0, 0, {
      quant: { equation: "Population * BirthRate" },
    });
    // Supported pre-extra.flow topology: the flow's signed stock link is the
    // first-class material closure used by the SFD renderer.
    births.links = [link("population")];
    const population = variable("population", "Population", "stock", 300, 0, {
      quant: { initial: "100" },
    });
    population.links = [{ ...link("births"), curvature: -66 }];
    const nodes = [birthRate, births, population];

    const qualitative = new LoopGraph(nodes).detectLoops();
    expect(qualitative).toHaveLength(1);
    const resolved = discoverCanvasLoops(nodes, qualitative);
    expect(resolved.analysisError).toBeNull();
    expect(resolved.loops).toHaveLength(1);
    const loop = resolved.loops[0];
    expect(loop.identityMode).toBe("qualitative");
    expect(loop.canvasPath?.legs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "causal",
        edgeId: "population__births",
        polarity: 1,
      }),
      expect.objectContaining({
        kind: "material",
        flowId: "births",
        stockId: "population",
        cldEdgeId: "births__population",
        polarity: 1,
      }),
    ]));

    const view = graph(nodes, resolved.loops);
    const cache = new SceneCache((label) => label.length * 8);
    const cld = cache.build(view, new Map(), new Map(), "cld")!;
    expect(cld.labels.get(loop.key)).toBe("R1");
    expect(cld.badges).toHaveLength(1);
    expect(cld.edges.map((edge) => edge.id)).toEqual([
      "birth-rate__births",
      "births__population",
      "population__births",
    ]);
    const closure = cld.edges.filter((edge) =>
      edge.id === "births__population" || edge.id === "population__births");
    expect(closure).toHaveLength(2);
    expect(Math.sign(closure[0].mid.y) * Math.sign(closure[1].mid.y)).toBeLessThan(0);
    expect(routePointerDown(cld, cld.badges.get(loop.key)!, 1, {
      node: null,
      edge: null,
      loop: null,
    })).toEqual({ kind: "selectBadge", loop: loop.key });

    const sfd = cache.build(view, new Map(), new Map(), "sfd")!;
    expect(sfd.badges).toHaveLength(1);
    expect(sfd.loops).toEqual([loop]);
    expect(routePointerDown(sfd, sfd.badges.get(loop.key)!, 1, {
      node: null,
      edge: null,
      loop: null,
    })).toEqual({ kind: "selectBadge", loop: loop.key });
    expect(sfd.pipes).toEqual([
      expect.objectContaining({
        flowId: "births",
        from: "~source",
        to: "population",
      }),
    ]);

    const highlight = loopHighlightFor(loop)!;
    expect(highlight.nodeIds).toEqual(new Set(["births", "population"]));
    expect(highlight.edgeIds).toEqual(new Set([
      "births__population",
      "population__births",
    ]));
    expect(highlight.edgeIds).not.toContain("birth-rate__births");
    expect(highlight.pipeLegIds).toEqual(new Set([
      materialPipeLegId("births", "population"),
    ]));
  });

  it("gives a two-node stock drain one CLD badge/projection and one exact SFD pipe leg", () => {
    const stock = variable("stock", "Storage", "stock", 0, 0, {
      quant: { initial: "100" },
    });
    stock.links = [link("drain")];
    const drain = variable("drain", "Drain", "flow", 180, 0, {
      quant: { equation: "Storage / 10" },
      flow: { from: "stock", to: "~sink" },
    });
    const loop = new DetectedLoop(
      ["stock", "drain"],
      LoopType.balancing,
      new CanvasLoopPath([
        {
          kind: "causal",
          fromNodeId: "stock",
          toNodeId: "drain",
          edgeId: "stock__drain",
          polarity: 1,
        },
        {
          kind: "material",
          fromNodeId: "drain",
          toNodeId: "stock",
          flowId: "drain",
          stockId: "stock",
          cldEdgeId: "__cld_material_projection__5:drain:5:stock",
          polarity: -1,
        },
      ]),
    );
    const cache = new SceneCache((s) => s.length * 8);

    const cld = cache.build(graph([stock, drain], [loop]), new Map(), new Map(), "cld")!;
    expect(cld.loops).toEqual([loop]);
    expect(cld.badges).toHaveLength(1);
    expect(cld.edges.map((edge) => [edge.id, edge.renderOnly])).toEqual([
      ["stock__drain", undefined],
      ["__cld_material_projection__5:drain:5:stock", true],
    ]);

    const projection = cld.edges[1];
    expect(hitEdge([projection], projection.mid, 1)).toBeNull();

    const sfd = cache.build(graph([stock, drain], [loop]), new Map(), new Map(), "sfd")!;
    expect(sfd.loops).toEqual([loop]);
    expect(sfd.badges).toHaveLength(1);
    expect(sfd.edges.map((edge) => edge.id)).toEqual(["stock__drain"]);
    expect(sfd.pipes).toHaveLength(1);

    const highlight = loopHighlightFor(loop);
    expect(highlight.edgeIds).toEqual(new Set([
      "stock__drain",
      "__cld_material_projection__5:drain:5:stock",
    ]));
    expect(highlight.pipeLegIds).toEqual(new Set([materialPipeLegId("drain", "stock")]));
    expect(loopPipeLegIds(loop)).toEqual(highlight.pipeLegIds);
    expect(materialPipeLegVisualState("drain", "stock", highlight)).toBe("highlighted");
    expect(materialPipeLegVisualState("drain", null, highlight)).toBe("dimmed");
    expect(materialPipeLegVisualState("drain", "stock", null)).toBe("normal");
  });

  it("keeps the complete four-hop saturation route and replaces/clears exact highlight state", () => {
    const long = new DetectedLoop(
      ["infiltration", "soil", "saturation", "effect"],
      LoopType.balancing,
      new CanvasLoopPath([
          {
            kind: "material",
            fromNodeId: "infiltration",
            toNodeId: "soil",
            flowId: "infiltration",
            stockId: "soil",
            cldEdgeId: "__cld_material_projection__12:infiltration:4:soil",
            polarity: 1,
          },
          {
            kind: "causal",
            fromNodeId: "soil",
            toNodeId: "saturation",
            edgeId: "soil__saturation",
            polarity: 1,
          },
          {
            kind: "causal",
            fromNodeId: "saturation",
            toNodeId: "effect",
            edgeId: "saturation__effect",
            polarity: 1,
          },
          {
            kind: "causal",
            fromNodeId: "effect",
            toNodeId: "infiltration",
            edgeId: "effect__infiltration",
            polarity: -1,
          },
      ]),
    );
    const short = new DetectedLoop(
      ["stock", "drain"],
      LoopType.balancing,
      new CanvasLoopPath([
        {
          kind: "causal",
          fromNodeId: "stock",
          toNodeId: "drain",
          edgeId: "stock__drain",
          polarity: 1,
        },
        {
          kind: "material",
          fromNodeId: "drain",
          toNodeId: "stock",
          flowId: "drain",
          stockId: "stock",
          cldEdgeId: "__cld_material_projection__5:drain:5:stock",
          polarity: -1,
        },
      ]),
    );

    const first = loopHighlightFor(long);
    expect(first.nodeIds).toEqual(new Set(["infiltration", "soil", "saturation", "effect"]));
    expect(first.edgeIds).toEqual(new Set([
      "__cld_material_projection__12:infiltration:4:soil",
      "soil__saturation",
      "saturation__effect",
      "effect__infiltration",
    ]));
    expect(first.pipeLegIds).toEqual(new Set([materialPipeLegId("infiltration", "soil")]));

    const switched = loopHighlightFor(short);
    expect(switched.edgeIds).toEqual(new Set([
      "stock__drain",
      "__cld_material_projection__5:drain:5:stock",
    ]));
    expect(switched.edgeIds).not.toContain("soil__saturation");
    expect(loopHighlightFor(null)).toBeNull();
  });

  it("leaves ordinary causal edge hit testing unchanged", () => {
    const a = variable("a", "A", "auxiliary", 0, 0);
    a.links = [link("b")];
    const b = variable("b", "B", "auxiliary", 180, 0);
    const boxes = buildNodeBoxes([a, b]);
    const edge = buildEdgeGeoms([
      { id: "a__b", source: "a", target: "b", link: a.links[0] },
    ], boxes)[0];
    expect(hitEdge([edge], edge.mid, 1)).toBe("a__b");
  });

  it("keeps same-member directed badge identities separately hittable and switchable", () => {
    const a = variable("a", "A", "stock", 0, 0);
    const b = variable("b", "B", "flow", 180, 0);
    const c = variable("c", "C", "flow", 90, 150);
    const forward = new DetectedLoop(
      ["a", "b", "c"],
      LoopType.reinforcing,
      new CanvasLoopPath([
        { kind: "causal", fromNodeId: "a", toNodeId: "b", edgeId: "a__b", polarity: 1 },
        { kind: "causal", fromNodeId: "b", toNodeId: "c", edgeId: "b__c", polarity: 1 },
        {
          kind: "material", fromNodeId: "c", toNodeId: "a", flowId: "c",
          stockId: "a", cldEdgeId: "projection-forward", polarity: 1,
        },
      ]),
      "quantitative",
    );
    const reverse = new DetectedLoop(
      ["a", "c", "b"],
      LoopType.reinforcing,
      new CanvasLoopPath([
        { kind: "causal", fromNodeId: "a", toNodeId: "c", edgeId: "a__c", polarity: 1 },
        { kind: "causal", fromNodeId: "c", toNodeId: "b", edgeId: "c__b", polarity: 1 },
        {
          kind: "material", fromNodeId: "b", toNodeId: "a", flowId: "b",
          stockId: "a", cldEdgeId: "projection-reverse", polarity: 1,
        },
      ]),
      "quantitative",
    );

    expect(forward.key).not.toBe(reverse.key);
    const scene = new SceneCache((s) => s.length * 8).build(
      graph([a, b, c], [forward, reverse]),
      new Map(),
      new Map(),
      "cld",
    )!;
    const forwardPoint = scene.badges.get(forward.key)!;
    const reversePoint = scene.badges.get(reverse.key)!;
    expect(scene.badges.size).toBe(2);
    expect(forwardPoint).not.toEqual(reversePoint);
    expect(routePointerDown(scene, forwardPoint, 1, {
      node: null, edge: null, loop: null,
    })).toEqual({ kind: "selectBadge", loop: forward.key });
    expect(routePointerDown(scene, reversePoint, 1, {
      node: null, edge: null, loop: forward.key,
    })).toEqual({ kind: "selectBadge", loop: reverse.key });
  });
});
