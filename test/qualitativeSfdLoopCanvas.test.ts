import { describe, expect, it } from "vitest";
import {
  CanvasLoopPath,
  DetectedLoop,
  GraphView,
  LoopGraph,
  LoopType,
  SceneCache,
  VariableFile,
  discoverCanvasLoops,
  emptyVariable,
  labelLoopsByKey,
  loopHighlightFor,
  loopsForMode,
  materialPipeLegId,
  retainedLoopKeyForMode,
  resolvedLoopNoteKey,
} from "@neoloopy/cld-canvas";
import { routePointerDown } from "../src/view/pointerRouting";

const link = (to: string, polarity: "+" | "-") => ({
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

function qualitativeGraph(
  nodes: VariableFile[],
  loops: DetectedLoop[],
): GraphView {
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
      extra: {},
    },
    nodes,
    loops,
    labels: new Map(
      loops.map((loop, index) => [
        loop.key,
        `${loop.type === LoopType.reinforcing ? "R" : "B"}${index + 1}`,
      ]),
    ),
    quant: false,
  };
}

function pmdNodes(): VariableFile[] {
  const hiring = variable("hiring", "Hiring", "flow", 0, 0, {
    flow: { from: "~source", to: "workforce" },
  });
  hiring.links = [link("workforce", "+"), link("productivity", "-")];

  const workforce = variable("workforce", "Workforce", "stock", 170, 160);
  workforce.links = [link("output", "+")];

  const productivity = variable(
    "productivity",
    "Productivity",
    "auxiliary",
    170,
    -120,
  );
  productivity.links = [link("output", "+")];

  const output = variable("output", "Output", "flow", 360, 20);
  output.links = [link("schedule", "-")];

  const schedule = variable(
    "schedule",
    "Schedule Pressure",
    "auxiliary",
    540,
    20,
  );
  schedule.links = [link("hiring", "+"), link("overtime", "+")];

  const overtime = variable("overtime", "Overtime", "auxiliary", 360, -120);
  overtime.links = [link("fatigue", "+"), link("output", "+")];

  const fatigue = variable("fatigue", "Fatigue", "stock", 170, 20);
  fatigue.links = [link("attrition", "+"), link("productivity", "-")];

  const attrition = variable("attrition", "Attrition", "flow", 0, 160, {
    flow: { from: "workforce", to: "~sink" },
  });
  attrition.links = [link("workforce", "-")];

  return [
    hiring,
    workforce,
    productivity,
    output,
    schedule,
    overtime,
    fatigue,
    attrition,
  ];
}

function byMembers(loops: DetectedLoop[], members: string[]): DetectedLoop {
  const wanted = [...members].sort().join("|");
  return loops.find((loop) => [...loop.nodeIds].sort().join("|") === wanted)!;
}

describe("CRITICAL qualitative loop fidelity in a mixed CLD/SFD", () => {
  it("keeps all five PMD loops badged and maps only B2/R3 closures to exact pipes", () => {
    const nodes = pmdNodes();
    const declared = new LoopGraph(nodes).detectLoops();
    expect(declared).toHaveLength(5);
    const nameOf = (id: string): string =>
      nodes.find((node) => node.id === id)?.label ?? id;
    const declaredLabels = labelLoopsByKey(declared, nameOf);
    const declaredCompatibility = new Map(
      declared.map((loop) => [
        loop.key,
        {
          noteKey: resolvedLoopNoteKey(loop, nameOf),
          label: declaredLabels.get(loop.key),
        },
      ]),
    );

    const discovered = discoverCanvasLoops(nodes, declared, {
      manifest: qualitativeGraph(nodes, declared).manifest,
    });
    expect(discovered.analysisError).toBeNull();
    expect(discovered.loops).toHaveLength(5);
    expect(
      discovered.loops.every((loop) => loop.identityMode === "qualitative"),
    ).toBe(true);
    expect(
      discovered.loops.every((loop) => loop.canvasPath !== undefined),
    ).toBe(true);
    expect(loopsForMode(discovered.loops, "cld")).toHaveLength(5);
    expect(loopsForMode(discovered.loops, "sfd")).toHaveLength(5);
    const enrichedLabels = labelLoopsByKey(discovered.loops, nameOf);
    expect(discovered.loops.map((loop) => loop.key).sort()).toEqual(
      declared.map((loop) => loop.key).sort(),
    );
    for (const loop of discovered.loops) {
      const before = declaredCompatibility.get(loop.key);
      expect(before).toBeDefined();
      expect(resolvedLoopNoteKey(loop, nameOf)).toBe(before?.noteKey);
      expect(enrichedLabels.get(loop.key)).toBe(before?.label);
    }

    const b2 = byMembers(discovered.loops, [
      "hiring",
      "workforce",
      "output",
      "schedule",
    ]);
    const r3 = byMembers(discovered.loops, [
      "workforce",
      "output",
      "schedule",
      "overtime",
      "fatigue",
      "attrition",
    ]);
    const r1 = byMembers(discovered.loops, [
      "hiring",
      "productivity",
      "output",
      "schedule",
    ]);
    const r2 = byMembers(discovered.loops, [
      "productivity",
      "output",
      "schedule",
      "overtime",
      "fatigue",
    ]);
    const b1 = byMembers(discovered.loops, ["output", "schedule", "overtime"]);

    expect(b2.type).toBe(LoopType.balancing);
    expect(r3.type).toBe(LoopType.reinforcing);
    expect(
      b2.canvasPath?.legs.filter((leg) => leg.kind === "material"),
    ).toEqual([
      expect.objectContaining({
        flowId: "hiring",
        stockId: "workforce",
        cldEdgeId: "hiring__workforce",
        polarity: 1,
      }),
    ]);
    expect(
      r3.canvasPath?.legs.filter((leg) => leg.kind === "material"),
    ).toEqual([
      expect.objectContaining({
        flowId: "attrition",
        stockId: "workforce",
        cldEdgeId: "attrition__workforce",
        polarity: -1,
      }),
    ]);
    for (const causalOnly of [r1, r2, b1]) {
      expect(causalOnly.canvasPath?.hasMaterialLeg).toBe(false);
      expect(
        causalOnly.canvasPath?.legs.every((leg) => leg.kind === "causal"),
      ).toBe(true);
    }

    const b2Highlight = loopHighlightFor(b2)!;
    expect(b2Highlight.pipeLegIds).toEqual(
      new Set([materialPipeLegId("hiring", "workforce")]),
    );
    expect(b2Highlight.edgeIds).toEqual(
      new Set([
        "hiring__workforce",
        "workforce__output",
        "output__schedule",
        "schedule__hiring",
      ]),
    );
    expect(loopHighlightFor(r3)!.pipeLegIds).toEqual(
      new Set([materialPipeLegId("attrition", "workforce")]),
    );
    expect(loopHighlightFor(r3)!.edgeIds).toEqual(
      new Set([
        "workforce__output",
        "output__schedule",
        "schedule__overtime",
        "overtime__fatigue",
        "fatigue__attrition",
        "attrition__workforce",
      ]),
    );
    expect(loopHighlightFor(r2)!.edgeIds).toEqual(
      new Set([
        "productivity__output",
        "output__schedule",
        "schedule__overtime",
        "overtime__fatigue",
        "fatigue__productivity",
      ]),
    );
    expect(loopHighlightFor(r1)!.pipeLegIds).toEqual(new Set());

    const declaredB2 = byMembers(declared, [
      "hiring",
      "workforce",
      "output",
      "schedule",
    ]);
    expect(b2.key).toBe(declaredB2.key);
    expect(resolvedLoopNoteKey(b2, nameOf)).toBe(
      resolvedLoopNoteKey(declaredB2, nameOf),
    );
    expect(enrichedLabels.get(b2.key)).toBe(declaredLabels.get(declaredB2.key));

    const graph = qualitativeGraph(nodes, discovered.loops);
    graph.labels = enrichedLabels;
    const cache = new SceneCache((label) => label.length * 8);
    const cld = cache.build(graph, new Map(), new Map(), "cld")!;
    const sfd = cache.build(graph, new Map(), new Map(), "sfd")!;
    expect(cld.badges).toHaveLength(5);
    expect(sfd.badges).toHaveLength(5);
    expect(sfd.loops).toEqual(discovered.loops);
    expect(sfd.edges.map((edge) => edge.id)).not.toContain("hiring__workforce");
    expect(sfd.edges.map((edge) => edge.id)).not.toContain(
      "attrition__workforce",
    );
    expect(sfd.pipes.map((pipe) => pipe.flowId).sort()).toEqual([
      "attrition",
      "hiring",
    ]);
    expect(sfd.labels.get(b2.key)).toBe(declaredLabels.get(declaredB2.key));
    expect(
      routePointerDown(sfd, sfd.badges.get(b2.key)!, 1, {
        node: null,
        edge: null,
        loop: null,
      }),
    ).toEqual({ kind: "selectBadge", loop: declaredB2.key });
    expect(retainedLoopKeyForMode(discovered.loops, b2.key, "cld")).toBe(
      declaredB2.key,
    );
    expect(retainedLoopKeyForMode(discovered.loops, b2.key, "sfd")).toBe(
      declaredB2.key,
    );
    expect(retainedLoopKeyForMode(discovered.loops, r1.key, "cld")).toBe(
      r1.key,
    );
    expect(retainedLoopKeyForMode(discovered.loops, r1.key, "sfd")).toBe(
      r1.key,
    );
  });

  it("fails an ambiguous same-member qualitative route closed in SFD", () => {
    const a = variable("a", "A", "auxiliary", 0, 0);
    const b = variable("b", "B", "auxiliary", 180, -80);
    const c = variable("c", "C", "auxiliary", 180, 80);
    a.links = [link("b", "+"), link("c", "+")];
    b.links = [link("a", "+"), link("c", "+")];
    c.links = [link("a", "+"), link("b", "+")];
    const nodes = [a, b, c];

    const declared = new LoopGraph(nodes).detectLoops();
    const triangle = declared.filter((loop) => loop.nodeIds.length === 3);
    expect(triangle).toHaveLength(1);
    expect(
      (triangle[0] as DetectedLoop & { exactRouteAmbiguous?: boolean })
        .exactRouteAmbiguous,
    ).toBe(true);

    const discovered = discoverCanvasLoops(nodes, declared, {
      manifest: qualitativeGraph(nodes, declared).manifest,
    });
    const displayedTriangle = discovered.loops.find(
      (loop) => loop.nodeIds.length === 3,
    )!;
    expect(displayedTriangle).toBeDefined();
    expect(displayedTriangle.canvasPath).toBeUndefined();
    expect(loopsForMode(discovered.loops, "cld")).toContain(
      displayedTriangle,
    );
    expect(loopsForMode(discovered.loops, "sfd")).not.toContain(
      displayedTriangle,
    );
  });

  it("clears a quantitative-only causal selection when entering SFD", () => {
    const quantOnly = new DetectedLoop(
      ["a", "b"],
      LoopType.reinforcing,
      new CanvasLoopPath([
        {
          kind: "causal",
          fromNodeId: "a",
          toNodeId: "b",
          edgeId: "a__b",
          polarity: 1,
        },
        {
          kind: "causal",
          fromNodeId: "b",
          toNodeId: "a",
          edgeId: "b__a",
          polarity: 1,
        },
      ]),
      "quantitative",
    );

    expect(retainedLoopKeyForMode([quantOnly], quantOnly.key, "cld")).toBe(
      quantOnly.key,
    );
    expect(retainedLoopKeyForMode([quantOnly], quantOnly.key, "sfd")).toBeNull();
  });

  it("keeps Risk B1 exact when published inputs make quant analysis incomplete", () => {
    const unverified = variable(
      "var_87574ed9",
      "Unverified Evidence Packages",
      "stock",
      0,
      0,
      { quant: { initial: "100" } },
    );
    unverified.links = [link("var_12f34316", "+")];
    const verified = variable(
      "var_03a17d2f",
      "Verified Evidence Packages",
      "stock",
      360,
      0,
      { quant: { initial: "0" } },
    );
    const baseRate = variable(
      "base-rate",
      "Base Processing Rate",
      "auxiliary",
      180,
      -120,
      { quant: { visibility: "input" } },
    );
    baseRate.links = [link("var_12f34316", "+")];
    const verification = variable(
      "var_12f34316",
      "Independent Verification and Issue Closure",
      "flow",
      180,
      0,
      {
        flow: { from: unverified.id, to: verified.id },
        quant: {
          equation: "Base Processing Rate * Unverified Evidence Packages",
        },
      },
    );
    verification.links = [link(unverified.id, "-"), link(verified.id, "+")];
    const nodes = [baseRate, unverified, verified, verification];
    const declared = new LoopGraph(nodes).detectLoops();
    expect(declared).toHaveLength(1);

    const manifest = qualitativeGraph(nodes, declared).manifest;
    manifest.extra = { mode: "quantitative" };
    const discovered = discoverCanvasLoops(nodes, declared, { manifest });
    expect(discovered.analysisError).toContain(
      "missing equation for Base Processing Rate",
    );
    expect(discovered.loops).toHaveLength(1);
    const loop = discovered.loops[0];
    expect(loop.canvasPath?.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "causal",
          edgeId: `${unverified.id}__${verification.id}`,
        }),
        expect.objectContaining({
          kind: "material",
          flowId: verification.id,
          stockId: unverified.id,
          polarity: -1,
        }),
      ]),
    );

    const sfd = new SceneCache((label) => label.length * 8).build(
      qualitativeGraph(nodes, discovered.loops),
      new Map(),
      new Map(),
      "sfd",
    )!;
    expect(sfd.badges).toHaveLength(1);
    const highlight = loopHighlightFor(loop)!;
    expect(highlight.pipeLegIds).toEqual(
      new Set([materialPipeLegId(verification.id, unverified.id)]),
    );
    expect(highlight.pipeLegIds).not.toContain(
      materialPipeLegId(verification.id, verified.id),
    );
  });

  it("keeps an exact authored loop when unsupported quant composition fails", () => {
    const a = variable("a", "A", "auxiliary", 0, 0, {
      quant: { equation: "1", dimensions: ["Region"] },
    });
    a.subsystem = "Child model";
    a.links = [link("b", "+")];
    const b = variable("b", "B", "auxiliary", 180, 0, {
      quant: { equation: "A" },
    });
    b.links = [link("a", "-")];
    const nodes = [a, b];
    const declared = new LoopGraph(nodes).detectLoops();
    const manifest = qualitativeGraph(nodes, declared).manifest;
    manifest.extra = {
      mode: "quantitative",
      quantitative: { composed: true },
    };

    const discovered = discoverCanvasLoops(nodes, declared, { manifest });
    expect(discovered.analysisError).toMatch(/arrayed|subsystem|composed/);
    expect(discovered.loops).toHaveLength(1);
    expect(discovered.loops[0].canvasPath).toBeDefined();
    expect(loopsForMode(discovered.loops, "sfd")).toHaveLength(1);
  });

  it("keeps unresolved qualitative badges in CLD but fails SFD closed", () => {
    const stock = variable("stock", "Stock", "stock", 0, 0);
    stock.links = [link("drain", "+")];
    const drain = variable("drain", "Drain", "flow", 180, 0, {
      flow: { from: "stock", to: "~sink" },
    });
    drain.links = [link("stock", "+")];
    const nodes = [stock, drain];
    const declared = new LoopGraph(nodes).detectLoops();
    expect(declared).toHaveLength(1);

    const discovered = discoverCanvasLoops(nodes, declared, {
      manifest: qualitativeGraph(nodes, declared).manifest,
    });
    expect(discovered.loops).toHaveLength(1);
    expect(discovered.loops[0].canvasPath).toBeUndefined();
    expect(loopsForMode(discovered.loops, "cld")).toHaveLength(1);
    expect(loopsForMode(discovered.loops, "sfd")).toHaveLength(0);
    expect(
      retainedLoopKeyForMode(discovered.loops, discovered.loops[0].key, "cld"),
    ).toBe(discovered.loops[0].key);
    expect(
      retainedLoopKeyForMode(discovered.loops, discovered.loops[0].key, "sfd"),
    ).toBeNull();
  });
});
