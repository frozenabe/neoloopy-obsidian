import {
  GraphView,
  VariableFile,
  flowOf,
  validateFlowEndpoints,
} from "@neoloopy/cld-canvas";

export type InsightDestination = "structure" | "loops" | "docs" | "health";

export const INSIGHT_DESTINATIONS: InsightDestination[] = [
  "structure",
  "loops",
  "docs",
  "health",
];

/** Honest user-facing state when bounded quantitative loop analysis fails. */
export function loopAnalysisWarning(g: GraphView): string | null {
  return g.analysisError
    ? "Quantitative loop analysis is incomplete. No partial quantitative badges were added."
    : null;
}

/** Complete command-palette loop report, including any analysis qualifier. */
export function loopReportMessage(g: GraphView): string {
  const warning = loopAnalysisWarning(g);
  if (g.loops.length === 0) return warning ?? "No feedback loops detected.";
  const labels = g.loops.map((loop) => g.labels.get(loop.key) ?? "?").sort();
  const summary = `${g.loops.length} loop${g.loops.length === 1 ? "" : "s"}: ` +
    labels.join(", ");
  return warning ? `${summary}. ${warning}` : summary;
}

export function resolveInsightDestination(
  active: InsightDestination,
  available: readonly InsightDestination[] = INSIGHT_DESTINATIONS,
): InsightDestination {
  return available.includes(active) ? active : available[0] ?? "structure";
}

export interface HealthCheck {
  severity: "info" | "warn";
  label: string;
  detail: string;
}

const nameOf = (n: VariableFile): string => n.label || n.id;

export function modelHealthChecks(g: GraphView): HealthCheck[] {
  const out: HealthCheck[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const inbound = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const n of g.nodes) {
    for (const l of n.links) inbound.set(l.to, (inbound.get(l.to) ?? 0) + 1);
  }

  const orphaned = g.nodes.filter((n) => n.links.length === 0 && (inbound.get(n.id) ?? 0) === 0);
  if (orphaned.length > 0) {
    out.push({
      severity: "warn",
      label: "Disconnected variables",
      detail: orphaned.map(nameOf).join(", "),
    });
  }

  const duplicateLabels = new Map<string, VariableFile[]>();
  for (const n of g.nodes) {
    const key = (n.label || n.id).trim().toLowerCase();
    if (!key) continue;
    const arr = duplicateLabels.get(key);
    if (arr) arr.push(n);
    else duplicateLabels.set(key, [n]);
  }
  const dupes = [...duplicateLabels.values()].filter((v) => v.length > 1);
  if (dupes.length > 0) {
    out.push({
      severity: "warn",
      label: "Duplicate labels",
      detail: dupes.map((group) => group.map(nameOf).join(" / ")).join("; "),
    });
  }

  const unwired = g.nodes.filter((n) => n.type === "flow" && flowOf(n) === null);
  if (unwired.length > 0) {
    out.push({
      severity: "info",
      label: "Flows without explicit pipes",
      detail: unwired.map(nameOf).join(", "),
    });
  }

  const stale: string[] = [];
  for (const n of g.nodes) {
    if (n.type !== "flow") continue;
    const flow = flowOf(n);
    if (!flow) continue;
    const check = validateFlowEndpoints(flow.from, flow.to, byId);
    if (!check.ok) stale.push(`${nameOf(n)}: ${check.error}`);
  }
  if (stale.length > 0) {
    out.push({
      severity: "warn",
      label: "Invalid flow endpoints",
      detail: stale.join("; "),
    });
  }

  if (out.length === 0) {
    out.push({
      severity: "info",
      label: "No local health issues",
      detail: "Structure checks passed in the plugin.",
    });
  }
  return out;
}
