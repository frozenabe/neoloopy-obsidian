import { describe, it, expect } from "vitest";
import {
  ModelKey,
  VariableFile,
  deriveParentAnchors,
  emptyVariable,
  linkPointsToModel,
  parseSubsystemLink,
} from "@neoloopy/cld-canvas";

function node(id: string, label: string, subsystem?: string): VariableFile {
  return { ...emptyVariable(id, label), subsystem };
}

describe("parseSubsystemLink", () => {
  it("extracts dir + alias from a full wikilink", () => {
    expect(parseSubsystemLink("[[../recovery-dynamics/System|Recovery Dynamics]]")).toEqual({
      dir: "recovery-dynamics",
      alias: "Recovery Dynamics",
    });
  });
  it("handles a bare target with no alias", () => {
    expect(parseSubsystemLink("recovery-dynamics/System")).toEqual({ dir: "recovery-dynamics", alias: null });
  });
  it("returns nulls for empty input", () => {
    expect(parseSubsystemLink("")).toEqual({ dir: null, alias: null });
  });
});

describe("linkPointsToModel", () => {
  const target: ModelKey = { folder: "models/recovery-dynamics", name: "Recovery Dynamics" };
  it("matches by folder basename", () => {
    expect(linkPointsToModel("[[../recovery-dynamics/System|Whatever]]", target)).toBe(true);
  });
  it("matches by model-name alias", () => {
    expect(linkPointsToModel("[[../other/System|Recovery Dynamics]]", target)).toBe(true);
  });
  it("does not match an unrelated link", () => {
    expect(linkPointsToModel("[[../growth/System|Growth]]", target)).toBe(false);
  });
});

describe("deriveParentAnchors", () => {
  const current: ModelKey = { folder: "models/child", name: "Child" };
  const A: ModelKey = { folder: "models/parent-a", name: "Parent A" };
  const B: ModelKey = { folder: "models/parent-b", name: "Parent B" };
  const reader = (map: Record<string, VariableFile[]>) => async (folder: string) => map[folder] ?? [];

  it("finds a single parent anchor", async () => {
    const out = await deriveParentAnchors(current, [A], reader({
      "models/parent-a": [node("v1", "Sector", "[[../child/System|Child]]"), node("v2", "Other")],
    }));
    expect(out).toEqual([
      { modelFolder: "models/parent-a", modelName: "Parent A", anchorVarId: "v1", anchorVarLabel: "Sector" },
    ]);
  });
  it("finds multiple parents", async () => {
    const out = await deriveParentAnchors(current, [A, B], reader({
      "models/parent-a": [node("v1", "A-anchor", "[[../child/System|Child]]")],
      "models/parent-b": [node("v9", "B-anchor", "[[../child/System|Child]]")],
    }));
    expect(out.map((p) => p.modelFolder).sort()).toEqual(["models/parent-a", "models/parent-b"]);
  });
  it("returns empty when nothing links down", async () => {
    const out = await deriveParentAnchors(current, [A], reader({
      "models/parent-a": [node("v1", "x", "[[../growth/System|Growth]]")],
    }));
    expect(out).toEqual([]);
  });
});
