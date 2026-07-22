/**
 * Conservative, renderer-facing discovery of executable quantitative loops.
 *
 * This is deliberately not a simulation or dominance implementation. It only
 * admits a static scalar cycle when every equation dependency maps to exactly
 * one declared information connector and every flow-to-stock effect maps to an
 * explicit first-class material endpoint. Any incomplete analysis returns no
 * quantitative prefix; declared qualitative loops remain available unchanged.
 */

import {
  CanvasLoopLeg,
  CanvasLoopPath,
  DetectedLoop,
  LoopType,
  ModelManifest,
  VariableFile,
  canonicalDirectedCycle,
} from "./types";
import {
  flowOf,
  isCloud,
  validateFlowEndpoints,
} from "./sfd";

export interface CanvasLoopDiscoveryLimits {
  readonly maxLoops: number;
  readonly maxEdgeVisits: number;
  readonly maxDepth: number;
}

export const USER_FACING_CANVAS_LOOP_LIMITS: CanvasLoopDiscoveryLimits = Object.freeze({
  maxLoops: 2048,
  maxEdgeVisits: 100_000,
  maxDepth: 512,
});

export interface CanvasLoopDiscoveryOptions {
  readonly manifest?: ModelManifest;
  readonly limits?: CanvasLoopDiscoveryLimits;
}

export interface CanvasLoopDiscoveryResult {
  readonly loops: DetectedLoop[];
  readonly analysisError: string | null;
}

type ExecutableEdge = {
  readonly from: string;
  readonly to: string;
  readonly polarity: 1 | -1;
  readonly leg: CanvasLoopLeg;
};

type EquationParse =
  | { readonly ok: true; readonly references: string[] }
  | { readonly ok: false; readonly reason: string };

const UNSUPPORTED_STATEFUL_FUNCTIONS = new Set([
  "delay",
  "delay1",
  "delay3",
  "delay_fixed",
  "delay_information",
  "delay_material",
  "smooth",
  "smooth3",
  "smoothi",
  "smooth3i",
  "trend",
  "forecast",
  "npv",
]);

const SUPPORTED_SCALAR_FUNCTIONS = new Set([
  "abs",
  "acos",
  "asin",
  "atan",
  "ceil",
  "ceiling",
  "cos",
  "exp",
  "floor",
  "if_then_else",
  "integer",
  "ln",
  "log",
  "max",
  "min",
  "mod",
  "power",
  "pulse",
  "pulse_train",
  "ramp",
  "round",
  "sin",
  "sqrt",
  "step",
  "tan",
]);

const SCALAR_NAMES = new Set(["false", "pi", "time", "true"]);
const ARRAY_KEYS = new Set([
  "cell",
  "cells",
  "dimension",
  "dimensions",
  "dims",
  "element",
  "elements",
  "flattened",
  "subscript",
  "subscriptinstance",
  "subscripts",
]);
const COMPOSITION_KEYS = new Set([
  "binding",
  "bindings",
  "composed",
  "composedfrom",
  "composition",
  "inputbinding",
  "inputbindings",
  "subsystem",
  "subsystems",
]);
const NODE_HIERARCHY_KEYS = new Set([
  "composedfrom",
  "inputbinding",
  "inputbindings",
  "subsystem",
  "subsystems",
]);

function objectMap(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function containsMarkedKey(value: unknown, keys: Set<string>): boolean {
  const map = objectMap(value);
  if (!map) return false;
  for (const [rawKey, nested] of Object.entries(map)) {
    const key = rawKey.toLowerCase().replace(/_/g, "");
    if (keys.has(key) && nonEmpty(nested)) return true;
    if (containsMarkedKey(nested, keys)) return true;
  }
  return false;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

function incomplete(reason: string, limits: CanvasLoopDiscoveryLimits): string {
  return `quant-loop-analysis-incomplete: ${reason} ` +
    `(maxLoops=${limits.maxLoops}, maxEdgeVisits=${limits.maxEdgeVisits}, ` +
    `maxDepth=${limits.maxDepth}); repair or simplify the model and retry`;
}

function pairKey(from: string, to: string): string {
  return `${from.length}:${from}>${to.length}:${to}`;
}

/** Stable first-class SFD pipe-leg identity. */
export function materialPipeLegId(flowId: string, stockId: string): string {
  return pairKey(flowId, stockId);
}

/** Stable base id for a non-persistent CLD projection of a material effect. */
export function materialProjectionEdgeId(flowId: string, stockId: string): string {
  return `__cld_material_projection__${flowId.length}:${flowId}:` +
    `${stockId.length}:${stockId}`;
}

function uniqueProjectionId(
  flowId: string,
  stockId: string,
  persistedIds: Set<string>,
): string {
  const base = materialProjectionEdgeId(flowId, stockId);
  if (!persistedIds.has(base)) return base;
  let suffix = 1;
  while (persistedIds.has(`${base}:${suffix}`)) suffix++;
  return `${base}:${suffix}`;
}

function isWord(ch: string): boolean {
  return ch.length > 0 && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Parse only enough scalar expression syntax to prove exact model references.
 * Unknown identifiers, stateful functions, arrays, and malformed token order
 * fail closed. Polarity still comes from the declared connector, not algebraic
 * inference.
 */
function parseScalarEquation(
  source: string,
  labelsByLongest: Array<{ readonly id: string; readonly label: string }>,
): EquationParse {
  if (/[[\]{};"'`]/.test(source)) {
    return { ok: false, reason: "unsupported scalar equation syntax" };
  }

  const refs: string[] = [];
  const seenRefs = new Set<string>();
  const parens: Array<"function" | "group"> = [];
  let i = 0;
  let expectValue = true;
  let pendingFunction = false;

  const nextNonSpaceIndex = (at: number): number => {
    let cursor = at;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
    return cursor;
  };

  const addRef = (id: string): void => {
    if (seenRefs.add(id)) refs.push(id);
  };

  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }

    let matchedLabel: { readonly id: string; readonly label: string } | undefined;
    for (const candidate of labelsByLongest) {
      const end = i + candidate.label.length;
      if (source.slice(i, end).toLowerCase() !== candidate.label.toLowerCase()) continue;
      const before = i > 0 ? source[i - 1] : "";
      const after = end < source.length ? source[end] : "";
      if (isWord(before) || isWord(after)) continue;
      if (source[nextNonSpaceIndex(end)] === "(") continue;
      matchedLabel = candidate;
      break;
    }
    if (matchedLabel) {
      if (!expectValue) return { ok: false, reason: "malformed equation token order" };
      addRef(matchedLabel.id);
      i += matchedLabel.label.length;
      expectValue = false;
      pendingFunction = false;
      continue;
    }

    const rest = source.slice(i);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      if (!expectValue) return { ok: false, reason: "malformed equation token order" };
      i += number[0].length;
      expectValue = false;
      pendingFunction = false;
      continue;
    }

    const multiFunction = /^(IF\s+THEN\s+ELSE|PULSE\s+TRAIN)\b/i.exec(rest);
    const identifier = multiFunction ?? /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (identifier) {
      const raw = identifier[0];
      const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_");
      const next = nextNonSpaceIndex(i + raw.length);
      const called = source[next] === "(";
      if (called) {
        if (!expectValue) return { ok: false, reason: "malformed equation token order" };
        if (UNSUPPORTED_STATEFUL_FUNCTIONS.has(normalized)) {
          return { ok: false, reason: `unsupported stateful function ${raw.trim()}` };
        }
        if (!SUPPORTED_SCALAR_FUNCTIONS.has(normalized)) {
          return { ok: false, reason: `unsupported function ${raw.trim()}` };
        }
        pendingFunction = true;
        i += raw.length;
        continue;
      }
      if (normalized === "not") {
        if (!expectValue) return { ok: false, reason: "malformed equation token order" };
        i += raw.length;
        continue;
      }
      if (normalized === "and" || normalized === "or") {
        if (expectValue) return { ok: false, reason: "malformed equation token order" };
        expectValue = true;
        i += raw.length;
        continue;
      }
      if (!SCALAR_NAMES.has(normalized)) {
        return { ok: false, reason: `unknown equation identifier ${raw}` };
      }
      if (!expectValue) return { ok: false, reason: "malformed equation token order" };
      expectValue = false;
      pendingFunction = false;
      i += raw.length;
      continue;
    }

    if (source[i] === "(") {
      if (!expectValue && !pendingFunction) {
        return { ok: false, reason: "malformed equation token order" };
      }
      parens.push(pendingFunction ? "function" : "group");
      pendingFunction = false;
      expectValue = true;
      i++;
      continue;
    }
    if (source[i] === ")") {
      if (expectValue || parens.length === 0) {
        return { ok: false, reason: "unbalanced or empty parentheses" };
      }
      parens.pop();
      expectValue = false;
      pendingFunction = false;
      i++;
      continue;
    }
    if (source[i] === ",") {
      if (expectValue || parens[parens.length - 1] !== "function") {
        return { ok: false, reason: "malformed function arguments" };
      }
      expectValue = true;
      pendingFunction = false;
      i++;
      continue;
    }

    const operator = /^(<=|>=|<>|==|!=|&&|\|\||[+\-*/^%<>=!])/.exec(rest);
    if (operator) {
      const unary = expectValue && ["+", "-", "!"].includes(operator[0]);
      if (expectValue && !unary) {
        return { ok: false, reason: "malformed equation token order" };
      }
      expectValue = true;
      pendingFunction = false;
      i += operator[0].length;
      continue;
    }

    return { ok: false, reason: `unsupported equation token ${source[i]}` };
  }

  if (pendingFunction || expectValue || parens.length > 0) {
    return { ok: false, reason: "incomplete or unbalanced equation" };
  }
  return { ok: true, references: refs };
}

function qualitativeOnly(
  qualitativeLoops: readonly DetectedLoop[],
  analysisError: string | null,
): CanvasLoopDiscoveryResult {
  const seen = new Set<string>();
  const loops = qualitativeLoops.filter((loop) => seen.add(loop.key));
  return { loops, analysisError };
}

/**
 * Discover complete canvas-resolvable quantitative cycles and merge them with
 * exact qualitative counterparts. A quantitative error never suppresses or
 * mutates the pre-existing qualitative loops.
 */
export function discoverCanvasLoops(
  nodes: readonly VariableFile[],
  qualitativeLoops: readonly DetectedLoop[],
  options: CanvasLoopDiscoveryOptions = {},
): CanvasLoopDiscoveryResult {
  const limits = options.limits ?? USER_FACING_CANVAS_LOOP_LIMITS;
  const fail = (reason: string): CanvasLoopDiscoveryResult =>
    qualitativeOnly(qualitativeLoops, incomplete(reason, limits));

  if (limits.maxLoops < 1 || limits.maxEdgeVisits < 1 || limits.maxDepth < 2) {
    return fail("invalid discovery limits");
  }

  const manifestQuant = options.manifest?.extra["mode"] === "quantitative" ||
    objectMap(options.manifest?.extra["quantitative"]) !== null;
  const nodeQuant = nodes.some((node) => objectMap(node.extra["quant"]) !== null);
  if (!manifestQuant && !nodeQuant) return qualitativeOnly(qualitativeLoops, null);

  if (containsMarkedKey(options.manifest?.extra["quantitative"], ARRAY_KEYS) ||
      nodes.some((node) => containsMarkedKey(node.extra["quant"], ARRAY_KEYS))) {
    return fail("arrayed or flattened quantitative topology is not canvas-resolvable");
  }
  if (containsMarkedKey(options.manifest?.extra, COMPOSITION_KEYS) ||
      nodes.some((node) =>
        (node.subsystem ?? "").trim().length > 0 ||
        containsMarkedKey(node.extra["quant"], NODE_HIERARCHY_KEYS))) {
    return fail("subsystem or composed quantitative topology is not canvas-resolvable");
  }

  const byId = new Map<string, VariableFile>();
  const byLabel = new Map<string, VariableFile>();
  for (const node of nodes) {
    if (byId.has(node.id)) return fail(`duplicate variable id ${node.id}`);
    byId.set(node.id, node);
    const label = node.label.trim();
    if (label.length === 0) return fail(`missing variable label for ${node.id}`);
    const folded = label.toLowerCase();
    if (byLabel.has(folded)) return fail(`duplicate variable label ${label}`);
    byLabel.set(folded, node);
  }
  const labelsByLongest = [...nodes]
    .map((node) => ({ id: node.id, label: node.label.trim() }))
    .sort((a, b) => b.label.length - a.label.length || a.label.localeCompare(b.label));

  let edgeVisits = 0;
  const workLimitReached = (): boolean => ++edgeVisits > limits.maxEdgeVisits;
  const displayed = new Map<string, Array<{ node: VariableFile; index: number }>>();
  const persistedEdgeIds = new Set<string>();
  for (const source of nodes) {
    for (let index = 0; index < source.links.length; index++) {
      if (workLimitReached()) return fail("loop discovery exceeded its work limit");
      const link = source.links[index];
      if (!byId.has(link.to)) continue;
      const key = pairKey(source.id, link.to);
      const entries = displayed.get(key) ?? [];
      entries.push({ node: source, index });
      displayed.set(key, entries);
      persistedEdgeIds.add(`${source.id}__${link.to}`);
    }
  }

  const edges: ExecutableEdge[] = [];
  const executablePairs = new Set<string>();
  const addEdge = (edge: ExecutableEdge): CanvasLoopDiscoveryResult | null => {
    const key = pairKey(edge.from, edge.to);
    if (!executablePairs.add(key)) return fail(`duplicate executable leg ${edge.from} -> ${edge.to}`);
    edges.push(edge);
    return null;
  };

  for (const target of nodes) {
    const quant = objectMap(target.extra["quant"]);
    if (!quant) return fail(`missing quantitative definition for ${target.label}`);
    if (target.type === "stock") {
      const initial = scalarText(quant["initial"]);
      if (initial === null || initial.includes(":")) {
        return fail(`missing or unsupported scalar initial for ${target.label}`);
      }
      const parsedInitial = parseScalarEquation(initial, labelsByLongest);
      if (!parsedInitial.ok) {
        return fail(`${parsedInitial.reason} in initial for ${target.label}`);
      }
      continue;
    }

    const equation = scalarText(quant["equation"]);
    if (equation === null) return fail(`missing equation for ${target.label}`);
    const parsed = parseScalarEquation(equation, labelsByLongest);
    if (!parsed.ok) return fail(`${parsed.reason} in ${target.label}`);
    for (const sourceId of parsed.references) {
      if (workLimitReached()) return fail("loop discovery exceeded its work limit");
      const candidates = displayed.get(pairKey(sourceId, target.id)) ?? [];
      if (candidates.length !== 1) {
        return fail(`equation dependency ${sourceId} -> ${target.id} has ` +
          `${candidates.length} displayed connectors`);
      }
      const entry = candidates[0];
      const link = entry.node.links[entry.index];
      if (link.indirect) return fail(`equation dependency ${sourceId} -> ${target.id} is dashed`);
      if (link.polarity !== "+" && link.polarity !== "-") {
        return fail(`equation dependency ${sourceId} -> ${target.id} has unknown polarity`);
      }
      const polarity = link.polarity === "-" ? -1 : 1;
      const failed = addEdge({
        from: sourceId,
        to: target.id,
        polarity,
        leg: {
          kind: "causal",
          fromNodeId: sourceId,
          toNodeId: target.id,
          edgeId: `${sourceId}__${target.id}`,
          polarity,
        },
      });
      if (failed) return failed;
    }
  }

  for (const flow of nodes) {
    if (flow.type !== "flow") continue;
    const spec = flowOf(flow);
    if (!spec) return fail(`flow ${flow.label} lacks explicit material endpoints`);
    const validation = validateFlowEndpoints(spec.from, spec.to, byId);
    if (!validation.ok) return fail(`invalid material endpoints for ${flow.label}: ${validation.error}`);
    const touches: Array<{ stockId: string; polarity: 1 | -1 }> = [];
    if (!isCloud(spec.from)) touches.push({ stockId: spec.from, polarity: -1 });
    if (!isCloud(spec.to)) touches.push({ stockId: spec.to, polarity: 1 });
    for (const touch of touches) {
      if (workLimitReached()) return fail("loop discovery exceeded its work limit");
      const candidates = displayed.get(pairKey(flow.id, touch.stockId)) ?? [];
      let cldEdgeId: string;
      if (candidates.length === 0) {
        cldEdgeId = uniqueProjectionId(flow.id, touch.stockId, persistedEdgeIds);
      } else if (candidates.length === 1) {
        const entry = candidates[0];
        const link = entry.node.links[entry.index];
        const declared = link.polarity === "-" ? -1 : link.polarity === "+" ? 1 : 0;
        if (link.indirect || declared !== touch.polarity) {
          return fail(`material leg ${flow.id} -> ${touch.stockId} has a ` +
            "dashed, conflicting, or unknown displayed connector");
        }
        cldEdgeId = `${flow.id}__${touch.stockId}`;
      } else {
        return fail(`material leg ${flow.id} -> ${touch.stockId} has duplicate displayed connectors`);
      }
      const failed = addEdge({
        from: flow.id,
        to: touch.stockId,
        polarity: touch.polarity,
        leg: {
          kind: "material",
          fromNodeId: flow.id,
          toNodeId: touch.stockId,
          flowId: flow.id,
          stockId: touch.stockId,
          cldEdgeId,
          polarity: touch.polarity,
        },
      });
      if (failed) return failed;
    }
  }

  const adjacency = new Map<string, ExecutableEdge[]>();
  for (const id of byId.keys()) adjacency.set(id, []);
  for (const edge of edges) adjacency.get(edge.from)?.push(edge);
  for (const outgoing of adjacency.values()) {
    outgoing.sort((a, b) => a.to.localeCompare(b.to) || a.leg.kind.localeCompare(b.leg.kind));
  }

  const quantByKey = new Map<string, DetectedLoop>();
  const orderedIds = [...byId.keys()].sort();
  for (const start of orderedIds) {
    const nodeStack = [start];
    const legStack: CanvasLoopLeg[] = [];
    const onPath = new Set([start]);
    let discoveryFailure: string | null = null;

    const dfs = (current: string, product: number): void => {
      if (discoveryFailure) return;
      for (const edge of adjacency.get(current) ?? []) {
        if (workLimitReached()) {
          discoveryFailure = "loop discovery exceeded its work limit";
          return;
        }
        if (edge.to === start) {
          if (nodeStack.length < 2) continue;
          const canonicalNodes = canonicalDirectedCycle(nodeStack);
          const shift = nodeStack.indexOf(canonicalNodes[0]);
          const cycleLegs = [...legStack, edge.leg];
          const canonicalLegs = [...cycleLegs.slice(shift), ...cycleLegs.slice(0, shift)];
          const type = product * edge.polarity === 1
            ? LoopType.reinforcing
            : LoopType.balancing;
          const loop = new DetectedLoop(
            canonicalNodes,
            type,
            new CanvasLoopPath(canonicalLegs),
            "quantitative",
          );
          if (quantByKey.has(loop.exactKey)) {
            discoveryFailure = `duplicate directed cycle ${loop.exactKey}`;
            return;
          }
          if (quantByKey.size >= limits.maxLoops) {
            discoveryFailure = "loop discovery exceeded its output limit";
            return;
          }
          quantByKey.set(loop.exactKey, loop);
          continue;
        }
        if (edge.to < start || onPath.has(edge.to)) continue;
        if (nodeStack.length >= limits.maxDepth) {
          discoveryFailure = "loop discovery exceeded its depth limit";
          return;
        }
        nodeStack.push(edge.to);
        legStack.push(edge.leg);
        onPath.add(edge.to);
        dfs(edge.to, product * edge.polarity);
        onPath.delete(edge.to);
        legStack.pop();
        nodeStack.pop();
        if (discoveryFailure) return;
      }
    };

    dfs(start, 1);
    if (discoveryFailure) return fail(discoveryFailure);
  }

  const qualitative = qualitativeOnly(qualitativeLoops, null).loops;
  const merged = [...qualitative];
  const qualitativeIndex = new Map(merged.map((loop, index) => [loop.exactKey, index]));
  for (const quant of [...quantByKey.values()].sort((a, b) =>
    a.nodeIds.length - b.nodeIds.length || a.exactKey.localeCompare(b.exactKey))) {
    const index = qualitativeIndex.get(quant.exactKey);
    if (index === undefined) {
      qualitativeIndex.set(quant.exactKey, merged.length);
      merged.push(quant);
    } else {
      const existing = merged[index];
      merged[index] = new DetectedLoop(
        existing.nodeIds,
        existing.type,
        quant.canvasPath,
        "qualitative",
      );
    }
  }
  return { loops: merged, analysisError: null };
}
