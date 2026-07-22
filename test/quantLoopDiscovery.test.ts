import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  CanvasLoopPath,
  DetectedLoop,
  LoopGraph,
  LoopType,
  ModelManifest,
  VariableFile,
  VaultLink,
  canonicalDirectedCycle,
  directedCycleKey,
  discoverCanvasLoops,
  emptyVariable,
  labelLoopsByKey,
  linkFromMap,
  linkToMap,
  materialPipeLegId,
  materialProjectionEdgeId,
  parseNote,
  render,
  resolvedLoopNoteKey,
  serializeNote,
} from "@neoloopy/cld-canvas";

type LinkSpec = [to: string, polarity: "+" | "-", indirect?: boolean];

function node(
  id: string,
  label: string,
  type: VariableFile["type"],
  {
    equation,
    initial,
    flow,
    links = [],
    extra = {},
    subsystem,
  }: {
    equation?: string;
    initial?: string;
    flow?: { from: string; to: string };
    links?: LinkSpec[];
    extra?: Record<string, unknown>;
    subsystem?: string;
  } = {},
): VariableFile {
  const causal: VaultLink[] = links.map(([to, polarity, indirect = false]) => ({
    to,
    polarity,
    delay: false,
    indirect,
    nonlinear: false,
  }));
  const quant: Record<string, unknown> = {};
  if (equation !== undefined) quant.equation = equation;
  if (initial !== undefined) quant.initial = initial;
  return {
    ...emptyVariable(id, label),
    type,
    links: causal,
    subsystem,
    extra: {
      ...extra,
      ...(Object.keys(quant).length > 0 ? { quant } : {}),
      ...(flow ? { flow } : {}),
    },
  };
}

function stockDrain(): VariableFile[] {
  return [
    node("stock", "Storage", "stock", {
      initial: "100",
      links: [["drain", "+"]],
    }),
    node("drain", "Drain", "flow", {
      equation: "Storage / 10",
      flow: { from: "stock", to: "~sink" },
    }),
  ];
}

describe("quantitative canvas-loop discovery", () => {
  it("CRITICAL resolves a stock-drain cycle to one causal and one material leg", () => {
    const nodes = stockDrain();
    const result = discoverCanvasLoops(nodes, []);

    expect(result.analysisError).toBeNull();
    expect(result.loops).toHaveLength(1);
    const loop = result.loops[0];
    expect(loop.key).toBe("B:drain>stock");
    expect(loop.canvasPath).toBeInstanceOf(CanvasLoopPath);
    expect(loop.canvasPath?.hasMaterialLeg).toBe(true);
    expect(loop.canvasPath?.legs).toEqual([
      {
        kind: "material",
        fromNodeId: "drain",
        toNodeId: "stock",
        flowId: "drain",
        stockId: "stock",
        cldEdgeId: materialProjectionEdgeId("drain", "stock"),
        polarity: -1,
      },
      {
        kind: "causal",
        fromNodeId: "stock",
        toNodeId: "drain",
        edgeId: "stock__drain",
        polarity: 1,
      },
    ]);
    expect(materialPipeLegId("drain", "stock")).toBe("5:drain>5:stock");
  });

  it("resolves the longer saturation-limited Watershed route exactly", () => {
    const nodes = [
      node("water", "Water in Soil", "stock", {
        initial: "100",
        links: [["saturation", "+"]],
      }),
      node("saturation", "Soil Saturation", "auxiliary", {
        equation: "min(1, Water in Soil / 100)",
        links: [["effect", "+"]],
      }),
      node("effect", "Soil Saturation Effect", "auxiliary", {
        equation: "Soil Saturation ^ 2",
        links: [["infiltration", "-"]],
      }),
      node("infiltration", "Infiltrating Soil", "flow", {
        equation: "100 * (1 - Soil Saturation Effect)",
        flow: { from: "~source", to: "water" },
      }),
    ];

    const result = discoverCanvasLoops(nodes, []);
    expect(result.analysisError).toBeNull();
    expect(result.loops).toHaveLength(1);
    expect(result.loops[0].type).toBe(LoopType.balancing);
    expect(result.loops[0].nodeIds).toEqual([
      "effect",
      "infiltration",
      "water",
      "saturation",
    ]);
    expect(result.loops[0].canvasPath?.legs.map((leg) => leg.kind)).toEqual([
      "causal",
      "material",
      "causal",
      "causal",
    ]);
    expect(result.loops[0].canvasPath?.legs[1]).toMatchObject({
      flowId: "infiltration",
      stockId: "water",
      polarity: 1,
    });
  });

  it("CRITICAL resolves the eight-loop Watershed family with stable B1-B8 labels", () => {
    const nodes = [
      node("surface", "Surface Water", "stock", { initial: "100", links: [
        ["to_stream", "+"], ["infiltration", "+"],
      ] }),
      node("soil", "Water in Soil", "stock", { initial: "100", links: [
        ["evap", "+"], ["interflow", "+"], ["recharge", "+"], ["saturation", "+"],
      ] }),
      node("groundwater", "Groundwater", "stock", { initial: "100", links: [["gw_flow", "+"]] }),
      node("stream", "Stream", "stock", { initial: "100", links: [["through_stream", "+"]] }),
      node("evap", "Evapotranspiring", "flow", {
        equation: "Water in Soil / 10", flow: { from: "soil", to: "~sink" },
      }),
      node("through_stream", "Flowing Through Stream", "flow", {
        equation: "Stream / 10", flow: { from: "stream", to: "~sink" },
      }),
      node("to_stream", "Flowing to Stream", "flow", {
        equation: "Surface Water / 10", flow: { from: "surface", to: "stream" },
      }),
      node("gw_flow", "Groundwater Flowing to Stream", "flow", {
        equation: "Groundwater / 10", flow: { from: "groundwater", to: "stream" },
      }),
      node("infiltration", "Infiltrating Soil", "flow", {
        equation: "Surface Water * (1 - Soil Saturation Effect)",
        flow: { from: "surface", to: "soil" },
      }),
      node("interflow", "Interflowing", "flow", {
        equation: "Water in Soil / 20", flow: { from: "soil", to: "stream" },
      }),
      node("recharge", "Recharging Groundwater", "flow", {
        equation: "Water in Soil / 30", flow: { from: "soil", to: "groundwater" },
      }),
      node("runoff", "Running Off", "flow", {
        equation: "1", flow: { from: "~source", to: "surface" },
      }),
      node("saturation", "Soil Saturation", "auxiliary", {
        equation: "min(1, Water in Soil / 100)", links: [["effect", "+"]],
      }),
      node("effect", "Soil Saturation Effect", "auxiliary", {
        equation: "Soil Saturation ^ 2", links: [["infiltration", "-"]],
      }),
    ];

    expect(new LoopGraph(nodes).detectLoops()).toEqual([]);
    const result = discoverCanvasLoops(nodes, []);
    expect(result.analysisError).toBeNull();
    expect(result.loops).toHaveLength(8);
    expect(result.loops.every((loop) => loop.canvasPath?.hasMaterialLeg)).toBe(true);

    const names = new Map(nodes.map((entry) => [entry.id, entry.label]));
    const labels = labelLoopsByKey(result.loops, (id) => names.get(id) ?? id);
    const routes = Object.fromEntries(result.loops.map((loop) => [
      labels.get(loop.key),
      canonicalDirectedCycle(loop.nodeIds.map((id) => names.get(id) ?? id)),
    ]));
    expect(routes).toEqual({
      B1: ["Evapotranspiring", "Water in Soil"],
      B2: ["Flowing Through Stream", "Stream"],
      B3: ["Flowing to Stream", "Surface Water"],
      B4: ["Groundwater", "Groundwater Flowing to Stream"],
      B5: ["Infiltrating Soil", "Surface Water"],
      B6: ["Interflowing", "Water in Soil"],
      B7: ["Recharging Groundwater", "Water in Soil"],
      B8: [
        "Infiltrating Soil",
        "Water in Soil",
        "Soil Saturation",
        "Soil Saturation Effect",
      ],
    });
  });

  it("deduplicates an exact qualitative counterpart and decorates that identity", () => {
    const nodes = stockDrain();
    nodes[1].links = [{
      to: "stock",
      polarity: "-",
      delay: false,
      indirect: false,
      nonlinear: false,
    }];
    const qualitative = new LoopGraph(nodes).detectLoops();
    expect(qualitative).toHaveLength(1);

    const result = discoverCanvasLoops(nodes, qualitative);
    expect(result.analysisError).toBeNull();
    expect(result.loops).toHaveLength(1);
    expect(result.loops[0].key).toBe(qualitative[0].key);
    expect(result.loops[0].canvasPath?.hasMaterialLeg).toBe(true);
    expect(result.loops[0].canvasPath?.legs.find((leg) => leg.kind === "material")).toMatchObject({
      cldEdgeId: "drain__stock",
      polarity: -1,
    });
  });

  it("fails closed on ambiguous legacy material topology", () => {
    const nodes = stockDrain();
    delete nodes[1].extra.flow;
    nodes[1].links = [
      { to: "stock", polarity: "-", delay: false, indirect: false, nonlinear: false },
      { to: "other-stock", polarity: "-", delay: false, indirect: false, nonlinear: false },
    ];
    nodes.push(node("other-stock", "Other Storage", "stock", { initial: "50" }));

    const qualitative = new LoopGraph(nodes).detectLoops();
    expect(qualitative).toHaveLength(1);
    const result = discoverCanvasLoops(nodes, qualitative);
    expect(result.analysisError).toMatch(/^quant-loop-analysis-incomplete:/);
    expect(result.loops).toHaveLength(1);
    expect(result.loops[0].key).toBe(qualitative[0].key);
    expect(result.loops[0].canvasPath).toBeUndefined();
  });

  it("fails closed when malformed explicit endpoints coexist with a legacy material link", () => {
    const nodes = stockDrain();
    nodes[1].extra.flow = { from: "stock" };
    nodes[1].links = [{
      to: "stock",
      polarity: "-",
      delay: false,
      indirect: false,
      nonlinear: false,
    }];

    const result = discoverCanvasLoops(nodes, new LoopGraph(nodes).detectLoops());
    expect(result.analysisError).toContain("malformed explicit material endpoints");
    expect(result.loops).toHaveLength(1);
    expect(result.loops[0].canvasPath).toBeUndefined();
  });

  it.each([
    ["unknown", { to: "other-stock", polarity: "?" as const, delay: false, indirect: false, nonlinear: false }],
    ["dashed", { to: "other-stock", polarity: "-" as const, delay: false, indirect: true, nonlinear: false }],
  ])("fails closed when a resolvable legacy material leg has an extra %s stock candidate", (_name, extraLink) => {
    const nodes = stockDrain();
    delete nodes[1].extra.flow;
    nodes[1].links = [
      { to: "stock", polarity: "-", delay: false, indirect: false, nonlinear: false },
      extraLink,
    ];
    nodes.push(node("other-stock", "Other Storage", "stock", { initial: "50" }));

    const qualitative = new LoopGraph(nodes).detectLoops();
    expect(qualitative).toHaveLength(1);
    const result = discoverCanvasLoops(nodes, qualitative);
    expect(result.analysisError).toMatch(/^quant-loop-analysis-incomplete:/);
    expect(result.loops).toHaveLength(1);
    expect(result.loops[0].key).toBe(qualitative[0].key);
    expect(result.loops[0].canvasPath).toBeUndefined();
  });

  it("fails a candidate closed when an executable connector is unresolved", () => {
    const nodes = stockDrain();
    nodes[0].links = [];
    const result = discoverCanvasLoops(nodes, []);
    expect(result.analysisError).toMatch(/^quant-loop-analysis-incomplete:/);
    expect(result.loops).toEqual([]);
  });

  it("fails closed on an invalid first-class material endpoint", () => {
    const nodes = stockDrain();
    nodes[1].extra.flow = { from: "stock", to: "missing-stock" };
    const result = discoverCanvasLoops(nodes, []);
    expect(result.loops).toEqual([]);
    expect(result.analysisError).toContain("invalid material endpoints");
  });

  it.each([
    ["dashed", [["drain", "+", true]] as LinkSpec[]],
    ["duplicate", [["drain", "+"], ["drain", "+"]] as LinkSpec[]],
    ["conflicting", [["drain", "+"], ["drain", "-"]] as LinkSpec[]],
  ])("fails closed on a %s displayed connector", (_name, links) => {
    const nodes = stockDrain();
    nodes[0].links = links.map(([to, polarity, indirect = false]) => ({
      to,
      polarity,
      delay: false,
      indirect,
      nonlinear: false,
    }));
    const result = discoverCanvasLoops(nodes, []);
    expect(result.loops).toEqual([]);
    expect(result.analysisError).toMatch(/^quant-loop-analysis-incomplete:/);
  });

  it.each([
    ["dashed", [["stock", "-", true]] as LinkSpec[]],
    ["conflicting", [["stock", "+"]] as LinkSpec[]],
    ["duplicate", [["stock", "-"], ["stock", "-"]] as LinkSpec[]],
  ])("fails closed on a %s displayed material counterpart", (_name, links) => {
    const nodes = stockDrain();
    nodes[1].links = links.map(([to, polarity, indirect = false]) => ({
      to,
      polarity,
      delay: false,
      indirect,
      nonlinear: false,
    }));
    const result = discoverCanvasLoops(nodes, []);
    expect(result.loops).toEqual([]);
    expect(result.analysisError).toMatch(/^quant-loop-analysis-incomplete:/);
  });

  it("keeps qualitative loops but rejects quant badges for ambiguous labels", () => {
    const nodes = stockDrain();
    nodes.push(node("other", "Storage", "auxiliary", { equation: "1" }));
    const qualitative = [new DetectedLoop(["stock", "drain"], LoopType.balancing)];
    const result = discoverCanvasLoops(nodes, qualitative);
    expect(result.loops).toEqual(qualitative);
    expect(result.analysisError).toContain("duplicate variable label");
    expect(result.loops[0].canvasPath).toBeUndefined();
  });

  it.each([
    "missing equation",
    "malformed equation",
    "unsupported stateful equation",
  ])("surfaces %s and emits no quantitative badge", (_name) => {
    const nodes = stockDrain();
    if (_name === "missing equation") {
      delete (nodes[1].extra.quant as Record<string, unknown>).equation;
    } else if (_name === "malformed equation") {
      (nodes[1].extra.quant as Record<string, unknown>).equation = "Storage + * 2";
    } else {
      (nodes[1].extra.quant as Record<string, unknown>).equation = "SMOOTH(Storage, 3)";
    }
    const result = discoverCanvasLoops(nodes, []);
    expect(result.loops).toEqual([]);
    expect(result.analysisError).toMatch(/^quant-loop-analysis-incomplete:/);
  });

  it("rejects arrayed and subsystem/composed models wholesale", () => {
    const arrayed = stockDrain();
    (arrayed[0].extra.quant as Record<string, unknown>).subscript = "Region";
    expect(discoverCanvasLoops(arrayed, []).analysisError).toContain("arrayed");

    const manifest: ModelManifest = {
      id: "m",
      name: "Arrayed",
      schemaVersion: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      order: 0,
      extra: {
        mode: "quantitative",
        quantitative: { dimensions: { Region: ["north", "south"] } },
      },
    };
    expect(discoverCanvasLoops(stockDrain(), [], { manifest }).analysisError).toContain("arrayed");

    const composed = stockDrain();
    composed[0].subsystem = "[[../Child/System|Child]]";
    expect(discoverCanvasLoops(composed, []).analysisError).toContain("subsystem");

    const bound = stockDrain();
    (bound[0].extra.quant as Record<string, unknown>).inputBindings = [
      { child: "mdl_child", target: "input", expr: "1" },
    ];
    expect(discoverCanvasLoops(bound, []).analysisError).toContain("composed");
  });

  it("does not confuse auxiliary component-authoring metadata with a subsystem", () => {
    const nodes = stockDrain();
    (nodes[1].extra.quant as Record<string, unknown>).composition = {
      schema: "neoloopy.composite-values.v1",
      active: true,
      generatedEquation: "Storage / 10",
      rows: [{ id: "drain", label: "Drain", expression: "Storage / 10" }],
    };

    const result = discoverCanvasLoops(nodes, []);
    expect(result.analysisError).toBeNull();
    expect(result.loops).toHaveLength(1);
    expect(result.loops[0].canvasPath?.hasMaterialLeg).toBe(true);
  });

  it("fails closed on an unknown connector polarity instead of coercing it positive", () => {
    const nodes = stockDrain();
    nodes[0].links[0].polarity = "?";
    const result = discoverCanvasLoops(nodes, []);
    expect(result.loops).toEqual([]);
    expect(result.analysisError).toContain("unknown polarity");
    expect(new LoopGraph(nodes).detectLoops()).toEqual([]);
  });

  it("preserves unknown polarity through the engine map codec", () => {
    const link = linkFromMap({
      to: "target",
      polarity: "?",
      delay: false,
      indirect: false,
      nonlinear: false,
    });
    expect(link.polarity).toBe("?");
    expect(Object.fromEntries(linkToMap(link)).polarity).toBe("?");
    const encoded = serializeNote({
      ...emptyVariable("a", "A"),
      links: [link],
    });
    expect(encoded).toContain('polarity: "?"');
    expect(parseNote(encoded, parseYaml).links[0].polarity).toBe("?");
    const nodes = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    const edges = [{ id: "a__b", source: "a", target: "b", polarity: "?" as const }];
    expect(render("mermaid", "m", "M", nodes, edges, []).content).toContain("|?|");
    expect(JSON.parse(render("json", "m", "M", nodes, edges, []).content)
      .graph.edges[0].polarity).toBe("?");
  });

  it("retains the legacy positive default when a qualitative link omits polarity", () => {
    expect(linkFromMap({ to: "target" }).polarity).toBe("+");
  });

  it.each(["bogus", 2, false, {}, []])(
    "preserves explicit malformed polarity %j as unknown",
    (polarity) => {
      expect(linkFromMap({ to: "target", polarity }).polarity).toBe("?");
    },
  );

  it("fails closed rather than returning a prefix when a discovery limit is reached", () => {
    const result = discoverCanvasLoops(stockDrain(), [], {
      limits: { maxLoops: 2048, maxEdgeVisits: 1, maxDepth: 512 },
    });
    expect(result.loops).toEqual([]);
    expect(result.analysisError).toContain("maxEdgeVisits=1");
  });

  it("fails closed rather than returning a prefix at the loop-output limit", () => {
    const nodes = [
      ...stockDrain(),
      node("stock_2", "Second Storage", "stock", {
        initial: "100",
        links: [["drain_2", "+"]],
      }),
      node("drain_2", "Second Drain", "flow", {
        equation: "Second Storage / 10",
        flow: { from: "stock_2", to: "~sink" },
      }),
    ];
    const result = discoverCanvasLoops(nodes, [], {
      limits: { maxLoops: 1, maxEdgeVisits: 100_000, maxDepth: 512 },
    });
    expect(result.loops).toEqual([]);
    expect(result.analysisError).toContain("maxLoops=1");
  });

  it("fails closed rather than returning a prefix at the traversal-depth limit", () => {
    const nodes = [
      node("stock", "Storage", "stock", {
        initial: "100",
        links: [["first", "+"]],
      }),
      node("first", "First Auxiliary", "auxiliary", {
        equation: "Storage",
        links: [["second", "+"]],
      }),
      node("second", "Second Auxiliary", "auxiliary", {
        equation: "First Auxiliary",
        links: [["drain", "+"]],
      }),
      node("drain", "Drain", "flow", {
        equation: "Second Auxiliary",
        flow: { from: "stock", to: "~sink" },
      }),
    ];
    const result = discoverCanvasLoops(nodes, [], {
      limits: { maxLoops: 2048, maxEdgeVisits: 100_000, maxDepth: 3 },
    });
    expect(result.loops).toEqual([]);
    expect(result.analysisError).toContain("maxDepth=3");
  });
});

describe("directed loop identity", () => {
  it("is rotation-invariant, reversal-sensitive, and separator-safe", () => {
    expect(canonicalDirectedCycle(["b", "c", "a"])).toEqual(["a", "b", "c"]);
    expect(directedCycleKey(["b", "c", "a"])).toBe("a>b>c");
    expect(directedCycleKey(["a", "b", "c"])).not.toBe(
      directedCycleKey(["a", "c", "b"]),
    );
    expect(directedCycleKey(["a>b", "c%"])).toBe("a%3Eb>c%25");
  });

  it("keeps opposite routings through the same node set as distinct badges", () => {
    const qualitative = new DetectedLoop(["a", "b", "c"], LoopType.reinforcing);
    expect(qualitative.key).toBe("0:a|b|c");
    const forward = new DetectedLoop(
      ["a", "b", "c"], LoopType.reinforcing, undefined, "quantitative",
    );
    const reverse = new DetectedLoop(
      ["a", "c", "b"], LoopType.reinforcing, undefined, "quantitative",
    );
    expect(forward.key).not.toBe(reverse.key);
    expect(forward.exactKey).not.toBe(reverse.exactKey);
  });

  it("uses one compatible note key rule for qualitative, enriched, and quant routes", () => {
    const names = new Map([["a", "Alpha"], ["b", "Beta"], ["c", "Gamma"]]);
    const nameOf = (id: string): string => names.get(id) ?? id;
    const qualitative = new DetectedLoop(["a", "b", "c"], LoopType.balancing);
    const enriched = new DetectedLoop(
      ["a", "b", "c"], LoopType.balancing, new CanvasLoopPath([]),
    );
    const forward = new DetectedLoop(
      ["a", "b", "c"], LoopType.balancing, undefined, "quantitative",
    );
    const reverse = new DetectedLoop(
      ["a", "c", "b"], LoopType.balancing, undefined, "quantitative",
    );
    expect(resolvedLoopNoteKey(qualitative, nameOf)).toBe("B:Alpha|Beta|Gamma");
    expect(resolvedLoopNoteKey(enriched, nameOf)).toBe("B:Alpha|Beta|Gamma");
    expect(resolvedLoopNoteKey(forward, nameOf)).toBe(forward.exactKey);
    expect(resolvedLoopNoteKey(reverse, nameOf)).toBe(reverse.exactKey);
    expect(resolvedLoopNoteKey(forward, nameOf)).not.toBe(
      resolvedLoopNoteKey(reverse, nameOf),
    );
  });
});
