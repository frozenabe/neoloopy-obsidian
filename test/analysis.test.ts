import { describe, it, expect } from "vitest";
import { endogeneity } from "../src/engine/analysis";
import { LoopGraph } from "../src/engine/loopGraph";
import { VariableFile, VaultLink, emptyVariable } from "../src/engine/types";

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
const loopsOf = (nodes: VariableFile[]) => new LoopGraph(nodes).detectLoops();

describe("endogeneity", () => {
  it("a driver→sink pair: a is exogenous, both are open-loop, none in a loop", () => {
    const nodes = [v("a", [["b", "+"]]), v("b")];
    const r = endogeneity(nodes, loopsOf(nodes));
    expect(r.total).toBe(2);
    expect(r.inLoop).toBe(0);
    expect(r.exogenous).toEqual(["a"]);
    expect(new Set(r.openLoop)).toEqual(new Set(["a", "b"]));
  });

  it("a 2-cycle has both nodes in-loop, none exogenous/open", () => {
    const nodes = [v("a", [["b", "+"]]), v("b", [["a", "+"]])];
    const r = endogeneity(nodes, loopsOf(nodes));
    expect(r.inLoop).toBe(2);
    expect(r.exogenous).toEqual([]);
    expect(r.openLoop).toEqual([]);
  });

  it("a loop plus an external driver: driver is exogenous and open-loop", () => {
    const nodes = [v("a", [["b", "+"]]), v("b", [["a", "+"]]), v("c", [["a", "+"]])];
    const r = endogeneity(nodes, loopsOf(nodes));
    expect(r.inLoop).toBe(2);
    expect(r.exogenous).toEqual(["c"]);
    expect(r.openLoop).toEqual(["c"]);
  });
});
