import { describe, expect, it } from "vitest";
import {
  DetectedLoop,
  GraphView,
  LoopType,
  VariableFile,
  emptyVariable,
} from "@neoloopy/cld-canvas";
import {
  INSIGHT_DESTINATIONS,
  modelHealthChecks,
  loopAnalysisWarning,
  loopEmptyStateMessage,
  loopReportMessage,
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

  it("never presents incomplete quantitative analysis as zero loops", () => {
    const incomplete = {
      ...graph([]),
      analysisError: "quant-loop-analysis-incomplete: unsupported topology",
    };
    expect(loopAnalysisWarning(incomplete)).toContain("incomplete");
    expect(loopAnalysisWarning(incomplete)).toContain("No partial quantitative badges");
    expect(loopAnalysisWarning(graph([]))).toBeNull();
  });

  it("qualifies a non-empty qualitative report when quantitative analysis is incomplete", () => {
    const loop = {
      nodeIds: ["a", "b"],
      type: 0,
      key: "0:a|b",
    };
    const incomplete = {
      ...graph([]),
      loops: [loop],
      labels: new Map([[loop.key, "R1"]]),
      analysisError: "quant-loop-analysis-incomplete: unsupported topology",
    } as unknown as GraphView;
    expect(loopReportMessage(incomplete)).toContain("1 loop: R1");
    expect(loopReportMessage(incomplete)).toContain("analysis is incomplete");
  });

  it("distinguishes an unresolved SFD representation from a true zero-loop model", () => {
    const zero = graph([]);
    expect(loopEmptyStateMessage(zero, "cld")).toBe(
      "No feedback loops detected.",
    );
    expect(loopEmptyStateMessage(zero, "sfd")).toBe(
      "No feedback loops detected.",
    );

    const unresolved = new DetectedLoop(
      ["a", "b"],
      LoopType.reinforcing,
    );
    const withDeclaredLoop = {
      ...zero,
      loops: [unresolved],
    };
    expect(loopEmptyStateMessage(withDeclaredLoop, "cld")).toBeNull();
    expect(loopEmptyStateMessage(withDeclaredLoop, "sfd")).toBe(
      "No complete loop representation is available in SFD.",
    );
    expect(
      loopEmptyStateMessage(
        { ...withDeclaredLoop, analysisError: "quant analysis incomplete" },
        "sfd",
      ),
    ).toBe("No complete loop representation is available in SFD.");
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
