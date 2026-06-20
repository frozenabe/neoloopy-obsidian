/**
 * KeyboardController — full keyboard parity with the native app's canvas key set,
 * lifted out of CanvasView. It binds the canvas `keydown`, maps each press to a
 * command via the pure `routeKey` (so it never shadows an Obsidian shortcut: a
 * `none` command is left to Obsidian), and applies the command through a narrow
 * `KeyboardHost`. It owns the keyboard-navigation state: the nav anchor, the
 * armed-link source (and its live preview line), and the debounced nudge save.
 *
 * Key set (mirrors `canvas_screen.dart` `_keyBindings`): Tab/E/O cycle
 * node·edge·loop, N adds, L arms a link (Enter completes), arrows nudge the
 * selected node or pan, Enter is context-sensitive, +/−/0 zoom·fit, Cmd/Ctrl+E
 * exports, Cmd/Ctrl+T tidies, Ctrl+/ or ? opens the shortcuts cheatsheet.
 */

import { App } from "obsidian";
import { ShortcutsModal } from "./dialogs";
import { Camera, GraphView, Point, Scene } from "@neoloopy/cld-canvas";
import { routeKey, stepId } from "./keyRouting";

/** What the keyboard controller needs from the canvas view. */
export interface KeyboardHost {
  readonly app: App;
  readonly camera: Camera;
  scene(): Scene | null;
  graph(): GraphView | null;
  selection(): { node: string | null; edge: string | null; loop: string | null };
  hasFolder(): boolean;
  isRenaming(): boolean;
  listen(el: HTMLElement, type: string, cb: (e: Event) => void): void;

  select(node: string | null, edge: string | null, loop: string | null): void;
  render(): void;
  rebuildScene(): void;
  persistViewport(): void;
  startRename(id: string): void;
  toggleEdgeMenu(): void;
  openExportMenuAt(pos: { x: number; y: number }): void;
  openLoopNote(loopKey: string): Promise<void>;
  tidy(): Promise<void>;
  /** Reset the fit + re-fit the camera to the whole model (the `0` key). */
  fitToContent(): void;
  createNodeAt(world: Point): Promise<void>;
  createLink(from: string, to: string): Promise<void>;
  persistNodePosition(id: string, x: number, y: number): Promise<void>;
  deleteSelection(): Promise<void>;
}

export class KeyboardController {
  private navAnchor: string | null = null; // last node the keyboard "stood on"
  private keyLinkFrom: string | null = null; // node armed for a keyboard link (L)
  private nudgeSaveTimer: number | null = null; // debounced persist of arrow-nudges

  constructor(private readonly canvas: HTMLCanvasElement, private readonly host: KeyboardHost) {
    host.listen(canvas, "keydown", (e) => this.onKeyDown(e as KeyboardEvent));
  }

  /** The armed-link preview line (from the L-armed node to the current
   *  selection), recomputed on demand so navigation keeps it tracking. */
  get linkPreview(): { from: string; to: Point } | null {
    if (!this.keyLinkFrom) return null;
    const sel = this.host.selection();
    const tgt = sel.node && sel.node !== this.keyLinkFrom ? sel.node : this.keyLinkFrom;
    const to = this.centerOf(tgt);
    return to ? { from: this.keyLinkFrom, to } : null;
  }

  /** Clear per-model keyboard state on model switch. */
  reset(): void {
    this.clearLink();
    this.navAnchor = null;
    if (this.nudgeSaveTimer !== null) {
      window.clearTimeout(this.nudgeSaveTimer);
      this.nudgeSaveTimer = null;
    }
  }

  /** Cancel an armed keyboard link (a new pointer gesture does this). */
  clearLink(): void {
    this.keyLinkFrom = null;
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.host.isRenaming()) return; // the rename input handles its own keys
    if (!this.host.hasFolder()) return;

    // Map the press to a command; "none" is left to Obsidian (so we never shadow
    // its shortcuts), every handled command preventDefaults.
    const cmd = routeKey(
      { key: e.key, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey },
      { node: this.host.selection().node },
    );
    if (cmd.kind === "none") return;
    e.preventDefault();
    switch (cmd.kind) {
      case "export":
        this.host.openExportMenuAt(this.canvasMenuAnchor());
        break;
      case "tidy":
        void this.host.tidy();
        break;
      case "shortcuts":
        new ShortcutsModal(this.host.app).open();
        break;
      case "selectStep":
        this.kbSelectStep(cmd.dir);
        break;
      case "selectEdgeStep":
        this.kbSelectEdgeStep(cmd.dir);
        break;
      case "selectLoopStep":
        this.kbSelectLoopStep(cmd.dir);
        break;
      case "addNode":
        void this.kbAddNode();
        break;
      case "armLink":
        this.kbArmLink();
        break;
      case "enter":
        void this.kbEnter();
        break;
      case "rename": {
        const node = this.host.selection().node;
        if (node) this.host.startRename(node);
        break;
      }
      case "deleteSelection":
        void this.host.deleteSelection();
        break;
      case "escape":
        this.kbEscape();
        break;
      case "nudge":
        this.kbNudge(cmd.dx, cmd.dy, cmd.big);
        break;
      case "zoom":
        this.kbZoom(cmd.factor);
        break;
      case "fit":
        this.host.fitToContent();
        break;
    }
  }

  // ---- helpers (mirror the app's `_kb*` handlers) --------------------------

  /** Top-left of the canvas — a stable anchor for keyboard-opened menus. */
  private canvasMenuAnchor(): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + 8, y: r.top + 8 };
  }

  /** Center (world) of a node's box, or null when it has no box. */
  private centerOf(id: string): Point | null {
    const b = this.host.scene()?.boxes.get(id);
    return b ? { x: b.cx, y: b.cy } : null;
  }

  /** Pan so a world point sits inside the viewport (60px margin), centering it
   *  when outside — mirrors the app's `_ensureVisible`. */
  private ensureVisible(world: Point): void {
    const camera = this.host.camera;
    const s = camera.toScreen(world.x, world.y);
    const m = 60;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (s.x >= m && s.y >= m && s.x <= w - m && s.y <= h - m) return;
    camera.tx = w / 2 - world.x * camera.scale;
    camera.ty = h / 2 - world.y * camera.scale;
    this.host.persistViewport();
  }

  /** Tab / Shift+Tab: cycle node selection; across a selected edge, step to an
   *  endpoint (target on +1, source on −1). */
  private kbSelectStep(dir: number): void {
    const graph = this.host.graph();
    const scene = this.host.scene();
    if (!graph || !scene) return;
    const sel = this.host.selection();
    if (sel.edge) {
      const g = scene.edges.find((x) => x.id === sel.edge);
      if (g) {
        const to = dir > 0 ? g.target : g.source;
        this.host.select(to, null, null);
        this.navAnchor = to;
        const c = this.centerOf(to);
        if (c) this.ensureVisible(c);
        this.host.render();
      }
      return;
    }
    const next = stepId(graph.nodes.map((n) => n.id), sel.node, dir);
    if (next === null) return;
    this.host.select(next, null, null);
    this.navAnchor = next;
    const c = this.centerOf(next);
    if (c) this.ensureVisible(c);
    this.host.render();
  }

  /** E / Shift+E: cycle edges — those incident to the anchor node if any, else all. */
  private kbSelectEdgeStep(dir: number): void {
    const scene = this.host.scene();
    if (!scene) return;
    const sel = this.host.selection();
    const anchor = sel.node ?? this.navAnchor;
    const pool = anchor
      ? scene.edges.filter((e) => e.source === anchor || e.target === anchor)
      : scene.edges;
    if (pool.length === 0) return;
    this.navAnchor = anchor;
    const next = stepId(pool.map((e) => e.id), sel.edge, dir);
    if (next === null) return;
    this.host.select(null, next, null);
    const g = scene.edges.find((x) => x.id === next);
    if (g) this.ensureVisible(g.mid);
    this.host.render();
  }

  /** O / Shift+O: cycle loop badges. */
  private kbSelectLoopStep(dir: number): void {
    const graph = this.host.graph();
    if (!graph) return;
    const next = stepId(graph.loops.map((l) => l.key), this.host.selection().loop, dir);
    if (next === null) return;
    this.host.select(null, null, next);
    const b = this.host.scene()?.badges.get(next);
    if (b) this.ensureVisible(b);
    this.host.render();
  }

  /** N: create a node at the viewport center and start renaming it. */
  private async kbAddNode(): Promise<void> {
    const world = this.host.camera.toWorld(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
    await this.host.createNodeAt(world);
  }

  /** L: arm a link from the selected node. Tab/E navigation then moves the
   *  preview's far end; Enter on another node completes it, Escape cancels. */
  private kbArmLink(): void {
    const node = this.host.selection().node;
    if (!node) return;
    this.keyLinkFrom = node;
    this.host.render();
  }

  /** Enter: context-sensitive — complete an armed link, else toggle the selected
   *  edge's menu, else open the selected loop's note, else rename the node. */
  private async kbEnter(): Promise<void> {
    const sel = this.host.selection();
    if (this.keyLinkFrom) {
      const from = this.keyLinkFrom;
      const to = sel.node;
      this.clearLink();
      if (to && to !== from && this.host.hasFolder()) {
        await this.host.createLink(from, to);
        this.host.select(to, null, null);
      }
      this.host.render();
      return;
    }
    if (sel.edge) {
      this.host.toggleEdgeMenu();
      this.host.render();
      return;
    }
    if (sel.loop) {
      await this.host.openLoopNote(sel.loop);
      return;
    }
    if (sel.node) this.host.startRename(sel.node);
  }

  /** Escape: cancel an armed link first, otherwise clear the selection. */
  private kbEscape(): void {
    if (this.keyLinkFrom) {
      this.clearLink();
      this.host.render();
      return;
    }
    this.host.select(null, null, null);
    this.host.render();
  }

  /** Arrow keys: nudge the selected node (8px, or 40px with Shift) and persist
   *  after a 450ms pause, or pan the view (40px, or 160px with Shift) when
   *  nothing is selected — the app's `_kbNudge` magnitudes. */
  private kbNudge(dx: number, dy: number, big: boolean): void {
    const graph = this.host.graph();
    const sel = this.host.selection();
    if (sel.node && graph) {
      const node = graph.nodes.find((n) => n.id === sel.node);
      if (!node) return;
      const step = big ? 40 : 8;
      node.x += dx * step;
      node.y += dy * step;
      this.host.rebuildScene();
      this.host.render();
      this.scheduleNudgeSave(node.id);
      return;
    }
    const step = big ? 160 : 40;
    this.host.camera.panBy(-dx * step, -dy * step);
    this.host.persistViewport();
    this.host.render();
  }

  private scheduleNudgeSave(id: string): void {
    if (this.nudgeSaveTimer !== null) window.clearTimeout(this.nudgeSaveTimer);
    this.nudgeSaveTimer = window.setTimeout(() => {
      this.nudgeSaveTimer = null;
      const node = this.host.graph()?.nodes.find((n) => n.id === id);
      if (node) void this.host.persistNodePosition(id, node.x, node.y);
    }, 450);
  }

  /** +/−: zoom a step about the viewport center, like the app's keyboard zoom. */
  private kbZoom(factor: number): void {
    this.host.camera.zoomAt(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2, factor);
    this.host.persistViewport();
    this.host.render();
  }
}
