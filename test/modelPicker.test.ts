import { describe, expect, it } from "vitest";
import { ModelRef } from "@neoloopy/cld-canvas";
import { reconcileActiveModel } from "../src/view/modelPicker";

const ref = (folder: string, name = folder): ModelRef => ({
  id: folder,
  name,
  folder,
  group: null,
  modified: "2026-06-19T00:00:00.000Z",
  variableCount: 0,
  quant: false,
});

describe("reconcileActiveModel", () => {
  it("keeps the open model when it still exists", () => {
    const models = [ref("alpha"), ref("beta")];
    expect(reconcileActiveModel(models, "beta")).toEqual({ action: "keep" });
  });

  it("switches to the first remaining model when the open one was deleted", () => {
    // alpha was the open model and is gone; beta/gamma remain (sorted by name).
    const models = [ref("beta"), ref("gamma")];
    expect(reconcileActiveModel(models, "alpha")).toEqual({
      action: "switch",
      folder: "beta",
    });
  });

  it("clears when the open model was the last one deleted", () => {
    expect(reconcileActiveModel([], "alpha")).toEqual({ action: "clear" });
  });

  it("does nothing when no model is open (external change with empty canvas)", () => {
    expect(reconcileActiveModel([ref("alpha")], null)).toEqual({ action: "keep" });
  });
});
