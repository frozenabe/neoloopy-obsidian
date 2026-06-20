import { describe, it, expect } from "vitest";
import {
  Camera,
  LIGHT,
  NodeBox,
  PaintUi,
  Scene,
  VariableFile,
  emptyVariable,
  paint,
} from "@neoloopy/cld-canvas";

/**
 * A recording 2D context: method calls are no-ops except `fillText`, whose first
 * argument is captured. `measureText` returns a width proportional to the string
 * length so `fitText` truncates predictably (a wide box avoids truncation here).
 */
function recordingCtx(): { ctx: CanvasRenderingContext2D; texts: string[]; calls: string[] } {
  const texts: string[] = [];
  const calls: string[] = [];
  const store: Record<string, unknown> = {};
  const ctx = new Proxy(store, {
    get(target, prop) {
      if (prop === "measureText") {
        return (s: string) => ({ width: String(s ?? "").length * 6 });
      }
      if (prop in target && typeof target[prop as string] !== "function") {
        return target[prop as string];
      }
      return (...args: unknown[]) => {
        calls.push(prop as string);
        if (prop === "fillText" || prop === "strokeText") texts.push(String(args[0]));
      };
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, calls };
}

const strokeCount = (calls: string[]): number => calls.filter((c) => c === "stroke").length;

function sceneWith(node: VariableFile, w = 160): Scene {
  const box: NodeBox = { id: node.id, cx: 100, cy: 100, w, h: 40, type: node.type };
  return {
    nodes: [node],
    boxes: new Map([[node.id, box]]),
    edges: [],
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
