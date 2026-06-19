/**
 * Filename ⇄ label mapping for variable ("node") notes. A node's Markdown file
 * is named after its label so the vault reads like the diagram (`Birth_Rate.md`
 * rather than `var_9c1b.md`), while the stable `var_…` id in the frontmatter
 * stays the link target — so renaming a node never breaks a link.
 *
 * The rule (per product decision): spaces become underscores, case is kept, and
 * characters that are illegal in a path or significant in an Obsidian wikilink
 * are dropped. Pure and obsidian-free so both the engine and the view can use it.
 */

// Path-illegal (\ / : * ? " < > |) plus wikilink-significant (# ^ [ ]) characters.
const RESERVED = /[\\/:*?"<>|#^[\]]/g;

/**
 * Filename stem (no extension) for a label. Returns "" when the label is blank
 * or made entirely of reserved characters — callers fall back to the id then.
 */
export function noteSlug(label: string): string {
  return label
    .replace(RESERVED, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Best-effort inverse, for when a user renames the file in the vault: turn the
 *  filename stem back into a label (underscores → spaces). */
export function noteUnslug(stem: string): string {
  return stem.replace(/_+/g, " ").trim();
}
