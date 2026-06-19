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
