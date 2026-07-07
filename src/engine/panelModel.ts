/**
 * View-models for quant display — pure extractors over data the codec already
 * preserves (`VariableFile.extra["quant"]` and
 * `ModelManifest.extra["referenceModes"]`). No DOM, no I/O, no simulation.
 * Per-variable quant detail feeds the ƒx node-menu modal (`equationModalModel`
 * and its helpers); model-level reference modes remain a panel section
 * (`referenceModeRows`).
 */

import {
  flowTouches,
  ModelManifest,
  VariableFile,
  Visibility,
  quantVisibility,
} from "@neoloopy/cld-canvas";
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
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const f of nodes) {
    if (f.type !== "flow") continue;
    for (const touch of flowTouches(f, byId)) {
      if (touch.stockId !== stock.id) continue;
      terms.push(`${touch.sign < 0 ? "−" : "+"} ${nameOf(f)}`);
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
 * the simulation engine).
 *
 * Variable names may contain spaces (e.g. `Effective Rate`), so single-token
 * matching would wrongly split them ("Effective", "Rate"). Instead we first
 * claim whole known-variable *phrases* — longest first, on word boundaries — and
 * only then scan the unclaimed gaps for bare identifiers, which become unknowns.
 * An identifier immediately followed by `(` is a function call and is ignored;
 * one preceded by a digit or `.` (e.g. the `e` in `1e3`) is part of a number.
 * It cannot flag the syntax errors the simulator would.
 */
export function equationRefs(equation: string, variableNames: string[]): EquationRefs {
  const eq = equation.trim();
  if (eq.length === 0) return { referenced: [], unknown: [] };

  const isWord = (ch: string): boolean => ch.length > 0 && /[A-Za-z0-9_]/.test(ch);
  const nextNonSpace = (from: number): string => {
    let j = from;
    while (j < eq.length && /\s/.test(eq[j])) j++;
    return j < eq.length ? eq[j] : "";
  };

  // Character spans of `eq` already claimed by a known-variable phrase, so the
  // bare-identifier scan below skips the words inside a multi-word name.
  const claimed: Array<[number, number]> = [];
  const overlaps = (s: number, e: number): boolean =>
    claimed.some(([cs, ce]) => s < ce && cs < e);
  const used = new Set<string>(); // lowercased referenced var names

  // Longest names first so "Effective Rate" claims its span before "Rate" can.
  const byLongest = [...variableNames].sort((a, b) => b.length - a.length);
  for (const name of byLongest) {
    const n = name.trim();
    if (n.length === 0) continue;
    // Literal name match, tolerant of internal whitespace runs.
    const pattern = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const re = new RegExp(pattern, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(eq)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      const before = start > 0 ? eq[start - 1] : "";
      const after = end < eq.length ? eq[end] : "";
      if (isWord(before) || isWord(after)) continue; // not a whole-word match
      if (before === "." || /[0-9]/.test(before)) continue; // numeric context
      if (nextNonSpace(end) === "(") continue; // function call — not a reference
      if (overlaps(start, end)) continue; // sits inside a longer known name
      claimed.push([start, end]);
      used.add(n.toLowerCase());
    }
  }

  // Bare identifiers left in the unclaimed gaps are unknown references.
  const unknownOrder: string[] = [];
  const unknownSeen = new Set<string>();
  const tok = /[A-Za-z_][A-Za-z0-9_]*/g;
  let t: RegExpExecArray | null;
  while ((t = tok.exec(eq)) !== null) {
    const start = t.index;
    const end = tok.lastIndex;
    if (overlaps(start, end)) continue; // part of a claimed variable phrase
    const before = start > 0 ? eq[start - 1] : "";
    if (/[0-9.]/.test(before)) continue; // part of a numeric literal (e.g. 1e3)
    if (nextNonSpace(end) === "(") continue; // function call — not a reference
    const lower = t[0].toLowerCase();
    if (used.has(lower)) continue; // already counted as a single-word reference
    if (!unknownSeen.has(lower)) {
      unknownSeen.add(lower);
      unknownOrder.push(t[0]);
    }
  }

  return {
    referenced: variableNames.filter((n) => used.has(n.trim().toLowerCase())),
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
  /**
   * The variable's public-interface role in subsystem composition: a public
   * `input`/`output` exposed to a parent model, or `null` (private/internal).
   * Read-only — publishing happens in the app/CLI/MCP.
   */
  visibility: Visibility | null;
  /**
   * Whether this is a quantitative model (some variable carries a `quant`
   * block). The public/private role is only meaningful — and only shown — here;
   * a purely qualitative model never displays a visibility chip.
   */
  isQuantContext: boolean;
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
    visibility: quantVisibility(node),
    isQuantContext: nodes.some((n) => "quant" in n.extra),
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
