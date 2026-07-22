import { describe, expect, it } from "vitest";
import { DetectedLoop, LoopType, Scene } from "@neoloopy/cld-canvas";
import {
  keyboardSelectableEdges,
  keyboardSelectableLoopKeys,
} from "../src/view/keyboardVisibility";

function scene(overrides: Partial<Scene>): Scene {
  return {
    mode: "cld",
    nodes: [],
    boxes: new Map(),
    edges: [],
    pipes: [],
    loops: [],
    labels: new Map(),
    badges: new Map(),
    ...overrides,
  };
}

describe("keyboard navigation follows visible editable canvas topology", () => {
  it("never exposes a render-only CLD material projection as an editable edge", () => {
    const authored = {
      id: "stock__drain",
      source: "stock",
      target: "drain",
      link: { to: "drain", polarity: "+", delay: false, indirect: false, nonlinear: false },
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      mid: { x: 0.5, y: 0.5 },
      arrowTip: { x: 1, y: 1 },
      arrowAngle: 0,
      delay: { x: 0, y: 0 },
      delayAngle: 0,
      nl: { x: 0, y: 0 },
      nlAngle: 0,
    } as Scene["edges"][number];
    const projection = {
      ...authored,
      id: "__cld_material_projection__5:drain:5:stock",
      source: "drain",
      target: "stock",
      renderOnly: true,
    };
    const current = scene({ edges: [authored, projection] });

    expect(keyboardSelectableEdges(current, null).map((edge) => edge.id)).toEqual([
      "stock__drain",
    ]);
    expect(keyboardSelectableEdges(current, "drain").map((edge) => edge.id)).toEqual([
      "stock__drain",
    ]);
  });

  it("cycles only loop badges present in the current CLD/SFD scene", () => {
    const qualitativeOnly = new DetectedLoop(["a", "b"], LoopType.reinforcing);
    const material = new DetectedLoop(
      ["stock", "drain"],
      LoopType.balancing,
      undefined,
      "quantitative",
    );
    const sfd = scene({ mode: "sfd", loops: [material] });

    expect(keyboardSelectableLoopKeys(sfd)).toEqual([material.key]);
    expect(keyboardSelectableLoopKeys(sfd)).not.toContain(qualitativeOnly.key);
  });
});
