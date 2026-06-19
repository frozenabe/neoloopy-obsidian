import { describe, it, expect } from "vitest";
import { kReferenceShapes, normReferencePattern, referenceSeries } from "../src/engine/referenceShapes";

describe("normReferencePattern", () => {
  it("normalizes case/underscores/spaces to the canonical key", () => {
    expect(normReferencePattern("S_Shaped")).toBe("s-shaped");
    expect(normReferencePattern("  Growth ")).toBe("growth");
  });
  it("resolves known aliases", () => {
    expect(normReferencePattern("logistic")).toBe("s-shaped");
    expect(normReferencePattern("exponential")).toBe("growth");
    expect(normReferencePattern("decay")).toBe("decline");
  });
  it("returns null for unknown / nullish", () => {
    expect(normReferencePattern("nonsense")).toBeNull();
    expect(normReferencePattern(null)).toBeNull();
  });
});

describe("referenceSeries", () => {
  it("explicit points win over a pattern", () => {
    expect(referenceSeries("growth", [1, 2, 3])).toEqual([1, 2, 3]);
  });
  it("maps a known pattern to its canonical curve", () => {
    expect(referenceSeries("growth")).toEqual(kReferenceShapes["growth"]);
  });
  it("maps an alias to its canonical curve", () => {
    expect(referenceSeries("sigmoid")).toEqual(kReferenceShapes["s-shaped"]);
  });
  it("returns empty for an unknown pattern and no points", () => {
    expect(referenceSeries("nonsense")).toEqual([]);
    expect(referenceSeries()).toEqual([]);
  });
});
