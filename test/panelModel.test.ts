import { describe, it, expect } from "vitest";
import {
  stockGoverningFlow,
  perElementInitial,
  equationRefs,
  distinctUnits,
  equationModalModel,
  referenceModeRows,
} from "../src/engine/panelModel";
import { emptyVariable, manifestFromJson, VariableFile, VaultLink } from "../src/engine/types";
import { kReferenceShapes } from "../src/engine/referenceShapes";

function stock(id: string, label: string, quant: Record<string, unknown> = {}): VariableFile {
  return { ...emptyVariable(id, label), type: "stock", extra: { quant } };
}

function flow(id: string, label: string, to: string, polarity: "+" | "-"): VariableFile {
  const link: VaultLink = { to, polarity, delay: false, indirect: false, nonlinear: false };
  return { ...emptyVariable(id, label), type: "flow", links: [link] };
}

describe("stockGoverningFlow", () => {
  it("derives a stock's net flow from its wired inflows and outflows", () => {
    const s = stock("pop", "Population", { initial: 100 });
    const births = flow("b", "Births", "pop", "+");
    const deaths = flow("d", "Deaths", "pop", "-");
    expect(stockGoverningFlow(s, [s, births, deaths])).toBe("+ Births − Deaths");
  });

  it("returns undefined for a stock with no flows wired", () => {
    const s = stock("w", "Water", { equation: "inflow - outflow" });
    expect(stockGoverningFlow(s, [s])).toBeUndefined();
  });

  it("returns undefined for a non-stock", () => {
    const drain = flow("d", "Drain", "pop", "-");
    expect(stockGoverningFlow(drain, [drain])).toBeUndefined();
  });
});

describe("perElementInitial", () => {
  it("formats a subscripted initial map as element arrows", () => {
    expect(perElementInitial("young: 10, old: 0")).toBe("young → 10 · old → 0");
  });

  it("uses semicolons as the separator when present", () => {
    expect(perElementInitial("a:1; b:2; c:3")).toBe("a → 1 · b → 2 · c → 3");
  });

  it("returns undefined for a plain scalar", () => {
    expect(perElementInitial("100")).toBeUndefined();
  });
});

describe("equationRefs", () => {
  it("returns referenced model variables in model order", () => {
    expect(equationRefs("Deaths + Births", ["Births", "Deaths", "Pop"]))
      .toEqual({ referenced: ["Births", "Deaths"], unknown: [] });
  });

  it("matches variable names case-insensitively", () => {
    expect(equationRefs("population / 10", ["Population"]))
      .toEqual({ referenced: ["Population"], unknown: [] });
  });

  it("flags identifiers that match no variable as unknown", () => {
    expect(equationRefs("Susceptible * beta", ["Susceptible"]))
      .toEqual({ referenced: ["Susceptible"], unknown: ["beta"] });
  });

  it("treats identifiers followed by ( as function calls and ignores them", () => {
    expect(equationRefs("MIN(Stock, 5)", ["Stock"]))
      .toEqual({ referenced: ["Stock"], unknown: [] });
  });

  it("returns empty for a blank equation", () => {
    expect(equationRefs("   ", ["A"])).toEqual({ referenced: [], unknown: [] });
  });

  it("dedupes repeated references and unknowns", () => {
    expect(equationRefs("a + a - b - b", ["a"]))
      .toEqual({ referenced: ["a"], unknown: ["b"] });
  });
});

describe("distinctUnits", () => {
  it("dedupes, trims, drops blanks, and sorts case-insensitively", () => {
    expect(distinctUnits(["people", "", "Year", "people", null, " day "]))
      .toEqual(["day", "people", "Year"]);
  });

  it("uses a deterministic tiebreak for case-equal units", () => {
    expect(distinctUnits(["a", "A"])).toEqual(["A", "a"]);
  });
});

describe("equationModalModel", () => {
  it("models a flow's equation, its referenced variables, and unit suggestions", () => {
    const water = stock("w", "Water", { initial: "100", units: "L" });
    const drain: VariableFile = {
      ...flow("d", "Drain", "w", "-"),
      extra: { quant: { equation: "Water / 10", units: "L/min" } },
    };
    const m = equationModalModel(drain, [water, drain]);
    expect(m.title).toBe("Drain");
    expect(m.isStock).toBe(false);
    expect(m.primaryLabel).toBe("Equation");
    expect(m.primaryValue).toBe("Water / 10");
    expect(m.governingFlow).toBeUndefined();
    expect(m.perElement).toBeUndefined();
    expect(m.referenced).toEqual(["Water"]);
    expect(m.unknown).toEqual([]);
    expect(m.units).toBe("L/min");
    expect(m.unitSuggestions).toEqual(["L", "L/min"]);
  });

  it("models a stock's initial, per-element hint, and governing flow", () => {
    const pop = stock("pop", "Population", { initial: "young: 10, old: 0", units: "people" });
    const births = flow("b", "Births", "pop", "+");
    const deaths = flow("d", "Deaths", "pop", "-");
    const m = equationModalModel(pop, [pop, births, deaths]);
    expect(m.isStock).toBe(true);
    expect(m.primaryLabel).toBe("Initial value");
    expect(m.primaryValue).toBe("young: 10, old: 0");
    expect(m.perElement).toBe("young → 10 · old → 0");
    expect(m.governingFlow).toBe("Population′ = + Births − Deaths");
    // A per-element map is not an expression — its keys are not variable refs.
    expect(m.referenced).toEqual([]);
    expect(m.unknown).toEqual([]);
  });

  it("does not analyze a plain numeric stock initial as an expression", () => {
    const s = stock("w", "Water", { initial: "100" });
    const m = equationModalModel(s, [s]);
    expect(m.perElement).toBeUndefined();
    expect(m.governingFlow).toBeUndefined();
    expect(m.referenced).toEqual([]);
    expect(m.unknown).toEqual([]);
  });

  it("returns blank values for a node with no quant block", () => {
    const plain = emptyVariable("x", "Plain");
    const m = equationModalModel(plain, [plain]);
    expect(m.primaryValue).toBe("");
    expect(m.units).toBe("");
    expect(m.referenced).toEqual([]);
  });
});

describe("referenceModeRows", () => {
  it("builds a row with the pattern's curve and a humanized label", () => {
    const m = manifestFromJson({ id: "m", name: "M", referenceModes: [{ variable: "Pop", pattern: "s-shaped" }] });
    const rows = referenceModeRows(m);
    expect(rows).toHaveLength(1);
    expect(rows[0].variable).toBe("Pop");
    expect(rows[0].series).toEqual(kReferenceShapes["s-shaped"]);
    expect(rows[0].label).toBe("s shaped");
  });

  it("prefers an explicit note as the label and explicit points as the series", () => {
    const m = manifestFromJson({ id: "m", name: "M", referenceModes: [{ variable: "Pop", points: [0, 0.5, 1], note: "measured" }] });
    expect(referenceModeRows(m)[0]).toMatchObject({ variable: "Pop", label: "measured", series: [0, 0.5, 1] });
  });

  it("returns [] when there are no reference modes", () => {
    expect(referenceModeRows(manifestFromJson({ id: "m", name: "M" }))).toEqual([]);
  });
});
