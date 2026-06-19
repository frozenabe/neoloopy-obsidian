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
 * Human-readable, non-link echo for a loop note's `loop:` frontmatter field:
 * `<R|B> · <sorted unique labels joined by " | ">`. Same membership rule as
 * `loopKey` (dedupe + sort) but rendered for humans — it deliberately avoids a
 * leading `scheme:` so Obsidian's property view does not show it as a (dead)
 * external link. Display only; NEVER an identity/lookup/export/API key (that is
 * `loopKey`). Mirrors Dart `fmt.loopEchoLabel`.
 */
export function loopEchoLabel(labels: string[], type: string): string {
  const letter = type.toUpperCase().startsWith("R") ? "R" : "B";
  const uniq = [...new Set(labels.map((l) => String(l)))].sort();
  return uniq.length === 0 ? letter : `${letter} · ${uniq.join(" | ")}`;
}
