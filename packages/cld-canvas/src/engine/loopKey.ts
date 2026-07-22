import { DetectedLoop, LoopType } from "./types";

/**
 * The resolved-map key for a feedback loop: `<R|B>:<sorted unique member
 * labels>`. This is the key every UI consumer indexes loop notes by; it is NOT
 * the loop's on-disk identity (that lives in each `Loops/*.md` frontmatter as
 * the ordered member ids — see `loopNote.ts`). Mirrors Dart `fmt.loopNoteKey`.
 *
 * Pure and dependency-free so both the engine (`nativeEngine`) and the view
 * (`view/loopKeys`) derive the key from one definition instead of each carrying
 * its own copy.
 */
export function loopKey(labels: string[], type: string): string {
  const letter = type.toUpperCase().startsWith("R") ? "R" : "B";
  const uniq = [...new Set(labels.map((l) => String(l)))].sort();
  return `${letter}:${uniq.join("|")}`;
}

/**
 * The one UI/engine lookup key for a detected loop note. Existing qualitative
 * loops, including a qualitative counterpart enriched with a quantitative
 * canvas path, retain the sorted-label key shared with earlier releases.
 * Quantitative-only loops use exact directed id identity so different routes
 * through the same displayed members remain independent.
 */
export function resolvedLoopNoteKey(
  loop: DetectedLoop,
  nameOf: (id: string) => string,
): string {
  if (loop.identityMode === "quantitative") return loop.exactKey;
  const type = loop.type === LoopType.reinforcing ? "R" : "B";
  return loopKey(loop.nodeIds.map(nameOf), type);
}

/**
 * Human-readable, non-link echo for a loop note's `loop:` frontmatter field:
 * `<R|B> · <sorted unique labels joined by " | ">`. Same membership rule as
 * `loopKey` (dedupe + sort) but rendered for humans — it deliberately avoids a
 * leading `scheme:` so Obsidian's property view does not show it as a (dead)
 * external link. Display only; NEVER an identity/lookup/export/API key (that is
 * `loopKey`). Mirrors Dart `fmt.loopEchoLabel`.
 *
 * The Set dedupe absorbs a closed-cycle duplicate, so no explicit `first==last`
 * trim is needed. Keep this symmetric with the Dart twin: do not add a trim to
 * only one side — divergent membership handling would break byte parity.
 */
export function loopEchoLabel(labels: string[], type: string): string {
  const letter = type.toUpperCase().startsWith("R") ? "R" : "B";
  const uniq = [...new Set(labels.map((l) => String(l)))].sort();
  return uniq.length === 0 ? letter : `${letter} · ${uniq.join(" | ")}`;
}
