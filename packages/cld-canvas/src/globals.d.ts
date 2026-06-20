/**
 * Ambient globals the moved render core relies on but does NOT import.
 *
 * `activeDocument` is provided by Obsidian at runtime (it resolves the document
 * of the active window, which matters for pop-out windows). The plugin compiled
 * against Obsidian's type declarations, which declare it; this standalone
 * package has no `obsidian` dependency (by design), so we re-declare just the
 * one global the render core touches. Every call site already guards with
 * `typeof activeDocument !== "undefined"`, so a non-Obsidian host (e.g. the
 * website, plain Node) degrades gracefully — this declaration only satisfies the
 * type-checker, it adds no runtime dependency.
 */
declare const activeDocument: Document;
