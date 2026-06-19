import { describe, expect, it } from "vitest";
import { DetectedLoop, LoopType, VariableFile, emptyVariable } from "../src/engine/types";
import { GraphView } from "../src/engine/engine";
import { Camera } from "../src/view/camera";
import { buildNodeBoxes } from "../src/view/geometry";
import { SceneCache } from "../src/view/sceneCache";

function node(id: string, x: number, y: number, label = id, links: { to: string; curvature?: number }[] = []): VariableFile {
  return {
    ...emptyVariable(id, label),
    x,
    y,
    links: links.map((l) => ({ to: l.to, polarity: "+", delay: false, indirect: false, nonlinear: false, curvature: l.curvature })),
  };
}

function graph(nodes: VariableFile[], loops: DetectedLoop[] = []): GraphView {
  const labels = new Map(loops.map((l, i) => [l.key, `R${i + 1}`]));
  return { nodes, loops, labels } as unknown as GraphView;
}

const noBow = () => new Map<string, number>();
const noOverrides = () => new Map<string, { x: number; y: number }>();

describe("SceneCache.build — output", () => {
  it("matches a direct geometry build (boxes), pinning the old rebuildScene", () => {
    const nodes = [node("a", 0, 0, "Apple"), node("b", 200, 0, "Banana", [{ to: "a" }])];
    const measurer = (s: string) => s.length * 10;
    const cache = new SceneCache(measurer);
    const scene = cache.build(graph(nodes), noBow(), noOverrides());

    const expected = buildNodeBoxes(nodes, measurer);
    expect(scene).not.toBeNull();
    for (const [id, box] of expected) {
      expect(scene!.boxes.get(id)).toEqual(box);
    }
    expect(scene!.nodes).toBe(nodes);
  });

  it("null graph → null scene", () => {
    const cache = new SceneCache((s) => s.length);
    expect(cache.build(null, noBow(), noOverrides())).toBeNull();
  });
});

describe("SceneCache.build — label-width memo", () => {
  it("measures each distinct label once, even across rebuilds", () => {
    const calls: string[] = [];
    const measurer = (s: string) => {
      calls.push(s);
      return s.length * 10;
    };
    const cache = new SceneCache(measurer);
    const nodes = [node("a", 0, 0, "Apple"), node("b", 200, 0, "Banana")];
    const g = graph(nodes);

    cache.build(g, noBow(), noOverrides());
    expect(calls).toEqual(["Apple", "Banana"]);

    // Move a node: the signature changes (forces a rebuild) but labels do not,
    // so no label is measured a second time.
    nodes[0].x = 50;
    cache.build(g, noBow(), noOverrides());
    expect(calls).toEqual(["Apple", "Banana"]);

    // Rename: the new label is measured once, the unchanged one stays memoized.
    nodes[0].label = "Cherry";
    cache.build(g, noBow(), noOverrides());
    expect(calls).toEqual(["Apple", "Banana", "Cherry"]);
  });
});

describe("SceneCache.build — dirty-tracking", () => {
  it("returns the same Scene by reference when nothing changed", () => {
    const cache = new SceneCache((s) => s.length * 10);
    const g = graph([node("a", 0, 0), node("b", 200, 0)]);
    const first = cache.build(g, noBow(), noOverrides());
    const second = cache.build(g, noBow(), noOverrides());
    expect(second).toBe(first);
  });

  it("settles to the cached Scene on the very next call with a persistent bowSigns map", () => {
    // Production hands the *same* bowSigns map to every build; the first build
    // freezes bow signs into it. The cache must still hit on the next unchanged
    // call (not waste a settling rebuild because its own mutation moved the sig).
    const cache = new SceneCache((s) => s.length * 10);
    const g = graph([node("a", 0, 0, "a", [{ to: "b" }]), node("b", 200, 120, "b")]);
    const bow = noBow();
    const first = cache.build(g, bow, noOverrides());
    expect(bow.size).toBeGreaterThan(0); // build froze at least one bow sign
    const second = cache.build(g, bow, noOverrides());
    expect(second).toBe(first);
  });

  it("rebuilds when a node position changes", () => {
    const cache = new SceneCache((s) => s.length * 10);
    const nodes = [node("a", 0, 0), node("b", 200, 0)];
    const g = graph(nodes);
    const first = cache.build(g, noBow(), noOverrides());
    nodes[0].x = 80;
    const second = cache.build(g, noBow(), noOverrides());
    expect(second).not.toBe(first);
    expect(second!.boxes.get("a")!.cx).toBe(80);
  });

  it("rebuilds when a link curvature changes (a bow drag, same graph object)", () => {
    const cache = new SceneCache((s) => s.length * 10);
    const nodes = [node("a", 0, 0, "a", [{ to: "b", curvature: 0 }]), node("b", 200, 0)];
    const g = graph(nodes);
    const first = cache.build(g, noBow(), noOverrides());
    nodes[0].links[0].curvature = 40;
    const second = cache.build(g, noBow(), noOverrides());
    expect(second).not.toBe(first);
  });

  it("rebuilds when a badge override moves", () => {
    const loop: DetectedLoop = { key: "R:a|b", nodeIds: ["a", "b"], type: LoopType.reinforcing };
    const cache = new SceneCache((s) => s.length * 10);
    const g = graph([node("a", 0, 0, "a", [{ to: "b" }]), node("b", 200, 0, "b", [{ to: "a" }])], [loop]);
    const overrides = noOverrides();
    const first = cache.build(g, noBow(), overrides);
    overrides.set("R:a|b", { x: 10, y: 10 });
    const second = cache.build(g, noBow(), overrides);
    expect(second).not.toBe(first);
  });

  it("rebuilds for a fresh graph object even with identical content", () => {
    const cache = new SceneCache((s) => s.length * 10);
    const make = () => graph([node("a", 0, 0), node("b", 200, 0)]);
    const first = cache.build(make(), noBow(), noOverrides());
    const second = cache.build(make(), noBow(), noOverrides());
    expect(second).not.toBe(first);
  });

  it("invalidate() forces the next build to recompute", () => {
    const cache = new SceneCache((s) => s.length * 10);
    const g = graph([node("a", 0, 0)]);
    const first = cache.build(g, noBow(), noOverrides());
    cache.invalidate();
    const second = cache.build(g, noBow(), noOverrides());
    expect(second).not.toBe(first);
  });
});

describe("SceneCache.fit", () => {
  it("returns false with no scene, no nodes, or a zero viewport", () => {
    const cache = new SceneCache((s) => s.length * 10);
    const cam = new Camera();
    expect(cache.fit(cam, 800, 600)).toBe(false); // no build yet

    cache.build(graph([]), noBow(), noOverrides());
    expect(cache.fit(cam, 800, 600)).toBe(false); // empty boxes

    cache.build(graph([node("a", 0, 0)]), noBow(), noOverrides());
    expect(cache.fit(cam, 0, 600)).toBe(false); // zero width
  });

  it("fits the camera to the scene bounds", () => {
    const cache = new SceneCache((s) => s.length * 10);
    const cam = new Camera();
    cache.build(graph([node("a", 0, 0), node("b", 400, 200)]), noBow(), noOverrides());
    const before = { tx: cam.tx, ty: cam.ty, scale: cam.scale };
    expect(cache.fit(cam, 800, 600)).toBe(true);
    expect({ tx: cam.tx, ty: cam.ty, scale: cam.scale }).not.toEqual(before);
  });
});
