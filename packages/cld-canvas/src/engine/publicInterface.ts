/**
 * Public-interface readers — the TypeScript mirror of the READ side of
 * `core/lib/quant/public_interface.dart`. In a subsystem-composed model a
 * variable is exposed to its parent by tagging it under `extra.quant.visibility`
 * (`'input'` | `'output'`; absent ⇒ private); a parent drives a child's public
 * input via `inputBindings` declared on the anchor node (the node carrying the
 * `subsystem` link). The qualitative plugin only READS these — publishing and
 * binding are quant authoring, which lives in the app/CLI/MCP. Both fields are
 * preserved verbatim on write (unknown-key carry, format rule §3), so reading
 * them never risks the data.
 */

import { VariableFile } from "./types";

function quantBlock(v: VariableFile): Record<string, unknown> {
  const q = v.extra["quant"];
  return q && typeof q === "object" ? (q as Record<string, unknown>) : {};
}

export type Visibility = "input" | "output";

/** `'input'` | `'output'` | `null` (private — the default). */
export function quantVisibility(v: VariableFile): Visibility | null {
  const s = String(quantBlock(v)["visibility"] ?? "").trim();
  return s === "input" || s === "output" ? s : null;
}

export function isPublicInput(v: VariableFile): boolean {
  return quantVisibility(v) === "input";
}

export function isPublicOutput(v: VariableFile): boolean {
  return quantVisibility(v) === "output";
}

/** A parent-side wiring that drives a linked child's public input. */
export interface InputBinding {
  /** Qualifier of the linked child (link alias or model name). */
  child: string;
  /** Child public-input label or id. */
  target: string;
  /** Parent-scope expression that drives the input. */
  expr: string;
}

/** Input bindings declared on this anchor node (empty when none). */
export function quantInputBindings(v: VariableFile): InputBinding[] {
  const raw = quantBlock(v)["inputBindings"];
  if (!Array.isArray(raw)) return [];
  const out: InputBinding[] = [];
  for (const e of raw) {
    if (e && typeof e === "object") {
      const m = e as Record<string, unknown>;
      out.push({
        child: String(m["child"] ?? ""),
        target: String(m["target"] ?? ""),
        expr: String(m["expr"] ?? ""),
      });
    }
  }
  return out;
}

/** A child model's public interface as resolved through a parent's subsystem link. */
export interface ChildInterface {
  /** Display qualifier — the link alias, else the child model name. */
  qualifier: string;
  /** Labels of the child's public outputs (offered to the parent). */
  outputs: string[];
  /** Labels of the child's public inputs (the parent may drive). */
  inputs: string[];
}

/**
 * A child output as a qualified reference: bracket form when the label has a
 * space (`ReworkCycle.[Defect Rate]`), bare otherwise. Mirrors the app's `_ref`
 * in `subsystem_interface_section.dart`.
 */
export function qualifiedRef(qualifier: string, label: string): string {
  return `${qualifier}.${label.includes(" ") ? `[${label}]` : label}`;
}
