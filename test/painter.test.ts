import { describe, it, expect } from "vitest";
import {
  Camera,
  CanvasLoopPath,
  DetectedLoop,
  GraphView,
  LIGHT,
  LoopGraph,
  LoopType,
  NodeBox,
  PaintUi,
  Scene,
  VariableFile,
  emptyVariable,
  discoverCanvasLoops,
  loopHighlightFor,
  paint,
  SceneCache,
} from "@neoloopy/cld-canvas";

/**
 * A recording 2D context: method calls are no-ops except `fillText`, whose first
 * argument is captured. `measureText` returns a width proportional to the string
 * length so `fitText` truncates predictably (a wide box avoids truncation here).
 */
function recordingCtx(): {
  ctx: CanvasRenderingContext2D;
  texts: string[];
  calls: string[];
  args: Array<[string, unknown[]]>;
  sets: Array<[string, unknown]>;
} {
  const texts: string[] = [];
  const calls: string[] = [];
  const methodArgs: Array<[string, unknown[]]> = [];
  const sets: Array<[string, unknown]> = [];
  const store: Record<string, unknown> = {};
  const ctx = new Proxy(store, {
    get(target, prop) {
      if (prop === "measureText") {
        return (s: string) => ({ width: String(s ?? "").length * 6 });
      }
      if (prop in target && typeof target[prop as string] !== "function") {
        return target[prop as string];
      }
      return (...callArgs: unknown[]) => {
        calls.push(prop as string);
        methodArgs.push([prop as string, callArgs]);
        if (prop === "fillText" || prop === "strokeText") texts.push(String(callArgs[0]));
      };
    },
    set(target, prop, value) {
      target[prop as string] = value;
      sets.push([prop as string, value]);
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, calls, args: methodArgs, sets };
}

const strokeCount = (calls: string[]): number => calls.filter((c) => c === "stroke").length;

function sceneWith(node: VariableFile, w = 160): Scene {
  const box: NodeBox = { id: node.id, cx: 100, cy: 100, w, h: 40, type: node.type };
  return {
    mode: "cld",
    nodes: [node],
    boxes: new Map([[node.id, box]]),
    edges: [],
    pipes: [],
    loops: [],
    labels: new Map(),
    badges: new Map(),
  };
}

const ui: PaintUi = {
  cssWidth: 400,
  cssHeight: 300,
  dpr: 1,
  selectedNodeId: null,
  selectedEdgeId: null,
  selectedLoopKey: null,
  liveNodeIds: new Set(),
  linkPreview: null,
  connectNodeId: null,
  loopHighlight: null,
  pulsePhase: 0,
  flowPhase: 0,
};

describe("painter — node labels", () => {
  it("draws only the label for a plain qualitative node", () => {
    const { ctx, texts } = recordingCtx();
    paint(ctx, sceneWith(emptyVariable("x", "Plain")), new Camera(), LIGHT, ui);
    expect(texts).toEqual(["Plain"]);
  });

  it("draws no under-node quant caption for a quant node (detail lives in the ƒx modal)", () => {
    const node: VariableFile = {
      ...emptyVariable("pop", "Population"),
      type: "stock",
      extra: { quant: { equation: "births - deaths", initial: 100, units: "people" } },
    };
    const { ctx, texts } = recordingCtx();
    paint(ctx, sceneWith(node), new Camera(), LIGHT, ui);
    expect(texts).toEqual(["Population"]);
  });
});

describe("painter — subsystem mark", () => {
  // Mirrors `_paintSubsystemMark` in app/lib/painters/graph_painter.dart: a node
  // with a `subsystem` link gets a top-left "layers" glyph (a rhombus + a chevron,
  // two extra strokes). Asserted as a differential so it stays coordinate-free.
  const plain = (): VariableFile => emptyVariable("x", "Plain");
  const linked = (): VariableFile => ({ ...emptyVariable("x", "Plain"), subsystem: "[[../Child/System|Child]]" });

  it("draws the layers glyph (two extra strokes) when a subsystem is connected", () => {
    const a = recordingCtx();
    paint(a.ctx, sceneWith(plain()), new Camera(), LIGHT, ui);
    const b = recordingCtx();
    paint(b.ctx, sceneWith(linked()), new Camera(), LIGHT, ui);
    expect(strokeCount(b.calls) - strokeCount(a.calls)).toBe(2);
  });

  it("draws no mark for an empty subsystem string", () => {
    const a = recordingCtx();
    paint(a.ctx, sceneWith(plain()), new Camera(), LIGHT, ui);
    const b = recordingCtx();
    paint(b.ctx, sceneWith({ ...emptyVariable("x", "Plain"), subsystem: "" }), new Camera(), LIGHT, ui);
    expect(strokeCount(b.calls)).toBe(strokeCount(a.calls));
  });
});

describe("painter — CRITICAL quantitative SFD loop state", () => {
  it("paints the resolved Futures R1 badge and full selected state in CLD and SFD", () => {
    const causal = (to: string, curvature?: number) => ({
      to,
      polarity: "+" as const,
      delay: false,
      indirect: false,
      nonlinear: false,
      curvature,
    });
    const birthRate: VariableFile = {
      ...emptyVariable("birth-rate", "BirthRate"),
      x: -120,
      y: 150,
      links: [causal("births")],
      extra: { quant: { equation: "0.03" } },
    };
    const births: VariableFile = {
      ...emptyVariable("births", "Births"),
      type: "flow",
      links: [causal("population")],
      extra: { quant: { equation: "Population * BirthRate" } },
    };
    const population: VariableFile = {
      ...emptyVariable("population", "Population"),
      type: "stock",
      x: 300,
      links: [causal("births", -66)],
      extra: { quant: { initial: "100" } },
    };
    const nodes = [birthRate, births, population];
    const resolved = discoverCanvasLoops(nodes, new LoopGraph(nodes).detectLoops());
    expect(resolved.analysisError).toBeNull();
    expect(resolved.loops).toHaveLength(1);
    const loop = resolved.loops[0];
    const graph = {
      nodes,
      loops: [loop],
      labels: new Map([[loop.key, "R1"]]),
    } as unknown as GraphView;
    const cache = new SceneCache((label) => label.length * 8);
    const cldScene = cache.build(graph, new Map(), new Map(), "cld")!;
    const sfdScene = cache.build(graph, new Map(), new Map(), "sfd")!;
    const selectedUi = {
      ...ui,
      selectedLoopKey: loop.key,
      loopHighlight: loopHighlightFor(loop),
    };

    const cld = recordingCtx();
    paint(cld.ctx, cldScene, new Camera(), LIGHT, selectedUi);
    const sfd = recordingCtx();
    paint(sfd.ctx, sfdScene, new Camera(), LIGHT, selectedUi);

    expect(cld.texts).toContain("R1");
    expect(sfd.texts).toContain("R1");
    expect(cld.sets).toContainEqual(["strokeStyle", LIGHT.teal]);
    expect(sfd.sets).toContainEqual(["strokeStyle", LIGHT.teal]);
    expect(cld.sets).toContainEqual(["globalAlpha", 0.16]);
    expect(sfd.sets).toContainEqual(["globalAlpha", 0.16]);
    expect(sfd.args).toContainEqual(["setLineDash", [[7, 6]]]);
  });

  it("paints the selected material leg amber while the unrelated cloud leg recedes", () => {
    const stock: VariableFile = {
      ...emptyVariable("stock", "Storage"),
      type: "stock",
      x: 0,
      y: 0,
      links: [{
        to: "drain", polarity: "+", delay: false, indirect: false, nonlinear: false,
      }],
      extra: { quant: { initial: "100" } },
    };
    const drain: VariableFile = {
      ...emptyVariable("drain", "Drain"),
      type: "flow",
      x: 160,
      y: 0,
      extra: {
        quant: { equation: "Storage / 10" },
        flow: { from: "stock", to: "~sink" },
      },
    };
    const loop = new DetectedLoop(
      ["drain", "stock"],
      LoopType.balancing,
      new CanvasLoopPath([
        {
          kind: "material", fromNodeId: "drain", toNodeId: "stock",
          flowId: "drain", stockId: "stock", cldEdgeId: "projection", polarity: -1,
        },
        {
          kind: "causal", fromNodeId: "stock", toNodeId: "drain",
          edgeId: "stock__drain", polarity: 1,
        },
      ]),
      "quantitative",
    );
    const graph = {
      nodes: [stock, drain], loops: [loop], labels: new Map([[loop.key, "B1"]]),
    } as unknown as GraphView;
    const scene = new SceneCache((label) => label.length * 8).build(
      graph, new Map(), new Map(), "sfd",
    )!;
    const cldScene = new SceneCache((label) => label.length * 8).build(
      graph, new Map(), new Map(), "cld",
    )!;

    const normal = recordingCtx();
    paint(normal.ctx, scene, new Camera(), LIGHT, ui);
    const cld = recordingCtx();
    paint(cld.ctx, cldScene, new Camera(), LIGHT, ui);
    const selected = recordingCtx();
    paint(selected.ctx, scene, new Camera(), LIGHT, {
      ...ui,
      selectedLoopKey: loop.key,
      loopHighlight: loopHighlightFor(loop),
    });

    expect(normal.sets).not.toContainEqual(["strokeStyle", LIGHT.amber]);
    expect(selected.sets).toContainEqual(["strokeStyle", LIGHT.amber]);
    expect(normal.sets).not.toContainEqual(["globalAlpha", 0.16]);
    expect(selected.sets).toContainEqual(["globalAlpha", 0.16]);
    expect(normal.args).not.toContainEqual(["setLineDash", [[7, 6]]]);
    expect(selected.args).toContainEqual(["setLineDash", [[7, 6]]]);
    expect(cld.texts).toContain("B1");
    expect(normal.texts).toContain("B1");
    expect(selected.texts).toContain("B1");
  });
});
