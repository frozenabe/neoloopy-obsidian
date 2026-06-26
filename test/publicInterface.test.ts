import { describe, it, expect } from "vitest";
import {
  emptyVariable,
  VariableFile,
  quantVisibility,
  isPublicInput,
  isPublicOutput,
  quantInputBindings,
  qualifiedRef,
} from "@neoloopy/cld-canvas";

function withQuant(quant: Record<string, unknown>): VariableFile {
  return { ...emptyVariable("v", "V"), extra: { quant } };
}

describe("quantVisibility", () => {
  it("reads input / output, defaulting to null (private)", () => {
    expect(quantVisibility(withQuant({ visibility: "input" }))).toBe("input");
    expect(quantVisibility(withQuant({ visibility: "output" }))).toBe("output");
    expect(quantVisibility(withQuant({}))).toBeNull();
    expect(quantVisibility(emptyVariable("v", "V"))).toBeNull();
  });

  it("treats an unrecognized or blank value as private", () => {
    expect(quantVisibility(withQuant({ visibility: "public" }))).toBeNull();
    expect(quantVisibility(withQuant({ visibility: "  " }))).toBeNull();
  });

  it("isPublicInput / isPublicOutput reflect the visibility", () => {
    expect(isPublicInput(withQuant({ visibility: "input" }))).toBe(true);
    expect(isPublicOutput(withQuant({ visibility: "input" }))).toBe(false);
    expect(isPublicOutput(withQuant({ visibility: "output" }))).toBe(true);
    expect(isPublicInput(emptyVariable("v", "V"))).toBe(false);
  });
});

describe("quantInputBindings", () => {
  it("reads the list of {child, target, expr} bindings", () => {
    const v = withQuant({
      inputBindings: [
        { child: "Rework", target: "Effort", expr: "Staff * 0.5" },
        { child: "Rework", target: "Quota" }, // expr missing -> ""
      ],
    });
    expect(quantInputBindings(v)).toEqual([
      { child: "Rework", target: "Effort", expr: "Staff * 0.5" },
      { child: "Rework", target: "Quota", expr: "" },
    ]);
  });

  it("returns [] when absent or malformed", () => {
    expect(quantInputBindings(emptyVariable("v", "V"))).toEqual([]);
    expect(quantInputBindings(withQuant({ inputBindings: "nope" }))).toEqual([]);
  });
});

describe("qualifiedRef", () => {
  it("brackets a label with a space, leaves a simple label bare", () => {
    expect(qualifiedRef("Rework", "Defect Rate")).toBe("Rework.[Defect Rate]");
    expect(qualifiedRef("Rework", "Effort")).toBe("Rework.Effort");
  });
});
