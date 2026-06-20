/**
 * View-models for quant display — pure extractors over data the codec already
 * preserves (`VariableFile.extra["quant"]` and
 * `ModelManifest.extra["referenceModes"]`). No DOM, no I/O, no simulation.
 * Per-variable quant detail feeds the ƒx node-menu modal (`equationModalModel`
 * and its helpers); model-level reference modes remain a panel section
 * (`referenceModeRows`).
 */

import { ModelManifest, VariableFile } from "@neoloopy/cld-canvas";
import { referenceSeries } from "./referenceShapes";

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length === 0 ? undefined : s;
}

const nameOf = (n: VariableFile): string => n.label || n.id;

/**
 * A stock's net flow, read off the diagram's structure (not a stored equation):
 * each flow whose link targets `stock` contributes a signed term — `+` for an
 * inflow, `−` for an outflow — e.g. `+ Births − Deaths`. Returns `undefined`
 * when `stock` is not a stock or no flows are wired to it. Mirrors the app's
 * `stockGoverningFlow` (qualitative, no simulation).
 */
export function stockGoverningFlow(stock: VariableFile, nodes: VariableFile[]): string | undefined {
  if (stock.type !== "stock") return undefined;
  const terms: string[] = [];
  for (const f of nodes) {
    if (f.type !== "flow") continue;
    for (const lk of f.links) {
      if (lk.to !== stock.id) continue;
      terms.push(`${lk.polarity === "-" ? "−" : "+"} ${nameOf(f)}`);
    }
  }
  return terms.length === 0 ? undefined : terms.join(" ");
}

/**
 * A subscripted (per-element) initial rendered as element arrows — `young: 10,
 * old: 0` becomes `young → 10 · old → 0`. Returns `undefined` for a plain scalar
 * or any value that isn't a clean `key: value` map, so callers can fall back to
 * the raw text. Mirrors the app's `perElementInitial`.
 */
export function perElementInitial(value: string): string | undefined {
  const src = value.trim();
  if (!src.includes(":")) return undefined;
  if (!Number.isNaN(Number(src)) && src.length > 0) return undefined;
  const parts = (src.includes(";") ? src.split(";") : src.split(","))
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const out: string[] = [];
  for (const p of parts) {
    const c = p.indexOf(":");
    if (c < 0) return undefined;
    const key = p.slice(0, c).trim();
    const val = p.slice(c + 1).trim();
    if (key.length === 0 || val.length === 0) return undefined;
    out.push(`${key} → ${val}`);
  }
  return out.length === 0 ? undefined : out.join(" · ");
}

const isNumeric = (s: string): boolean => {
  const t = s.trim();
  return t.length > 0 && !Number.isNaN(Number(t));
};

export interface EquationRefs {
  /** Model variables the equation depends on, in model order. */
  referenced: string[];
  /** Identifiers that match no model variable — likely typos or undefined refs. */
  unknown: string[];
}

/**
 * Which model variables an [equation] references and which identifiers it uses
 * that match no variable. A lightweight, engineless approximation of the app's
 * parser-based `analyzeEquation`: the plugin ships no expression parser (that is
 * the simulation engine), so this tokenizes identifiers instead. An identifier
 * immediately followed by `(` is treated as a function call and ignored; one
 * preceded by a digit or `.` (e.g. the `e` in `1e3`) is skipped as part of a
 * number. It cannot flag the syntax errors the simulator would.
 */
export function equationRefs(equation: string, variableNames: string[]): EquationRefs {
  const eq = equation.trim();
  if (eq.length === 0) return { referenced: [], unknown: [] };
  const known = new Map(variableNames.map((n) => [n.toLowerCase(), n]));
  const used = new Set<string>(); // lowercased referenced var names
  const unknownOrder: string[] = [];
  const unknownSeen = new Set<string>();

  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(eq)) !== null) {
    const before = m.index > 0 ? eq[m.index - 1] : "";
    if (/[0-9.]/.test(before)) continue; // part of a numeric literal (e.g. 1e3)
    let after = re.lastIndex;
    while (after < eq.length && /\s/.test(eq[after])) after++;
    if (eq[after] === "(") continue; // function call — not a variable reference
    const lower = m[0].toLowerCase();
    if (known.has(lower)) used.add(lower);
    else if (!unknownSeen.has(lower)) {
      unknownSeen.add(lower);
      unknownOrder.push(m[0]);
    }
  }
  return {
    referenced: variableNames.filter((n) => used.has(n.toLowerCase())),
    unknown: unknownOrder,
  };
}

/**
 * The distinct, non-blank units in use across the model, trimmed and sorted
 * case-insensitively (deterministic tiebreak) — the suggestions the units field
 * offers so a unit stays consistent with the rest of the model. Mirrors the
 * app's `distinctUnits`.
 */
export function distinctUnits(raw: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const s = (r ?? "").trim();
    if (s.length === 0 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  // Code-unit comparison (mirrors Dart's String.compareTo), case-insensitive
  // first with a case-sensitive tiebreak so the order is deterministic.
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  out.sort((a, b) => {
    const c = cmp(a.toLowerCase(), b.toLowerCase());
    return c !== 0 ? c : cmp(a, b);
  });
  return out;
}

/** A node's preserved quant field (`extra.quant[key]`) as a trimmed string. */
function quantField(node: VariableFile, key: string): string {
  const q = node.extra["quant"];
  if (!q || typeof q !== "object") return "";
  return str((q as Record<string, unknown>)[key]) ?? "";
}

export interface EquationModalModel {
  title: string;
  isStock: boolean;
  /** "Initial value" for a stock, "Equation" otherwise. */
  primaryLabel: string;
  /** Current initial (stock) or equation (flow/aux). */
  primaryValue: string;
  /** A subscripted initial reworded per element (stock only, when applicable). */
  perElement?: string;
  /** The stock's net flow `<label>′ = + Births − Deaths` (stock only, if wired). */
  governingFlow?: string;
  referenced: string[];
  unknown: string[];
  units: string;
  unitSuggestions: string[];
}

/**
 * The pure view-model the ƒx node-menu modal renders — every engineless piece of
 * a node's quantitative definition (no simulation): the editable initial/equation
 * + units, plus the derived governing flow, per-element initial, and referenced/
 * unknown variables. The modal binds inputs to `primaryValue`/`units` and writes
 * back via the engine; everything else is read-only explanation.
 */
export function equationModalModel(node: VariableFile, nodes: VariableFile[]): EquationModalModel {
  const isStock = node.type === "stock";
  const primaryValue = quantField(node, isStock ? "initial" : "equation");
  const perElement = isStock ? perElementInitial(primaryValue) : undefined;
  const flow = isStock ? stockGoverningFlow(node, nodes) : undefined;

  // A stock's initial is usually a constant or per-element map, not an
  // expression — only analyze it for variable refs when it could be one.
  const analyzable = !isStock || (perElement === undefined && !isNumeric(primaryValue));
  const refs = analyzable
    ? equationRefs(primaryValue, nodes.map(nameOf))
    : { referenced: [], unknown: [] };

  return {
    title: nameOf(node),
    isStock,
    primaryLabel: isStock ? "Initial value" : "Equation",
    primaryValue,
    perElement,
    governingFlow: flow ? `${nameOf(node)}′ = ${flow}` : undefined,
    referenced: refs.referenced,
    unknown: refs.unknown,
    units: quantField(node, "units"),
    unitSuggestions: distinctUnits(nodes.map((n) => quantField(n, "units"))),
  };
}

export interface RefModeRow {
  variable: string;
  label: string;
  series: number[];
}

export function referenceModeRows(manifest: ModelManifest): RefModeRow[] {
  const raw = manifest.extra["referenceModes"];
  if (!Array.isArray(raw)) return [];
  const out: RefModeRow[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const m = e as Record<string, unknown>;
    const variable = String(m["variable"] ?? "").trim();
    const pattern = m["pattern"] != null ? String(m["pattern"]) : undefined;
    const points = Array.isArray(m["points"])
      ? (m["points"] as unknown[]).filter((x): x is number => typeof x === "number")
      : undefined;
    const note = String(m["note"] ?? "").trim();
    const series = referenceSeries(pattern, points);
    const label = note || (pattern ? pattern.replace(/-/g, " ") : "custom curve");
    out.push({ variable, label, series });
  }
  return out;
}
