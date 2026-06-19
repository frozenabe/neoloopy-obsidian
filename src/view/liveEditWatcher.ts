/**
 * LiveEditWatcher — watches the open model's vault folder for *external* edits
 * (the CLI, the desktop app, or hand-edits in Obsidian) and reflects them live:
 * it debounce-reloads the graph, diffs each node's content signature, and flashes
 * the violet "live edit" spotlight on the nodes that changed (plus a chip),
 * matching the desktop app.
 *
 * It also owns the *self-write window*: every write the plugin makes is bracketed
 * by `markSelfWrite()`, and a vault event inside that window is ignored — so our
 * own saves don't trigger a spurious flash. ModelController announces its writes
 * here; the view announces its file exports and loop-note creation here too.
 */

import { TAbstractFile, debounce } from "obsidian";
import { GraphView } from "../engine/engine";

const LIVE_MS = 2500;
const SELF_WRITE_MS = 1200;

/** What the watcher needs from the canvas view. */
export interface LiveEditHost {
  folder(): string | null;
  graph(): GraphView | null;
  reloadGraph(): Promise<void>;
  render(): void;
  /** Whether the violet live-edit spotlight is enabled in settings. */
  spotlightEnabled(): boolean;
}

export class LiveEditWatcher {
  private selfWriteUntil = 0;
  private liveNodes = new Set<string>();
  private liveTimer: number | null = null;

  constructor(private readonly liveChip: HTMLElement, private readonly host: LiveEditHost) {}

  /** Node ids currently lit by the spotlight (read by the painter via render). */
  get litNodes(): Set<string> {
    return this.liveNodes;
  }

  /** Open a short window during which our own writes are ignored by the watcher. */
  markSelfWrite(): void {
    this.selfWriteUntil = Date.now() + SELF_WRITE_MS;
  }

  /** Whether we're inside the self-write window — a write the plugin itself made
   *  (e.g. its own folder/file rename) that other vault handlers should ignore. */
  inSelfWrite(): boolean {
    return Date.now() < this.selfWriteUntil;
  }

  /** Route a vault change in for consideration (registered by the view). */
  onVaultChange(file: TAbstractFile): void {
    const folder = this.host.folder();
    if (!folder) return;
    const path = file.path;
    if (path !== folder && !path.startsWith(folder + "/")) return;
    if (Date.now() < this.selfWriteUntil) return;
    // A `Loops/*.md` edit changes only the annotation, not the graph structure;
    // the reload refreshes the loop-notes cache and repaints the badge without
    // flashing nodes (their content signatures are unchanged).
    this.reloadAndFlash();
  }

  /** Cancel any pending spotlight timer (on view close). */
  dispose(): void {
    if (this.liveTimer !== null) window.clearTimeout(this.liveTimer);
    this.liveTimer = null;
  }

  private reloadAndFlash = debounce(async () => {
    const before = this.host.graph();
    if (!this.host.folder() || !before) return;
    const sig = new Map(before.nodes.map((n) => [n.id, n.h ?? ""]));
    await this.host.reloadGraph();
    const after = this.host.graph();
    if (!after) return;
    const changed = new Set<string>();
    for (const n of after.nodes) {
      if (!sig.has(n.id) || sig.get(n.id) !== (n.h ?? "")) changed.add(n.id);
    }
    if (changed.size > 0) this.flashLive(changed);
    this.host.render();
  }, 180, true);

  private flashLive(ids: Set<string>): void {
    if (!this.host.spotlightEnabled()) return;
    this.liveNodes = ids;
    this.liveChip.toggleClass("is-visible", true);
    if (this.liveTimer !== null) window.clearTimeout(this.liveTimer);
    this.liveTimer = window.setTimeout(() => {
      this.liveNodes = new Set();
      this.liveChip.toggleClass("is-visible", false);
      this.liveTimer = null;
      this.host.render();
    }, LIVE_MS);
    this.host.render();
  }
}
