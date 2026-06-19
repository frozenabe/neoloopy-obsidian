/**
 * Pure graph-analysis helpers for the insight panel — no DOM, no I/O.
 *
 * - `endogeneity` mirrors the app's `CanvasController.endogeneity()` (keyed by
 *   variable id): how much of the system sits inside feedback vs. drives it from
 *   outside.
 */

import { DetectedLoop, VariableFile } from "./types";

export interface EndogeneityResult {
  total: number;
  inLoop: number;
  exogenous: string[];
  openLoop: string[];
}

export function endogeneity(
  nodes: VariableFile[],
  loops: DetectedLoop[],
): EndogeneityResult {
  const ids = new Set(nodes.map((n) => n.id));
  const inLoop = new Set<string>();
  for (const l of loops) for (const id of l.nodeIds) inLoop.add(id);

  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const n of nodes) {
    for (const lk of n.links) {
      if (!ids.has(lk.to)) continue;
      sources.add(n.id);
      targets.add(lk.to);
    }
  }
  return {
    total: nodes.length,
    inLoop: nodes.filter((n) => inLoop.has(n.id)).length,
    exogenous: nodes.filter((n) => !targets.has(n.id) && sources.has(n.id)).map((n) => n.id),
    openLoop: nodes.filter((n) => !inLoop.has(n.id)).map((n) => n.id),
  };
}
