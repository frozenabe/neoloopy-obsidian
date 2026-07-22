/**
 * File-format domain types for the local-first vault — a TypeScript port of
 * `core/lib/vault/vault_model.dart` and the loop types from
 * `core/lib/graph/loop_graph.dart`.
 *
 * These mirror the on-disk shape: a model is a folder of variable notes
 * (`<id>.md`, YAML frontmatter + Markdown body) plus a `model.json` manifest.
 * Timestamps are stored as UTC ISO-8601 strings (the codec normalizes on parse,
 * matching Dart's `DateTime.toUtc().toIso8601String()`; sub-millisecond
 * precision is not preserved, but timestamps are excluded from the content
 * signature so this never causes a false external-edit flag).
 */

export type VarType = "stock" | "flow" | "auxiliary";

export function varTypeFrom(s: string | null | undefined): VarType {
  return s === "stock" || s === "flow" ? s : "auxiliary";
}

export function varTypeName(t: VarType): string {
  return t;
}

/** Loop classification. Order matters: matches Dart `enum LoopType`. */
export enum LoopType {
  reinforcing = 0,
  balancing = 1,
}

/**
 * A directed causal link, stored **outgoing** on the source variable note.
 * `weight`/`curvature` are cosmetic fidelity carries; `confidence`/`basis` are
 * evidence carries. All are omitted when unset so plain notes stay clean and
 * pre-existing vaults round-trip byte-identically.
 */
export interface VaultLink {
  to: string;
  /** `?` is preserved unknown-sign input and never participates in a loop. */
  polarity: "+" | "-" | "?";
  delay: boolean;
  indirect: boolean;
  nonlinear: boolean;
  weight?: number;
  curvature?: number;
  confidence?: number;
  basis?: string;
}

/** Clamp a raw confidence to [0,1]; null/NaN -> undefined (unspecified). */
export function normalizeConfidence(v: unknown): number | undefined {
  const d = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (d === null || Number.isNaN(d)) return undefined;
  return d < 0 ? 0 : d > 1 ? 1 : d;
}

/** Trim a raw basis; empty -> undefined. */
export function normalizeBasis(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length === 0 ? undefined : s;
}

export function linkFromMap(m: Record<string, unknown>): VaultLink {
  const pol = m["polarity"];
  const hasPolarity = Object.prototype.hasOwnProperty.call(m, "polarity");
  return {
    to: String(m["to"]),
    polarity: pol === "-" || pol === -1
      ? "-"
      : pol === "+" || pol === 1 || !hasPolarity
        ? "+"
        : "?",
    delay: m["delay"] === true,
    indirect: m["indirect"] === true,
    nonlinear: m["nonlinear"] === true,
    weight: typeof m["weight"] === "number" ? Math.trunc(m["weight"]) : undefined,
    curvature: typeof m["curvature"] === "number" ? (m["curvature"]) : undefined,
    confidence: normalizeConfidence(m["confidence"]),
    basis: normalizeBasis(m["basis"]),
  };
}

/**
 * Ordered map for YAML emission (only meaningful keys, in the exact order and
 * with the exact inclusion rules of Dart `VaultLink.toMap`).
 */
export function linkToMap(l: VaultLink): Array<[string, string | number | boolean]> {
  const out: Array<[string, string | number | boolean]> = [
    ["to", l.to],
    ["polarity", l.polarity],
    ["delay", l.delay],
    ["indirect", l.indirect],
    ["nonlinear", l.nonlinear],
  ];
  if (l.weight !== undefined && l.weight !== 0) out.push(["weight", l.weight]);
  if (l.curvature !== undefined) out.push(["curvature", l.curvature]);
  if (l.confidence !== undefined) out.push(["confidence", l.confidence]);
  if (l.basis !== undefined && l.basis.length > 0) out.push(["basis", l.basis]);
  return out;
}

/** One variable note: structured frontmatter + free Markdown body. */
export interface VariableFile {
  id: string;
  type: VarType;
  label: string;
  group?: string;
  claLayer?: string;
  shared?: string;
  x: number;
  y: number;
  links: VaultLink[];
  body: string;
  /** Unknown frontmatter keys, preserved verbatim on write (format rule §3). */
  extra: Record<string, unknown>;
  tags: string[];
  status?: string;
  created?: string;
  modified?: string;
  rev: number;
  source?: string;
  reviewed?: string;
  reviewedBy?: string;
  h?: string;
  subsystem?: string;
}

export function emptyVariable(id: string, label = ""): VariableFile {
  return {
    id,
    type: "auxiliary",
    label,
    x: 0,
    y: 0,
    links: [],
    body: "",
    extra: {},
    tags: [],
    rev: 0,
  };
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export function viewportFromMap(m: Record<string, unknown> | null | undefined): Viewport {
  const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
  return {
    x: num(m?.["x"], 0),
    y: num(m?.["y"], 0),
    zoom: num(m?.["zoom"], 1),
  };
}

/** Model-level metadata (`model.json`). */
export interface ModelManifest {
  id: string;
  name: string;
  schemaVersion: number;
  viewport: Viewport;
  created: string;
  modified: string;
  folder?: string;
  order: number;
  extra: Record<string, unknown>;
}

const MANIFEST_KNOWN = new Set([
  "id",
  "name",
  "schemaVersion",
  "viewport",
  "created",
  "modified",
  "folder",
  "order",
]);

/** Normalize a timestamp value to UTC ISO; undefined-safe. */
export function toUtcIso(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function manifestFromJson(j: Record<string, unknown>): ModelManifest {
  const ts = (v: unknown): string => toUtcIso(v) ?? new Date().toISOString();
  const f = typeof j["folder"] === "string" ? (j["folder"]).trim() : undefined;
  return {
    id: String(j["id"]),
    name: String(j["name"] ?? "Untitled"),
    schemaVersion: typeof j["schemaVersion"] === "number" ? Math.trunc(j["schemaVersion"]) : 1,
    viewport: viewportFromMap(j["viewport"] as Record<string, unknown> | undefined),
    created: ts(j["created"]),
    modified: ts(j["modified"]),
    folder: f && f.length > 0 ? f : undefined,
    order: typeof j["order"] === "number" ? Math.trunc(j["order"]) : 0,
    extra: Object.fromEntries(Object.entries(j).filter(([k]) => !MANIFEST_KNOWN.has(k))),
  };
}

export function manifestToJson(m: ModelManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    name: m.name,
    schemaVersion: m.schemaVersion,
    viewport: { x: m.viewport.x, y: m.viewport.y, zoom: m.viewport.zoom },
    created: m.created,
    modified: m.modified,
  };
  if (m.folder && m.folder.length > 0) out["folder"] = m.folder;
  if (m.order !== 0) out["order"] = m.order;
  return { ...out, ...m.extra };
}

export type CanvasLoopLegKind = "causal" | "material";

/** One exact declared information connector in a resolved executable cycle. */
export interface CausalCanvasLoopLeg {
  readonly kind: "causal";
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly edgeId: string;
  readonly polarity: 1 | -1;
}

/**
 * One exact first-class flow/stock pipe leg in a resolved executable cycle.
 * `cldEdgeId` is either the matching declared connector or the deterministic,
 * non-persistent CLD projection that represents this material effect.
 */
export interface MaterialCanvasLoopLeg {
  readonly kind: "material";
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly flowId: string;
  readonly stockId: string;
  readonly cldEdgeId: string;
  readonly polarity: 1 | -1;
}

export type CanvasLoopLeg = CausalCanvasLoopLeg | MaterialCanvasLoopLeg;

/**
 * A complete executable cycle resolved to exact visible canvas elements.
 * Partial paths are never represented.
 */
export class CanvasLoopPath {
  public readonly legs: readonly CanvasLoopLeg[];

  constructor(legs: readonly CanvasLoopLeg[]) {
    this.legs = Object.freeze([...legs]);
  }

  get hasMaterialLeg(): boolean {
    return this.legs.some((leg) => leg.kind === "material");
  }
}

/** Rotate a directed cycle to its lexicographically smallest rotation. */
export function canonicalDirectedCycle(nodeIds: Iterable<string>): string[] {
  const nodes = [...nodeIds];
  if (nodes.length > 1 && nodes[0] === nodes[nodes.length - 1]) nodes.pop();
  if (nodes.length === 0) return [];

  const compareRotation = (a: number, b: number): number => {
    for (let offset = 0; offset < nodes.length; offset++) {
      const left = nodes[(a + offset) % nodes.length];
      const right = nodes[(b + offset) % nodes.length];
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return 0;
  };

  let best = 0;
  for (let candidate = 1; candidate < nodes.length; candidate++) {
    if (compareRotation(candidate, best) < 0) best = candidate;
  }
  return [...nodes.slice(best), ...nodes.slice(0, best)];
}

/** Rotation-invariant and routing-sensitive identity for a directed cycle. */
export function directedCycleKey(nodeIds: Iterable<string>): string {
  return canonicalDirectedCycle(nodeIds).map(encodeURIComponent).join(">");
}

export type LoopIdentityMode = "qualitative" | "quantitative";

/** A detected feedback loop: variable ids in cycle order + R/B classification. */
export class DetectedLoop {
  constructor(
    public readonly nodeIds: string[],
    public readonly type: LoopType,
    public readonly canvasPath?: CanvasLoopPath,
    public readonly identityMode: LoopIdentityMode = "qualitative",
    /** Multiple directed routes collapsed to this legacy qualitative key. */
    public readonly exactRouteAmbiguous = false,
  ) {}

  /** Rotation-invariant, routing-sensitive identity used for exact dedup. */
  get exactKey(): string {
    const prefix = this.type === LoopType.reinforcing ? "R" : "B";
    return `${prefix}:${directedCycleKey(this.nodeIds)}`;
  }

  /**
   * Qualitative loops retain the package's established numeric-type/sorted-id
   * key. Quantitative-only badges use the exact directed key so distinct
   * executable routings through the same nodes cannot collide.
   */
  get key(): string {
    if (this.identityMode === "quantitative") return this.exactKey;
    return `${this.type}:${[...this.nodeIds].sort().join("|")}`;
  }
}
