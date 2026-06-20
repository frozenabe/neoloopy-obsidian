/**
 * CanvasView — the interactive causal-loop-diagram surface, an Obsidian
 * ItemView backed by an HTML5 Canvas. Renders via the pure `painter`, hit-tests
 * via `geometry`, and drives all reads/writes through the active
 * `NeoloopyEngine` (so the engine flag transparently switches the backend).
 *
 * Interactions ported from the desktop app: pan (drag empty space / two-finger),
 * zoom-to-cursor (wheel / pinch), select node·edge·loop, drag to move a node,
 * drag from a selected node's connect-ring to draw a link, double-click to add a
 * variable, F2/Enter to rename, Delete to remove, plus a toolbar (model picker,
 * add variable, tidy, export). External vault edits flash the violet live-edit
 * spotlight, matching the app.
 */

import {
  ItemView,
  Menu,
  Notice,
  TAbstractFile,
  TFolder,
  WorkspaceLeaf,
  debounce,
  normalizePath,
} from "obsidian";
import type NeoloopyPlugin from "../main";
import { GraphView, QuantPatch } from "../engine/engine";
import { LoopType } from "../engine/types";
import { ParentAnchor, linkPointsToModel } from "../engine/subsystemLinks";
import { parentPath } from "../engine/storage";
import { Camera, Point } from "./camera";
import { loopNoteKey } from "./loopKeys";
import { InsightPanel } from "./insightPanel";
import { CanvasToolbar } from "./canvasToolbar";
import { SelectionChrome } from "./selectionChrome";
import { EquationModal, promptText } from "./dialogs";
import { LoopHighlight, Scene, paint } from "./painter";
import { Theme, resolveTheme } from "./theme";
import { SceneCache } from "./sceneCache";
import { PointerInteraction } from "./pointerInteraction";
import { KeyboardController } from "./keyboardController";
import { ModelController } from "./modelController";
import { LiveEditWatcher } from "./liveEditWatcher";
import { SelectionAnimator } from "./selectionAnimator";
import { EdgeGeom, loopEdgeIds } from "./geometry";
import { reconcileActiveModel } from "./modelPicker";

export const VIEW_TYPE_CANVAS = "neoloopy-canvas";

/** Session-only camera memory per model folder (mirrors the app's _viewMemory). */
const viewMemory = new Map<string, { tx: number; ty: number; scale: number }>();

/** Last path segment (folder/file basename) of a vault-relative path. */
function leafName(path: string): string {
  const parts = path.split("/").filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export class CanvasView extends ItemView {
  private readonly plugin: NeoloopyPlugin;

  private folder: string | null = null;
  private graph: GraphView | null = null;
  private scene: Scene | null = null;
  /** Builds + caches the renderable scene (label-width memo, dirty-tracking). */
  private readonly sceneCache = new SceneCache();
  private readonly camera = new Camera();
  private fittedOnce = false;

  private selNode: string | null = null;
  private selEdge: string | null = null;
  private selLoop: string | null = null;
  private loopHi: LoopHighlight | null = null;

  /** Frozen bow side per edge id, so a node drag never flips an unrelated arc. */
  private readonly bowSigns = new Map<string, number>();

  /** User-dragged loop-badge positions (loop.key → world point). Session-only,
   *  matching the app's `loopBadgeOverrides` — never written to the vault. */
  private readonly loopBadgeOverrides = new Map<string, Point>();

  // Pointer state machine (pan/zoom/pinch/move/draw-link/bow-edge) and the
  // app-parity keyboard handler, each owning its own transient state.
  private pointer!: PointerInteraction;
  private keyboard!: KeyboardController;
  /** Guarded engine-write facade; the selection-pulse/loop-flow rAF loop; and
   *  the external-edit watcher that drives the violet live-edit spotlight. */
  private model!: ModelController;
  private animator!: SelectionAnimator;
  private liveWatcher!: LiveEditWatcher;

  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private wrapper!: HTMLElement;
  private liveChip!: HTMLElement;
  private insightPanel!: HTMLElement;
  private insightPanelView!: InsightPanel;
  private toolbar!: CanvasToolbar;
  private renameInput: HTMLInputElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly persistViewport: () => void;

  // The on-canvas selection chrome (the ⋯ reveal menus, loop badge-note button,
  // and trash FAB) is owned by SelectionChrome — a screen-space HTML overlay
  // layered over the canvas. Public so the view-smoke harness can poke it.
  chrome!: SelectionChrome;
  /** model.json loop notes for the open model, by Dart loop key (note-state cue). */
  private loopNotesCache: Record<string, string> = {};
  /** Parent-system anchors for the open model, recomputed on each model open. */
  private parentsCache: ParentAnchor[] = [];

  /** Resolved theme, cached across renders; invalidated on Obsidian's
   *  `css-change` (theme/appearance switch). `resolveTheme()` reads CSS vars
   *  off the document, so recomputing it every frame is pure waste. */
  private themeCache: Theme | null = null;
  /** Dart loop-key memo (engine loop key → canonical note key), rebuilt on each
   *  graph reload. `dartLoopKey` runs on every overlay frame per loop; the
   *  derivation does an O(n) label lookup per member id, so memoizing it removes
   *  per-frame work that only changes when the graph does. */
  private readonly loopKeyMemo = new Map<string, string>();

  constructor(leaf: WorkspaceLeaf, plugin: NeoloopyPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.persistViewport = debounce(() => this.rememberCamera(), 500, true);
  }

  getViewType(): string {
    return VIEW_TYPE_CANVAS;
  }

  getDisplayText(): string {
    return this.graph ? this.graph.manifest.name : "neoloopy canvas";
  }

  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("neoloopy-canvas-root");

    this.toolbar = new CanvasToolbar(root, {
      app: this.app,
      listModels: () => this.plugin.engine.listModels(),
      currentFolder: () => this.folder,
      openModel: (folder) => void this.openModel(folder),
      newModel: () => void this.newModel(),
      renameModel: () => void this.renameModel(),
      tidy: () => void this.tidy(),
      openExportMenu: (evt) => this.openExportMenu(evt),
      toggleInsightPanel: () => this.toggleInsightPanel(),
    });

    const split = root.createDiv({ cls: "neoloopy-canvas-split" });
    this.wrapper = split.createDiv({ cls: "neoloopy-canvas-wrap" });
    this.insightPanel = split.createDiv({ cls: "neoloopy-insight-panel" });
    this.insightPanel.toggleClass("is-open", this.plugin.settings.insightPanelOpen);
    this.insightPanelView = new InsightPanel(this.insightPanel, {
      isOpen: () => this.plugin.settings.insightPanelOpen,
      graph: () => this.graph,
      selectedLoop: () => this.selLoop,
      selectLoop: (key) => {
        this.select(null, null, key);
        this.render();
      },
      listen: (el, type, cb) => this.registerDomEvent(el, type as keyof HTMLElementEventMap, cb),
      parents: () => this.parentsCache,
      openModel: (folder, focusVarId) => {
        void this.openModel(folder, focusVarId);
      },
      openSystemNote: () => {
        void this.openSystemNote();
      },
    });

    this.canvas = this.wrapper.createEl("canvas", { cls: "neoloopy-canvas" });
    this.canvas.tabIndex = 0;
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;

    this.liveChip = this.wrapper.createDiv({ text: "Live edit", cls: "neoloopy-live-chip" });

    this.chrome = new SelectionChrome(this.wrapper, {
      camera: this.camera,
      scene: () => this.scene,
      graph: () => this.graph,
      selection: () => ({ node: this.selNode, edge: this.selEdge, loop: this.selLoop }),
      isIdle: () => this.pointer.isIdle(),
      selectedEdgeGeom: () => this.selectedEdgeGeom(),
      loopHasNote: (lp) => (this.loopNotesCache[this.dartLoopKey(lp)] ?? "").trim().length > 0,
      listen: (el, type, cb) => this.registerDomEvent(el, type as keyof HTMLElementEventMap, cb),
      setNodeType: (id, t) => void this.setNodeType(id, t),
      setNodeGroup: (id, grp) => void this.setNodeGroup(id, grp),
      openSubsystemMenu: (ev) => void this.openSubsystemMenu(ev),
      openEquationModal: () => this.openEquationModal(),
      patchLink: (g, patch) => void this.patchLink(g, patch),
      deleteSelection: () => void this.deleteSelection(),
      openLoopNote: (key) => void this.openLoopNote(key),
    });

    this.keyboard = new KeyboardController(this.canvas, {
      app: this.app,
      camera: this.camera,
      scene: () => this.scene,
      graph: () => this.graph,
      selection: () => ({ node: this.selNode, edge: this.selEdge, loop: this.selLoop }),
      hasFolder: () => this.folder !== null,
      isRenaming: () => this.renameInput !== null,
      listen: (el, type, cb) => this.registerDomEvent(el, type as keyof HTMLElementEventMap, cb),
      select: (node, edge, loop) => this.select(node, edge, loop),
      render: () => this.render(),
      rebuildScene: () => this.rebuildScene(),
      persistViewport: () => this.persistViewport(),
      startRename: (id) => this.startRename(id),
      toggleEdgeMenu: () => this.chrome.toggleEdgeMenu(),
      openExportMenuAt: (pos) => this.openExportMenuAt(pos),
      openLoopNote: (key) => this.openLoopNote(key),
      tidy: () => this.tidy(),
      fitToContent: () => this.fitToContent(),
      createNodeAt: (world) => this.createNodeAt(world),
      createLink: (from, to) => this.createLink(from, to),
      persistNodePosition: (id, x, y) => this.persistNodePosition(id, x, y),
      deleteSelection: () => this.deleteSelection(),
    });

    this.pointer = new PointerInteraction(this.canvas, {
      camera: this.camera,
      scene: () => this.scene,
      graph: () => this.graph,
      selection: () => ({ node: this.selNode, edge: this.selEdge, loop: this.selLoop }),
      hasFolder: () => this.folder !== null,
      loopBadgeOverrides: this.loopBadgeOverrides,
      listen: (el, type, cb, opts) =>
        this.registerDomEvent(el, type as keyof HTMLElementEventMap, cb, opts),
      select: (node, edge, loop) => this.select(node, edge, loop),
      render: () => this.render(),
      rebuildScene: () => this.rebuildScene(),
      persistViewport: () => this.persistViewport(),
      commitRename: () => this.commitRename(),
      cancelArmedLink: () => this.keyboard.clearLink(),
      startRename: (id) => this.startRename(id),
      persistNodePosition: (id, x, y) => this.persistNodePosition(id, x, y),
      createLink: (from, to) => this.createLink(from, to),
      commitBow: (s, t, c) => this.commitBow(s, t, c),
      createNodeAt: (world) => this.createNodeAt(world),
    });

    this.animator = new SelectionAnimator(() => this.render());
    this.liveWatcher = new LiveEditWatcher(this.liveChip, {
      folder: () => this.folder,
      graph: () => this.graph,
      reloadGraph: () => this.reloadGraph(),
      render: () => this.render(),
      spotlightEnabled: () => this.plugin.settings.liveEditSpotlight,
    });
    // Writes are guarded against the watcher so our own saves don't self-flash.
    this.model = new ModelController(this.plugin.engine, () => this.liveWatcher.markSelfWrite());

    this.registerVaultEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.wrapper);

    await this.toolbar.refreshModelList();
    await this.openInitialModel();
    this.insightPanelView.render();
    this.resize();
  }

  async onClose(): Promise<void> {
    this.rememberCamera();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.liveWatcher.dispose();
    this.animator.stop();
  }

  /** Public entry used by the plugin command/ribbon to focus a model. */
  async showModel(folder: string): Promise<void> {
    await this.openModel(folder);
  }

  // ---- command surface (called from the plugin's command palette) ----------

  hasModel(): boolean {
    return this.folder !== null;
  }

  currentFolder(): string | null {
    return this.folder;
  }

  async cmdNewModel(): Promise<void> {
    await this.newModel();
  }

  async cmdRenameModel(): Promise<void> {
    await this.renameModel();
  }

  async cmdAddVariable(): Promise<void> {
    await this.addVariableAtCenter();
  }

  async cmdTidy(): Promise<void> {
    await this.tidy();
  }

  async cmdExport(fmt: "markdown" | "json" | "mermaid"): Promise<void> {
    await this.exportAs(fmt);
  }

  reportLoops(): void {
    if (!this.graph) {
      new Notice("No model open.");
      return;
    }
    const loops = this.graph.loops;
    if (loops.length === 0) {
      new Notice("No feedback loops detected.");
      return;
    }
    const labels = loops
      .map((l) => this.graph?.labels.get(l.key) ?? "?")
      .sort();
    new Notice(`${loops.length} loop${loops.length === 1 ? "" : "s"}: ${labels.join(", ")}`);
  }


  private async openInitialModel(): Promise<void> {
    if (this.folder) return;
    const models = await this.plugin.engine.listModels();
    if (models.length > 0) await this.openModel(models[0].folder);
    else this.render();
  }

  // ---- model operations ----------------------------------------------------

  private async openModel(folder: string, focusVarId?: string): Promise<void> {
    if (this.folder && this.folder !== folder) this.rememberCamera();
    this.folder = folder;
    this.select(null, null, null);
    this.keyboard.reset();
    this.bowSigns.clear();
    this.loopBadgeOverrides.clear();
    this.fittedOnce = false;
    const mem = viewMemory.get(folder);
    if (mem) {
      this.camera.tx = mem.tx;
      this.camera.ty = mem.ty;
      this.camera.scale = mem.scale;
      this.fittedOnce = true;
    }
    await this.reloadGraph();
    this.toolbar.setSelected(folder);
    this.fitIfNeeded();
    this.render();
    if (focusVarId && this.graph) {
      const n = this.graph.nodes.find((x) => x.id === focusVarId);
      if (n) {
        this.select(n.id, null, null);
        this.camera.centerOn(n.x, n.y, this.canvas.clientWidth, this.canvas.clientHeight);
        this.render();
      }
    }
    await this.refreshParents(folder);
    this.refreshTitleChrome();
  }

  /**
   * Push the live model name into both the tab title and the centered view
   * header. The tab title comes from getDisplayText(), but Obsidian caches it
   * until the leaf is told to refresh — without updateHeader() the tab keeps the
   * previous model's name. updateHeader() re-reads it for the TAB; it does NOT
   * re-read the inline view-header title (`view.titleEl`), which is set once at
   * view-load (when no model is open). Set that one directly so the tab and the
   * centered header agree on the live model name. Called on model switch and on
   * rename.
   */
  private refreshTitleChrome(): void {
    (this.leaf as unknown as { updateHeader(): void }).updateHeader();
    const titleEl = (this as unknown as { titleEl?: { setText(t: string): void } }).titleEl;
    if (titleEl) titleEl.setText(this.getDisplayText());
  }

  private async reloadGraph(): Promise<void> {
    if (!this.folder) return;
    // The open model's folder can vanish between a scheduled reload and now: an
    // external delete fires the live watcher, which then reloads against a
    // missing manifest. Bail (dropping the stale graph) instead of throwing —
    // the picker resync that runs alongside switches away from the deleted model.
    if (this.app.vault.getAbstractFileByPath(normalizePath(this.folder)) == null) {
      this.graph = null;
      return;
    }
    this.graph = await this.plugin.engine.loadGraph(this.folder);
    // The graph's labels (and thus every derived loop key) may have changed.
    this.loopKeyMemo.clear();
    this.loopNotesCache = await this.plugin.engine
      .getLoopNotes(this.folder)
      .catch(() => ({}));
    this.rebuildScene();
    // Drop selection that no longer exists.
    if (this.selNode && !this.graph.nodes.some((n) => n.id === this.selNode))
      this.selNode = null;
    if (this.selLoop && !this.graph.loops.some((l) => l.key === this.selLoop))
      this.selLoop = null;
    this.computeLoopHighlight();
    this.insightPanelView.render();
  }

  /** Rebuild the renderable scene through the cache (label-width memo +
   *  dirty-tracking); the cache returns the same scene when nothing moved. */
  private rebuildScene(): void {
    this.scene = this.sceneCache.build(this.graph, this.bowSigns, this.loopBadgeOverrides);
  }

  private async newModel(): Promise<void> {
    const name = await promptText(this.app, {
      title: "New model",
      placeholder: "Model title",
      initial: `Model ${new Date().toLocaleDateString()}`,
      cta: "Create",
    });
    if (name === null) return; // cancelled the prompt
    // The `+` handler runs as `void this.newModel()`, so a rejected createModel
    // would otherwise vanish into an unhandled rejection — the click looks dead.
    // Catch it and surface the reason instead.
    try {
      const ref = await this.model.createModel(name);
      await this.toolbar.refreshModelList();
      await this.openModel(ref.folder);
      new Notice(`Created "${ref.name}"`);
    } catch (e) {
      new Notice(`Couldn't create model: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async renameModel(): Promise<void> {
    const folder = this.folder;
    const graph = this.graph;
    if (!folder || !graph) {
      new Notice("Open or create a model first.");
      return;
    }
    const current = graph.manifest.name;
    const name = await promptText(this.app, {
      title: "Rename model",
      placeholder: "Model title",
      initial: current,
      cta: "Rename",
    });
    if (name === null || name === current) return; // cancelled or unchanged
    try {
      const ref = await this.model.renameModel(folder, name);
      // The folder may have moved on disk (the title's slug changed). Repoint the
      // view, its per-folder camera memory, and the live graph so later reads/
      // writes and the picker all target the new path.
      this.folder = ref.folder;
      if (folder !== ref.folder) {
        const mem = viewMemory.get(folder);
        if (mem) {
          viewMemory.set(ref.folder, mem);
          viewMemory.delete(folder);
        }
      }
      graph.manifest.name = ref.name;
      graph.folder = ref.folder;
      await this.toolbar.refreshModelList();
      this.toolbar.setSelected(ref.folder);
      this.refreshTitleChrome();
      new Notice(`Renamed to "${ref.name}"`);
    } catch (e) {
      new Notice(`Couldn't rename model: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async addVariableAtCenter(): Promise<void> {
    if (!this.folder) {
      new Notice("Open or create a model first.");
      return;
    }
    const c = this.camera.toWorld(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
    const v = await this.model.addVariable(this.folder, { label: "", x: c.x, y: c.y });
    await this.reloadGraph();
    this.selNode = v.id;
    this.selEdge = this.selLoop = null;
    this.render();
    this.startRename(v.id);
  }

  private async tidy(): Promise<void> {
    if (!this.folder) return;
    await this.model.relayout(this.folder);
    await this.reloadGraph();
    this.fittedOnce = false;
    this.fitIfNeeded();
    this.render();
  }

  private buildExportMenu(): Menu {
    const menu = new Menu();
    for (const fmt of ["markdown", "json", "mermaid"] as const) {
      menu.addItem((item) =>
        item.setTitle(`Export ${fmt}`).onClick(() => void this.exportAs(fmt)),
      );
    }
    return menu;
  }

  private openExportMenu(evt: MouseEvent): void {
    if (!this.folder) return;
    this.buildExportMenu().showAtMouseEvent(evt);
  }

  /** Show the export menu at a fixed point — used by the Cmd/Ctrl+E shortcut,
   *  which has no pointer event to anchor on. */
  private openExportMenuAt(pos: { x: number; y: number }): void {
    if (!this.folder) return;
    this.buildExportMenu().showAtPosition(pos);
  }

  private async exportAs(fmt: "markdown" | "json" | "mermaid"): Promise<void> {
    if (!this.folder || !this.graph) return;
    const out = await this.plugin.engine.export(this.folder, fmt);
    const base = (this.graph.manifest.name || "model").replace(/[\\/:*?"<>|]+/g, "-");
    let path = `${this.folder}/${base}.${out.ext}`;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(normalizePath(path)) != null) {
      path = `${this.folder}/${base}-${n}.${out.ext}`;
      n++;
    }
    this.liveWatcher.markSelfWrite();
    await this.app.vault.create(path, out.content);
    new Notice(`Exported to ${path}`);
    await this.app.workspace.openLinkText(path, "", true);
  }

  // ---- rendering -----------------------------------------------------------

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.fitIfNeeded();
    this.render();
  }

  /** Fit the camera to the scene once per model load; the cache owns the
   *  bounds math, the view keeps the "fit only once" policy (camera memory). */
  private fitIfNeeded(): void {
    if (this.fittedOnce) return;
    if (this.sceneCache.fit(this.camera, this.canvas.clientWidth, this.canvas.clientHeight))
      this.fittedOnce = true;
  }

  /** Re-fit the camera to the whole model (the keyboard `0` key). */
  private fitToContent(): void {
    this.fittedOnce = false;
    this.fitIfNeeded();
    this.persistViewport();
    this.render();
  }

  private render(): void {
    if (!this.ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const theme = (this.themeCache ??= resolveTheme());
    const scene: Scene = this.scene ?? {
      nodes: [],
      boxes: new Map(),
      edges: [],
      loops: [],
      labels: new Map(),
      badges: new Map(),
    };
    paint(this.ctx, scene, this.camera, theme, {
      cssWidth: this.canvas.clientWidth,
      cssHeight: this.canvas.clientHeight,
      dpr,
      selectedNodeId: this.selNode,
      selectedEdgeId: this.selEdge,
      selectedLoopKey: this.selLoop,
      liveNodeIds: this.liveWatcher.litNodes,
      // The link-preview line is driven by either a pointer drag (drawLink) or a
      // keyboard-armed link (L); they're mutually exclusive, so take whichever.
      linkPreview: this.pointer.linkPreview ?? this.keyboard.linkPreview,
      connectNodeId: this.pointer.connectNode,
      loopHighlight: this.loopHi,
      pulsePhase: this.animator.pulsePhase,
      flowPhase: this.animator.flowPhase,
    });
    this.chrome.update();
  }

  // ---- insight panel -------------------------------------------------------

  private toggleInsightPanel(): void {
    const open = !this.plugin.settings.insightPanelOpen;
    this.plugin.settings.insightPanelOpen = open;
    void this.plugin.saveSettings();
    this.insightPanel.toggleClass("is-open", open);
    this.resize();
    this.insightPanelView.render();
  }

  // ---- events --------------------------------------------------------------

  /** Canvas pointer/keyboard events are bound by PointerInteraction and
   *  KeyboardController; the view only watches the vault for external edits. */
  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultChange(f)));
    // Renaming a model's folder in Obsidian's file explorer drives the title
    // (folder is canonical for an external rename — the user's choice) and keeps
    // the open model pointed at its new path.
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => void this.onVaultRename(f, oldPath)),
    );
    // A theme/appearance switch changes the resolved CSS colors — drop the cache
    // so the next render repaints in the new palette.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        this.themeCache = null;
        this.render();
      }),
    );
  }

  /**
   * Every modify/create/delete feeds the live-edit watcher (which only reacts to
   * the open model's own files). A change to a model folder or a `model.json`
   * also changes the *set* of models on disk, so it resyncs the picker — that's
   * what makes an external folder delete drop out of the dropdown live, instead
   * of lingering until the next canvas refresh.
   */
  private onVaultChange(file: TAbstractFile): void {
    this.liveWatcher.onVaultChange(file);
    if (file instanceof TFolder || file.name === "model.json") {
      this.pickerResync();
    }
  }

  /** Debounced: a folder delete fires one event but a model create can fan out
   *  several, and our own writes touch `model.json`; coalesce them. */
  private readonly pickerResync = debounce(() => void this.applyPickerResync(), 150, true);

  private async applyPickerResync(): Promise<void> {
    await this.toolbar.refreshModelList();
    const models = await this.plugin.engine.listModels();
    const decision = reconcileActiveModel(models, this.folder);
    if (decision.action === "switch") {
      await this.openModel(decision.folder);
      return;
    }
    if (decision.action === "clear") {
      this.clearOpenModel();
      return;
    }
    // keep: the rebuild cleared the <select>; re-point it at the open model and
    // refresh the tab/header in case its title was edited externally.
    if (this.folder) {
      this.toolbar.setSelected(this.folder);
      this.refreshTitleChrome();
    }
  }

  /** The open model's folder was deleted externally — drop to the empty state. */
  private clearOpenModel(): void {
    this.folder = null;
    this.graph = null;
    this.scene = null;
    this.select(null, null, null);
    this.refreshTitleChrome();
    this.render();
  }

  /** Handle an Obsidian file-explorer rename. */
  private async onVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
    // Our own renameModel moves the folder via fileManager.renameFile, which
    // fires this very event; ignore writes we made (the title/label was already
    // set deliberately) so we don't clobber it with the slugged basename.
    if (this.liveWatcher.inSelfWrite()) return;

    if (!(file instanceof TFolder)) {
      // Renaming the bare `model.json` would un-model the folder; just resync.
      if (file.name === "model.json" || oldPath.endsWith("/model.json")) {
        this.pickerResync();
        return;
      }
      // A variable note renamed in the explorer (`…/Nodes/<stem>.md`): the label
      // follows the filename — the node-level inverse of the folder→title sync.
      if (file.path.endsWith(".md") && leafName(parentPath(file.path)) === "Nodes") {
        await this.onNodeFileRename(file.path);
      }
      return;
    }
    const newPath = file.path;

    // If the renamed folder is itself a model (holds model.json), the title
    // follows the folder: rewrite model.json's name to the new folder name in
    // place — no re-slug, no move (we'd be fighting the rename the user made).
    // Renaming an ancestor folder only shifts paths; the re-point + rebuild
    // below handle that without touching any title.
    const models = await this.plugin.engine.listModels();
    const renamed = models.find((m) => m.folder === newPath);
    if (renamed) {
      const title = leafName(newPath);
      if (renamed.name !== title) {
        try {
          await this.model.retitleModel(newPath, title);
        } catch {
          /* keep the existing title if the in-place write fails */
        }
      }
    }

    // Follow the open model to its new path if it (or an ancestor) was renamed.
    if (this.folder === oldPath) {
      this.repointFolder(oldPath, newPath);
    } else if (this.folder && this.folder.startsWith(oldPath + "/")) {
      this.repointFolder(this.folder, newPath + this.folder.slice(oldPath.length));
    }

    await this.toolbar.refreshModelList();
    if (this.folder) {
      await this.reloadGraph(); // picks up the new manifest.name + path
      this.toolbar.setSelected(this.folder);
      this.refreshTitleChrome();
      this.render();
    }
  }

  /** A variable note was renamed in the vault (`<model>/Nodes/<stem>.md`): sync
   *  the node's label to the new filename, then refresh if it's the open model. */
  private async onNodeFileRename(newPath: string): Promise<void> {
    const modelFolder = parentPath(parentPath(newPath));
    const stem = leafName(newPath).replace(/\.md$/, "");
    const models = await this.plugin.engine.listModels();
    if (!models.some((m) => m.folder === modelFolder)) return;
    try {
      await this.model.relabelNodeFromFilename(modelFolder, stem);
    } catch {
      return; // unreadable/not a node note — leave it be
    }
    if (this.folder === modelFolder) {
      await this.reloadGraph(); // picks up the new label (and any re-normalized filename)
      this.render();
    }
  }

  /** Move the open model's folder reference (and its camera memory) to a new
   *  path after an external rename, so later reads/writes target the new dir. */
  private repointFolder(from: string, to: string): void {
    const mem = viewMemory.get(from);
    if (mem) {
      viewMemory.set(to, mem);
      viewMemory.delete(from);
    }
    this.folder = to;
    if (this.graph) this.graph.folder = to;
  }

  private async createNodeAt(world: Point): Promise<void> {
    if (!this.folder) return;
    // Open + focus the rename box NOW, synchronously within the pointer gesture,
    // so iOS raises the soft keyboard. Focusing it after the awaits below (what a
    // plain startRename call would do) forfeits the user-gesture token on iOS
    // WebKit: the node gets created but its name box stays un-keyboarded, so a
    // new node can't be named by touch. The box is rebound to the node's id once
    // the write settles.
    const input = this.openRenameInput("", this.camera.toScreen(world.x, world.y));
    const v = await this.model
      .addVariable(this.folder, { label: "", x: world.x, y: world.y })
      .catch((e) => {
        // Persist failed — don't strand the pre-opened input.
        if (this.renameInput === input) this.renameInput = null;
        input.remove();
        throw e;
      });
    await this.reloadGraph();
    this.select(v.id, null, null);
    this.render();
    this.bindRenameInput(input, v.id, "");
  }

  private async setNodeType(id: string, type: "stock" | "flow" | "auxiliary"): Promise<void> {
    if (!this.folder) return;
    await this.model.updateVariable(this.folder, id, { type });
    await this.reloadGraph();
    this.render();
  }

  /** Assign (or clear, with null) a node's curated group color. */
  private async setNodeGroup(id: string, group: string | null): Promise<void> {
    if (!this.folder) return;
    await this.model.updateVariable(this.folder, id, { group });
    await this.reloadGraph();
    this.render();
  }

  /** Open the ƒx modal to view/edit the selected variable's quant definition. */
  private openEquationModal(): void {
    if (!this.folder || !this.selNode || !this.graph) return;
    const id = this.selNode;
    const node = this.graph.nodes.find((n) => n.id === id);
    if (!node) return;
    new EquationModal(this.app, node, this.graph.nodes, (patch) =>
      this.setEquation(id, patch),
    ).open();
  }

  /** Write a variable's quant definition, then refresh the canvas. */
  private async setEquation(id: string, patch: QuantPatch): Promise<void> {
    if (!this.folder) return;
    await this.model.setEquation(this.folder, id, patch);
    await this.reloadGraph();
    this.render();
  }

  /** Subsystem affordance menu: link to a child model, open it, or unlink. */
  private async openSubsystemMenu(ev: MouseEvent): Promise<void> {
    if (!this.selNode || !this.folder) return;
    const node = this.graph?.nodes.find((n) => n.id === this.selNode);
    if (!node) return;
    const menu = new Menu();
    const linked = !!(node.subsystem && node.subsystem.trim().length);
    if (linked) {
      menu.addItem((i) =>
        i.setTitle("Open subsystem").setIcon("layers").onClick(() => void this.openSubsystem(node)),
      );
      menu.addItem((i) =>
        i.setTitle("Unlink subsystem").setIcon("unlink").onClick(() => void this.linkSubsystem(node.id, null)),
      );
    } else {
      const others = (await this.plugin.engine.listModels()).filter((m) => m.folder !== this.folder);
      if (others.length === 0) {
        menu.addItem((i) => i.setTitle("No other models to link").setDisabled(true));
      } else {
        for (const m of others) {
          menu.addItem((i) =>
            i.setTitle(`Link → ${m.name}`).setIcon("layers").onClick(() =>
              void this.linkSubsystem(node.id, { folder: m.folder, name: m.name }),
            ),
          );
        }
      }
    }
    menu.showAtMouseEvent(ev);
  }

  private async linkSubsystem(
    id: string,
    child: { folder: string; name: string } | null,
  ): Promise<void> {
    if (!this.folder) return;
    await this.model.setSubsystem(this.folder, id, child);
    await this.reloadGraph();
    this.render();
  }

  /** Resolve a node's stored `[[../<dir>/System|<alias>]]` link and open it. */
  private async openSubsystem(node: { subsystem?: string }): Promise<void> {
    const raw = (node.subsystem ?? "").trim();
    if (!raw) return;
    const models = await this.plugin.engine.listModels();
    const match = models.find((m) => linkPointsToModel(raw, { folder: m.folder, name: m.name }));
    if (!match) {
      new Notice("Subsystem model not found.");
      return;
    }
    await this.openModel(match.folder);
  }

  private async patchLink(
    g: { source: string; target: string },
    patch: {
      polarity?: "+" | "-";
      delay?: boolean;
      indirect?: boolean;
      nonlinear?: boolean;
      weight?: number;
      curvature?: number | null;
    },
  ): Promise<void> {
    if (!this.folder) return;
    await this.model.updateLink(this.folder, g.source, g.target, patch);
    await this.reloadGraph();
    this.render();
  }

  /** Persist a node's new position after a pointer drag or keyboard nudge (the
   *  move is already applied to the in-memory graph + scene). */
  private async persistNodePosition(id: string, x: number, y: number): Promise<void> {
    if (!this.folder) return;
    await this.model.moveVariable(this.folder, id, x, y);
  }

  /** Create a positive link A→B and reload; the caller selects the target. */
  private async createLink(from: string, to: string): Promise<void> {
    if (!this.folder) return;
    await this.model.addLink(this.folder, from, to, { polarity: "+" });
    await this.reloadGraph();
  }

  /** Persist an edge's dragged curvature (already applied to the in-memory link). */
  private async commitBow(source: string, target: string, curvature: number | undefined): Promise<void> {
    if (!this.folder) return;
    await this.model.updateLink(this.folder, source, target, { curvature });
  }

  private async deleteNode(id: string): Promise<void> {
    if (!this.folder) return;
    await this.model.removeVariable(this.folder, id);
    if (this.selNode === id) this.selNode = null;
    await this.reloadGraph();
    this.render();
  }

  private async deleteEdge(from: string, to: string): Promise<void> {
    if (!this.folder) return;
    await this.model.removeLink(this.folder, from, to);
    this.selEdge = null;
    await this.reloadGraph();
    this.render();
  }

  private async deleteSelection(): Promise<void> {
    if (!this.folder) return;
    if (this.selNode) {
      const id = this.selNode;
      await this.model.removeVariable(this.folder, id);
      this.selNode = null;
      await this.reloadGraph();
      this.render();
    } else if (this.selEdge && this.scene) {
      const g = this.scene.edges.find((x) => x.id === this.selEdge);
      if (g) {
        await this.model.removeLink(this.folder, g.source, g.target);
        this.selEdge = null;
        await this.reloadGraph();
        this.render();
      }
    }
  }

  // ---- inline rename -------------------------------------------------------

  private startRename(id: string): void {
    if (!this.scene) return;
    const box = this.scene.boxes.get(id);
    const node = this.graph?.nodes.find((n) => n.id === id);
    if (!box || !node) return;
    const input = this.openRenameInput(node.label, this.camera.toScreen(box.cx, box.cy));
    this.bindRenameInput(input, id, node.label);
  }

  /** Create, position, and focus the rename input, returned unbound. Split from
   *  the id-binding so `createNodeAt` can open + focus the box *synchronously
   *  inside the pointer gesture*: iOS only raises the soft keyboard for a focus()
   *  during a user gesture, which the awaits in createNodeAt would otherwise
   *  forfeit. `screen` is the canvas-space target (node box center). */
  private openRenameInput(label: string, screen: { x: number; y: number }): HTMLInputElement {
    this.commitRename();
    const input = this.wrapper.createEl("input", { type: "text", cls: "neoloopy-rename-input" });
    input.value = label;
    input.placeholder = "name…";
    // Position is the only genuinely dynamic style (follows the node on screen).
    input.style.setProperty("--nl-rename-left", `${screen.x - 70}px`);
    input.style.setProperty("--nl-rename-top", `${screen.y - 14}px`);
    this.renameInput = input;
    input.focus();
    input.select();
    return input;
  }

  /** Wire an open rename input to commit against `id` (Enter/blur save, Escape
   *  cancels), repositioning it to the node's settled box — a freshly-created
   *  node's input was placed at the raw tap point before the node existed. */
  private bindRenameInput(input: HTMLInputElement, id: string, prevLabel: string): void {
    const box = this.scene?.boxes.get(id);
    if (box) {
      const screen = this.camera.toScreen(box.cx, box.cy);
      input.style.setProperty("--nl-rename-left", `${screen.x - 70}px`);
      input.style.setProperty("--nl-rename-top", `${screen.y - 14}px`);
    }
    const finish = (commit: boolean) => {
      const value = input.value.trim();
      this.renameInput = null;
      input.remove();
      void this.endRename(id, commit ? value : null, prevLabel);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
      ev.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
  }

  private commitRename(): void {
    if (this.renameInput) {
      this.renameInput.blur();
    }
  }

  private async endRename(id: string, value: string | null, prevLabel: string): Promise<void> {
    if (!this.folder) return;
    if (value === null) {
      // Cancelled — discard a freshly-created empty variable.
      if (prevLabel.length === 0) {
        await this.model.removeVariable(this.folder, id);
        this.selNode = null;
        await this.reloadGraph();
      }
      this.render();
      return;
    }
    if (value.length === 0 && prevLabel.length === 0) {
      await this.model.removeVariable(this.folder, id);
      this.selNode = null;
    } else if (value !== prevLabel) {
      await this.model.updateVariable(this.folder, id, { label: value });
    }
    await this.reloadGraph();
    this.render();
  }

  // ---- selection helpers ---------------------------------------------------

  private select(node: string | null, edge: string | null, loop: string | null): void {
    // A new selection always starts collapsed (⋯), matching the app: the panel
    // only opens on an explicit toggle tap.
    if (node !== this.selNode) this.chrome.collapseNodeMenu();
    if (edge !== this.selEdge) this.chrome.collapseEdgeMenu();
    this.selNode = node;
    this.selEdge = edge;
    this.selLoop = loop;
    this.computeLoopHighlight();
    this.animator.sync(this.selNode !== null || this.selLoop !== null);
    this.insightPanelView.render();
  }

  /** Resolve the selected loop's member edges/nodes for the painter spotlight. */
  private computeLoopHighlight(): void {
    if (!this.selLoop || !this.graph) {
      this.loopHi = null;
      return;
    }
    const lp = this.graph.loops.find((l) => l.key === this.selLoop);
    this.loopHi = lp
      ? { edgeIds: loopEdgeIds(lp), nodeIds: new Set(lp.nodeIds), type: lp.type }
      : null;
  }

  private selectedEdgeGeom(): EdgeGeom | null {
    if (!this.selEdge || !this.scene) return null;
    return this.scene.edges.find((e) => e.id === this.selEdge) ?? null;
  }

  /**
   * The `model.json` loopNotes key for a loop — `<R|B>:<sorted unique variable
   * names>`, matching the engine's `loopKey`/Dart `loopNoteKey` so the note
   * shows in the app too. Resolves ids with `?? id` (not `|| id`) so an empty
   * label stays empty rather than falling back to the id. Derivation lives in
   * the shared `loopKeys` helper so the view and engine never drift.
   *
   * Memoized per loop (keyed by type + member ids, which the cache derivation is
   * cheap to build); the memo is cleared on every graph reload, so a label edit
   * recomputes the key.
   */
  private dartLoopKey(lp: { nodeIds: string[]; type: LoopType }): string {
    const memoKey = `${lp.type}:${lp.nodeIds.join(",")}`;
    let key = this.loopKeyMemo.get(memoKey);
    if (key === undefined) {
      key = loopNoteKey(lp, (id) => this.graph?.nodes.find((n) => n.id === id)?.label ?? id);
      this.loopKeyMemo.set(memoKey, key);
    }
    return key;
  }

  /**
   * Open a loop's canonical `Loops/<slug>.md` note, creating it on first use.
   * The file IS the note — its identity (loop type + member ids) lives in the
   * frontmatter, so the same file is read/written by the Dart app and CLI. The
   * engine owns find-or-create by identity; the canvas just opens the path.
   */
  private async openLoopNote(loopKey: string): Promise<void> {
    if (!this.folder || !this.graph) return;
    const lp = this.graph.loops.find((l) => l.key === loopKey);
    if (!lp) return;
    const dartKey = this.dartLoopKey(lp);
    this.liveWatcher.markSelfWrite();
    const path = await this.plugin.engine
      .loopNotePath(this.folder, dartKey)
      .catch(() => null);
    this.liveWatcher.markSelfWrite();
    if (!path) return;
    await this.app.workspace.openLinkText(normalizePath(path), "", true);
    // The file may have just been created — refresh the badge's note state.
    this.loopNotesCache = await this.plugin.engine
      .getLoopNotes(this.folder)
      .catch(() => this.loopNotesCache);
    this.render();
  }

  /** Recompute the parent-system list for `folder`; ignore if the user has
   *  since switched models (the scan is async and `folder` may be stale). */
  private async refreshParents(folder: string): Promise<void> {
    const parents = await this.plugin.engine.deriveParents(folder).catch(() => [] as ParentAnchor[]);
    if (this.folder !== folder) return;
    this.parentsCache = parents;
    this.insightPanelView.render();
  }

  /** Ensure the open model's System.md exists, then open it in Obsidian. */
  private async openSystemNote(): Promise<void> {
    if (!this.folder) return;
    this.liveWatcher.markSelfWrite();
    const path = await this.plugin.engine.ensureSystemNote(this.folder).catch(() => null);
    if (!path) return;
    await this.app.workspace.openLinkText(normalizePath(path), "", true);
  }

  private rememberCamera(): void {
    if (this.folder)
      viewMemory.set(this.folder, { tx: this.camera.tx, ty: this.camera.ty, scale: this.camera.scale });
  }
}
