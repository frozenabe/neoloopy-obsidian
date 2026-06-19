import { describe, it, expect } from "vitest";
import { LoopGraph, labelLoopsByKey } from "../src/engine/loopGraph";
import { VariableFile, VaultLink, LoopType, emptyVariable } from "../src/engine/types";

type LinkSpec = [to: string, polarity: "+" | "-", indirect?: boolean];

function v(id: string, links: LinkSpec[] = []): VariableFile {
  const ls: VaultLink[] = links.map(([to, polarity, indirect]) => ({
    to,
    polarity,
    delay: false,
    indirect: indirect ?? false,
    nonlinear: false,
  }));
  return { ...emptyVariable(id, id), links: ls };
}

describe("loop detection — classification", () => {
  it("two same-sign links form a reinforcing loop", () => {
    const g = new LoopGraph([v("a", [["b", "+"]]), v("b", [["a", "+"]])]);
    const loops = g.detectLoops();
    expect(loops).toHaveLength(1);
    expect(loops[0].type).toBe(LoopType.reinforcing);
  });

  it("one opposite-sign link forms a balancing loop", () => {
    const g = new LoopGraph([v("a", [["b", "+"]]), v("b", [["a", "-"]])]);
    const loops = g.detectLoops();
    expect(loops).toHaveLength(1);
    expect(loops[0].type).toBe(LoopType.balancing);
  });

  it("two negative links form a reinforcing loop (even count of -)", () => {
    const g = new LoopGraph([v("a", [["b", "-"]]), v("b", [["a", "-"]])]);
    expect(g.detectLoops()[0].type).toBe(LoopType.reinforcing);
  });

  it("excludes indirect (dashed) links from loop detection", () => {
    const g = new LoopGraph([v("a", [["b", "+"]]), v("b", [["a", "-", true]])]);
    expect(g.detectLoops()).toHaveLength(0);
  });

  it("ignores links pointing at missing nodes", () => {
    const g = new LoopGraph([v("a", [["ghost", "+"]])]);
    expect(g.detectLoops()).toHaveLength(0);
  });

  it("dedups a 3-cycle to one loop regardless of starting node", () => {
    const g = new LoopGraph([
      v("a", [["b", "+"]]),
      v("b", [["c", "+"]]),
      v("c", [["a", "-"]]),
    ]);
    const loops = g.detectLoops();
    expect(loops).toHaveLength(1);
    expect(loops[0].type).toBe(LoopType.balancing); // one '-' => odd => B
    expect(new Set(loops[0].nodeIds)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("loop labelling", () => {
  it("assigns R1/B1 deterministically by sorted variable names", () => {
    // Two independent loops: A-B reinforcing, C-D balancing.
    const g = new LoopGraph([
      v("a", [["b", "+"]]),
      v("b", [["a", "+"]]),
      v("c", [["d", "+"]]),
      v("d", [["c", "-"]]),
    ]);
    const loops = g.detectLoops();
    const labels = labelLoopsByKey(loops, (id) => g.node(id)?.label ?? id);
    const byType = new Map(loops.map((l) => [l.type, labels.get(l.key)]));
    expect(byType.get(LoopType.reinforcing)).toBe("R1");
    expect(byType.get(LoopType.balancing)).toBe("B1");
  });
});

describe("SILS", () => {
  it("returns the loop set unchanged when there is at most one loop", () => {
    const g = new LoopGraph([v("a", [["b", "+"]]), v("b", [["a", "+"]])]);
    expect(g.shortestIndependentLoopSet()).toHaveLength(1);
  });

  it("is a deterministic subset of all detected loops", () => {
    const g = new LoopGraph([
      v("a", [["b", "+"], ["c", "+"]]),
      v("b", [["a", "+"], ["c", "+"]]),
      v("c", [["a", "+"], ["b", "+"]]),
    ]);
    const all = g.detectLoops();
    const sils1 = g.shortestIndependentLoopSet();
    const sils2 = g.shortestIndependentLoopSet();
    expect(sils1.length).toBeGreaterThanOrEqual(1);
    expect(sils1.length).toBeLessThanOrEqual(all.length);
    expect(sils1.map((l) => l.key)).toEqual(sils2.map((l) => l.key));
  });
});

describe("adjacency + metrics", () => {
  it("reverse adjacency flips edges for upstream tracing", () => {
    const g = new LoopGraph([v("a", [["b", "+"]]), v("b", [])]);
    const fwd = g.adjacency(false);
    const rev = g.adjacency(true);
    expect(fwd.get("a")?.map((e) => e.to)).toEqual(["b"]);
    expect(rev.get("b")?.map((e) => e.to)).toEqual(["a"]);
  });

  it("counts in/out degree and loop participation", () => {
    const g = new LoopGraph([v("a", [["b", "+"]]), v("b", [["a", "+"]])]);
    const m = g.metrics();
    expect(m.get("a")).toEqual({ inDegree: 1, outDegree: 1, loopCount: 1 });
  });
});
