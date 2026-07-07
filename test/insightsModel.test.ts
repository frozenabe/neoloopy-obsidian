import { describe, expect, it } from "vitest";
import { GraphView, VariableFile, emptyVariable } from "@neoloopy/cld-canvas";
import {
  INSIGHT_DESTINATIONS,
  modelHealthChecks,
  resolveInsightDestination,
} from "../src/engine/insightsModel";

function node(id: string, label: string, type: VariableFile["type"] = "auxiliary"): VariableFile {
  return { ...emptyVariable(id, label), type };
}

function graph(nodes: VariableFile[]): GraphView {
  return { nodes, loops: [], labels: new Map() } as unknown as GraphView;
}

describe("Insights destinations", () => {
  it("keeps the app-style qualitative destinations in order", () => {
    expect(INSIGHT_DESTINATIONS).toEqual(["structure", "loops", "docs", "health"]);
  });

  it("falls back to the first visible destination when active is unavailable", () => {
    expect(resolveInsightDestination("loops", ["structure", "health"])).toBe("structure");
  });
});

describe("modelHealthChecks", () => {
  it("reports disconnected variables and unwired flows offline", () => {
    const checks = modelHealthChecks(graph([
      node("a", "A"),
      node("f", "Flow", "flow"),
    ]));
    expect(checks.map((c) => c.label)).toContain("Disconnected variables");
    expect(checks.map((c) => c.label)).toContain("Flows without explicit pipes");
  });

  it("reports invalid explicit flow endpoints", () => {
    const f = {
      ...node("f", "Flow", "flow"),
      extra: { flow: { from: "missing", to: "~sink" } },
    };
    const checks = modelHealthChecks(graph([f]));
    expect(checks.find((c) => c.label === "Invalid flow endpoints")?.detail).toContain("missing");
  });

  it("returns a pass row when local checks find no issue", () => {
    const s = node("s", "Stock", "stock");
    const f = {
      ...node("f", "Flow", "flow"),
      extra: { flow: { from: "s", to: "~sink" } },
      links: [{ to: "s", polarity: "+", delay: false, indirect: false, nonlinear: false }],
    } satisfies VariableFile;
    expect(modelHealthChecks(graph([s, f]))).toEqual([
      {
        severity: "info",
        label: "No local health issues",
        detail: "Structure checks passed in the plugin.",
      },
    ]);
  });
});
