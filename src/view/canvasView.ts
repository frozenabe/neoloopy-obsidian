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
  Platform,
  TAbstractFile,
  TFolder,
  WorkspaceLeaf,
  debounce,
  normalizePath,
} from "obsidian";
import type NeoloopyPlugin from "../main";
import {
  Camera,
  DetectedLoop,
  DiagramViewMode,
  EdgeGeom,
  GraphView,
  LoopHighlight,
  ParentAnchor,
  Point,
  QuantPatch,
  Scene,
  SceneCache,
  SINK_CLOUD,
  Theme,
  extraWithSfdPosition,
  linkPointsToModel,
  loopHighlightFor,
  paint,
  parentPath,
  retainedLoopKeyForMode,
  resolvedLoopNoteKey,
  resolveTheme,
} from "@neoloopy/cld-canvas";
import { InsightPanel } from "./insightPanel";
import { CanvasToolbar } from "./canvasToolbar";
import { SelectionChrome } from "./selectionChrome";
import { EquationModal, promptText } from "./dialogs";
import { PointerInteraction } from "./pointerInteraction";
import { KeyboardController } from "./keyboardController";
import { ModelController } from "./modelController";
import { LiveEditWatcher } from "./liveEditWatcher";
import { SelectionAnimator } from "./selectionAnimator";
import { reconcileActiveModel } from "./modelPicker";
import { loopReportMessage } from "../engine/insightsModel";

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
  private diagramMode: DiagramViewMode = "cld";

  private selNode: string | null = null;
  private selEdge: string | null = null;
  private selLoop: string | null = null;
  private loopHi: LoopHighlight | null = null;

  /** Frozen bow side per edge id, so a node drag never flips an unrelated arc. */
  private readonly bowSigns = new Map<string, number>();

  /** User-dragged loop-badge positions (loop.key → world point). Session-only,
   *  matching the app's `loopBadgeOverrides` — never written to the vault. */
  private readonly cldLoopBadgeOverrides = new Map<string, Point>();
  /** SFD geometry is independent of CLD geometry, so badge drags are too. */
  private readonly sfdLoopBadgeOverrides = new Map<string, Point>();

  private activeLoopBadgeOverrides(): Map<string, Point> {
    return this.diagramMode === "sfd"
      ? this.sfdLoopBadgeOverrides
      : this.cldLoopBadgeOverrides;
  }

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

  /** iOS soft-keyboard avoidance for the inline editor — the WebKit port of the
   *  Dart app's _kbRecenter*: while a name field is open we pin the canvas to the
   *  visible band above the keyboard (window.visualViewport, the equivalent of
   *  Flutter's MediaQuery.viewInsets) so the flex layout can't collapse it to 0,
   *  and animate-pan the edited node into that band. */
  private kbEditNodeId: string | null = null;
  private kbDebounce: number | null = null;
  private kbViewportHandler: (() => void) | null = null;
  private panRaf: number | null = null;

  private readonly persistViewport: () => void;

  // The on-canvas selection chrome (the ⋯ reveal menus, loop badge-note button,
  // and trash FAB) is owned by SelectionChrome — a screen-space HTML overlay
  // layered over the canvas. Public so the view-smoke harness can poke it.
  chrome!: SelectionChrome;
  /** Loop notes for the open model, by its compatibility-safe cache key. */
  private loopNotesCache: Record<string, string> = {};
  /** Parent-system anchors for the open model, recomputed on each model open. */
  private parentsCache: ParentAnchor[] = [];

  /** Resolved theme, cached across renders; invalidated on Obsidian's
   *  `css-change` (theme/appearance switch). `resolveTheme()` reads CSS vars
   *  off the document, so recomputing it every frame is pure waste. */
  private themeCache: Theme | null = null;
  /** Cache note keys derived from labels; cleared whenever the graph reloads. */
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
      diagramMode: () => this.diagramMode,
      setDiagramMode: (mode) => this.setDiagramMode(mode),
      tidy: () => void this.tidy(),
      openExportMenu: (evt) => this.openExportMenu(evt),
      toggleInsightPanel: () => this.toggleInsightPanel(),
    });

    const split = root.createDiv({ cls: "neoloopy-canvas-split" });
    this.wrapper = split.createDiv({ cls: "neoloopy-canvas-wrap" });
    this.insightPanel = split.createDiv({ cls: "neoloopy-insight-panel" });
    // On a phone the panel overlays the canvas (see styles.css); start it closed
    // so the canvas gets the full width and the camera can fit at a usable zoom.
    this.insightPanel.toggleClass("is-open", this.plugin.settings.insightPanelOpen && !Platform.isMobile);
    this.insightPanelView = new InsightPanel(this.insightPanel, {
      isOpen: () => this.plugin.settings.insightPanelOpen,
      graph: () => this.graph,
      diagramMode: () => this.diagramMode,
      setDiagramMode: (mode) => this.setDiagramMode(mode),
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
      diagramMode: () => this.diagramMode,
      selection: () => ({ node: this.selNode, edge: this.selEdge, loop: this.selLoop }),
      isIdle: () => this.pointer.isIdle(),
      selectedEdgeGeom: () => this.selectedEdgeGeom(),
      loopHasNote: (lp) =>
        (this.loopNotesCache[this.loopNoteCacheKey(lp)] ?? "").trim().length > 0,
      listen: (el, type, cb) => this.registerDomEvent(el, type as keyof HTMLElementEventMap, cb),
      setNodeType: (id, t) => void this.setNodeType(id, t),
      setFlowEndpoints: (id, from, to) => void this.setFlowEndpoints(id, from, to),
      setNodeGroup: (id, grp) => void this.setNodeGroup(id, grp),
      openSubsystemMenu: (ev) => void this.openSubsystemMenu(ev),
      openEquationModal: () => void this.openEquationModal(),
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
      createConnection: (from, to, at) => this.createConnection(from, to, at),
      previewNodePosition: (id, x, y) => this.previewNodePosition(id, x, y),
      persistNodePosition: (id, x, y) => this.persistNodePosition(id, x, y),
      deleteSelection: () => this.deleteSelection(),
    });

    this.pointer = new PointerInteraction(this.canvas, {
      camera: this.camera,
      scene: () => this.scene,
      graph: () => this.graph,
      selection: () => ({ node: this.selNode, edge: this.selEdge, loop: this.selLoop }),
      hasFolder: () => this.folder !== null,
      loopBadgeOverrides: () => this.activeLoopBadgeOverrides(),
      listen: (el, type, cb, opts) =>
        this.registerDomEvent(el, type as keyof HTMLElementEventMap, cb, opts),
      select: (node, edge, loop) => this.select(node, edge, loop),
      render: () => this.render(),
      rebuildScene: () => this.rebuildScene(),
      persistViewport: () => this.persistViewport(),
      commitRename: () => this.commitRename(),
      cancelArmedLink: () => this.keyboard.clearLink(),
      startRename: (id) => this.startRename(id),
      previewNodePosition: (id, x, y) => this.previewNodePosition(id, x, y),
      renderPosition: (id) => this.renderPosition(id),
      persistNodePosition: (id, x, y) => this.persistNodePosition(id, x, y),
      createConnection: (from, to, at) => this.createConnection(from, to, at),
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

    // iOS keyboard avoidance: window.visualViewport shrinks when the soft keyboard
    // opens (the WebKit analogue of Flutter's MediaQuery.viewInsets). Track it to
    // keep the inline editor's node in the visible band. Cleaned up in onClose.
    if (Platform.isMobile && window.visualViewport) {
      this.kbViewportHandler = () => this.onViewportChange();
      window.visualViewport.addEventListener("resize", this.kbViewportHandler);
      window.visualViewport.addEventListener("scroll", this.kbViewportHandler);
    }

    await this.toolbar.refreshModelList();
    await this.openInitialModel();
    this.insightPanelView.render();
    this.resize();
  }

  async onClose(): Promise<void> {
    this.rememberCamera();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.kbViewportHandler && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this.kbViewportHandler);
      window.visualViewport.removeEventListener("scroll", this.kbViewportHandler);
    }
    if (this.kbDebounce != null) window.clearTimeout(this.kbDebounce);
    if (this.panRaf != null) cancelAnimationFrame(this.panRaf);
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

  async cmdDuplicateModel(): Promise<void> {
    await this.duplicateCurrentModel();
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
    new Notice(loopReportMessage(this.graph));
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
    this.cldLoopBadgeOverrides.clear();
    this.sfdLoopBadgeOverrides.clear();
    this.fittedOnce = false;
    const mem = viewMemory.get(folder);
    if (mem) {
      this.camera.tx = mem.tx;
      this.camera.ty = mem.ty;
      this.camera.scale = mem.scale;
      this.fittedOnce = true;
    } else {
      // No saved viewport: start at the default zoom so a fresh/empty model can't
      // inherit the previous view's scale. An empty model has nothing to fit, so
      // without this the first node would be created at that stale scale (e.g.
      // 0.08 → invisibly tiny: "appears then disappears"). fitIfNeeded() below
      // overrides this for models that actually have content.
      this.camera.reset(this.canvas.clientWidth, this.canvas.clientHeight);
    }
    await this.reloadGraph();
    this.toolbar.setSelected(folder);
    this.fitIfNeeded();
    // Lock in the chosen view (restored / fitted / default) so a later resize —
    // e.g. the iOS soft keyboard opening when the rename field focuses — can't
    // re-run "fit once" and zoom to fill the screen with a single node. The one
    // case we leave pending is a content model whose canvas wasn't laid out yet
    // (0×0, so fit was skipped); its first real resize still owes a content fit.
    if (!this.fittedOnce) {
      const sized = this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0;
      const empty = !this.graph || this.graph.nodes.length === 0;
      if (sized || empty) this.fittedOnce = true;
    }
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
    this.loopKeyMemo.clear();
    this.loopNotesCache = await this.plugin.engine
      .getLoopNotes(this.folder)
      .catch(() => ({}));
    this.rebuildScene();
    // Drop selection that no longer exists.
    if (this.selNode && !this.graph.nodes.some((n) => n.id === this.selNode))
      this.selNode = null;
    if (this.selEdge && !this.scene?.edges.some((edge) =>
      edge.id === this.selEdge && edge.renderOnly !== true))
      this.selEdge = null;
    if (this.selLoop && !this.scene?.loops.some((loop) => loop.key === this.selLoop))
      this.selLoop = null;
    this.computeLoopHighlight();
    this.insightPanelView.render();
  }

  /** Rebuild the renderable scene through the cache (label-width memo +
   *  dirty-tracking); the cache returns the same scene when nothing moved. */
  private rebuildScene(): void {
    this.scene = this.sceneCache.build(
      this.graph,
      this.bowSigns,
      this.activeLoopBadgeOverrides(),
      this.diagramMode,
    );
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

  private async duplicateCurrentModel(): Promise<void> {
    const folder = this.folder;
    if (!folder) {
      new Notice("Open or create a model first.");
      return;
    }
    try {
      const ref = await this.model.duplicateModel(folder);
      await this.toolbar.refreshModelList();
      await this.openModel(ref.folder);
      new Notice(`Duplicated as "${ref.name}"`);
    } catch (e) {
      new Notice(`Couldn't duplicate model: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async addVariableAtCenter(): Promise<void> {
    if (!this.folder) {
      new Notice("Open or create a model first.");
      return;
    }
    const c = this.camera.toWorld(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
    const v = await this.model.addVariable(this.folder, {
      label: "",
      type: this.diagramMode === "sfd" ? "stock" : "auxiliary",
      x: c.x,
      y: c.y,
    });
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
      mode: this.diagramMode,
      nodes: [],
      boxes: new Map(),
      edges: [],
      pipes: [],
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

  private setDiagramMode(mode: DiagramViewMode): void {
    if (this.diagramMode === mode) return;
    this.diagramMode = mode;
    const keepLoop = retainedLoopKeyForMode(
      this.graph?.loops ?? [],
      this.selLoop,
      mode,
    );
    this.select(null, null, keepLoop);
    this.bowSigns.clear();
    this.rebuildScene();
    this.insightPanelView.render();
    this.toolbar.setDiagramMode(mode);
    this.render();
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
    // the write settles. The node is created right where you tapped; the camera
    // only moves (animated) if the rising keyboard would cover it — see
    // recenterForKeyboard, the WebKit port of the Dart app's behaviour.
    const input = this.openRenameInput("", this.camera.toScreen(world.x, world.y));
    const v = await this.model
      .addVariable(this.folder, {
        label: "",
        type: this.diagramMode === "sfd" ? "stock" : "auxiliary",
        x: world.x,
        y: world.y,
      })
      .catch((e) => {
        // Persist failed — don't strand the pre-opened input.
        if (this.renameInput === input) this.renameInput = null;
        input.remove();
        this.exitKbEditing();
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

  private async setFlowEndpoints(id: string, from: string, to: string): Promise<void> {
    if (!this.folder) return;
    try {
      await this.model.setFlowEndpoints(this.folder, id, from, to);
      await this.reloadGraph();
      this.render();
    } catch (e) {
      new Notice(`Couldn't set flow endpoints: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Assign (or clear, with null) a node's curated group color. */
  private async setNodeGroup(id: string, group: string | null): Promise<void> {
    if (!this.folder) return;
    await this.model.updateVariable(this.folder, id, { group });
    await this.reloadGraph();
    this.render();
  }

  /** Open the ƒx modal to view/edit the selected variable's quant definition. */
  private async openEquationModal(): Promise<void> {
    if (!this.folder || !this.selNode || !this.graph) return;
    const id = this.selNode;
    const folder = this.folder;
    const node = this.graph.nodes.find((n) => n.id === id);
    if (!node) return;
    // Pre-resolve the linked child's public interface (null for a plain node) so
    // the modal can render it read-only without an async builder. Fail closed.
    const iface = node.subsystem
      ? await this.plugin.engine.childInterface(folder, id).catch(() => null)
      : null;
    new EquationModal(this.app, node, this.graph.nodes, (patch) =>
      this.setEquation(id, patch), iface,
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
    if (this.diagramMode === "sfd") {
      await this.model.moveVariableSfd(this.folder, id, x, y);
    } else {
      await this.model.moveVariable(this.folder, id, x, y);
    }
  }

  private previewNodePosition(id: string, x: number, y: number): void {
    const node = this.graph?.nodes.find((n) => n.id === id);
    if (!node) return;
    if (this.diagramMode === "sfd") {
      node.extra = extraWithSfdPosition(node.extra, x, y);
    } else {
      node.x = x;
      node.y = y;
    }
  }

  private renderPosition(id: string): Point | null {
    const b = this.scene?.boxes.get(id);
    return b ? { x: b.cx, y: b.cy } : null;
  }

  /**
   * Complete a connect-ring gesture. CLD always creates an information link.
   * SFD creates a material flow only from a stock to another stock or to empty
   * canvas; all other node drops remain information connectors.
   */
  private async createConnection(from: string, to: string | null, at: Point): Promise<string | null> {
    if (!this.folder || !this.graph) return null;
    const src = this.graph.nodes.find((n) => n.id === from);
    const tgt = to ? this.graph.nodes.find((n) => n.id === to) : null;
    if (!src) return null;

    if (this.diagramMode === "sfd" && src.type === "stock") {
      if (tgt?.type === "stock") {
        const a = this.renderPosition(src.id) ?? { x: src.x, y: src.y };
        const b = this.renderPosition(tgt.id) ?? { x: tgt.x, y: tgt.y };
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const flow = await this.model.addVariable(this.folder, {
          label: "flow",
          type: "flow",
          x: mid.x,
          y: mid.y,
        });
        await this.model.setFlowEndpoints(this.folder, flow.id, src.id, tgt.id);
        await this.reloadGraph();
        return flow.id;
      }
      if (!tgt) {
        const flow = await this.model.addVariable(this.folder, {
          label: "flow",
          type: "flow",
          x: at.x,
          y: at.y,
        });
        await this.model.setFlowEndpoints(this.folder, flow.id, src.id, SINK_CLOUD);
        await this.reloadGraph();
        return flow.id;
      }
    }

    if (!tgt || tgt.id === from) return null;
    await this.model.addLink(this.folder, from, tgt.id, { polarity: "+" });
    await this.reloadGraph();
    return tgt.id;
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
      const g = this.scene.edges.find((x) =>
        x.id === this.selEdge && x.renderOnly !== true);
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
    // The point is the node centre; CSS translate(-50%,-50%) centres the field.
    input.style.setProperty("--nl-rename-left", `${screen.x}px`);
    input.style.setProperty("--nl-rename-top", `${screen.y}px`);
    this.renameInput = input;
    input.focus();
    input.select();
    // iOS: pin the canvas to the band above the soft keyboard so it can't collapse
    // and the editor stays visible while you type.
    if (Platform.isMobile) this.enterKbEditing();
    return input;
  }

  /** Wire an open rename input to commit against `id` (Enter/blur save, Escape
   *  cancels), repositioning it to the node's settled box — a freshly-created
   *  node's input was placed at the raw tap point before the node existed. */
  private bindRenameInput(input: HTMLInputElement, id: string, prevLabel: string): void {
    const box = this.scene?.boxes.get(id);
    if (box) {
      const screen = this.camera.toScreen(box.cx, box.cy);
      input.style.setProperty("--nl-rename-left", `${screen.x}px`);
      input.style.setProperty("--nl-rename-top", `${screen.y}px`);
    }
    // Arm keyboard avoidance for this node: now that it exists, pan it into the
    // band when the keyboard finishes rising (mirrors the Dart _kbRecenterNodeId).
    if (Platform.isMobile) {
      this.kbEditNodeId = id;
      this.scheduleKbRecenter();
    }

    const finish = (commit: boolean) => {
      const value = input.value.trim();
      this.renameInput = null;
      input.remove();
      this.exitKbEditing();
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
    // Commit on blur (tap away / keyboard dismiss), matching the Dart app's
    // onTapOutside: a named node is saved, a still-empty brand-new node is
    // discarded (endRename removes it). The keyboard-avoidance pin keeps the field
    // focused while you type, so blur now only fires on a real dismissal.
    input.addEventListener("blur", () => {
      finish(true);
    });
  }

  // ---- iOS keyboard avoidance (WebKit port of the Dart _kbRecenter* flow) ---
  //
  // On iOS the soft keyboard reflows the webview; our flex layout then collapses
  // the canvas to 0px and an inline input (inside the overflow-hidden wrap) gets
  // clipped — the diagram + the node you're naming vanish. Flutter dodges this
  // because its Scaffold shrinks the canvas to the band above the keyboard and the
  // app pans the node into it. We do the same: while editing, pin the canvas wrap
  // to window.visualViewport (the visible band) so it can't collapse, and animate-
  // pan the edited node into the centre of that band.

  /** Pin the canvas wrap to the visible band (visualViewport) so it survives the
   *  keyboard; the ResizeObserver then reflows the canvas backing + repaints. */
  private enterKbEditing(): void {
    const vv = window.visualViewport;
    if (!Platform.isMobile || !vv) return;
    const w = this.wrapper;
    w.classList.add("neoloopy-kb-band");
    w.style.setProperty("--nl-kb-top", `${Math.max(0, vv.offsetTop)}px`);
    w.style.setProperty("--nl-kb-height", `${vv.height}px`);
  }

  /** Release the band overlay and stop tracking; restores the normal flex layout. */
  private exitKbEditing(): void {
    this.kbEditNodeId = null;
    if (this.kbDebounce != null) {
      window.clearTimeout(this.kbDebounce);
      this.kbDebounce = null;
    }
    if (this.panRaf != null) {
      cancelAnimationFrame(this.panRaf);
      this.panRaf = null;
    }
    const w = this.wrapper;
    if (w.classList.contains("neoloopy-kb-band")) {
      w.classList.remove("neoloopy-kb-band");
      w.style.removeProperty("--nl-kb-top");
      w.style.removeProperty("--nl-kb-height");
    }
  }

  /** visualViewport changed (keyboard animating / rotating): keep the band sized
   *  and re-pan the edited node into it. */
  private onViewportChange(): void {
    if (!this.wrapper.classList.contains("neoloopy-kb-band")) return;
    this.enterKbEditing(); // re-apply the band at the new viewport size
    this.scheduleKbRecenter();
  }

  private scheduleKbRecenter(): void {
    if (this.kbDebounce != null) window.clearTimeout(this.kbDebounce);
    this.kbDebounce = window.setTimeout(() => this.recenterForKeyboard(), 60);
  }

  /** Pan so the edited node sits centred in the visible band above the keyboard
   *  (Dart: _recenterForKeyboard + _centeredTranslate). No-op until the keyboard
   *  is actually up. */
  private recenterForKeyboard(): void {
    const vv = window.visualViewport;
    const id = this.kbEditNodeId;
    if (id == null || !this.scene || !vv) return;
    const box = this.scene.boxes.get(id);
    const kb = window.innerHeight - vv.height; // keyboard height (0 when closed)
    if (!box || kb <= 1) return;
    const vw = this.canvas.clientWidth;
    const vh = this.canvas.clientHeight; // == band height (wrap pinned to vv.height)
    const tx = vw / 2 - box.cx * this.camera.scale;
    const ty = vh / 2 - box.cy * this.camera.scale;
    this.animatePanTo(tx, ty);
  }

  /** Ease the camera translate to (tx,ty) (~240ms, easeOutCubic), keeping the open
   *  rename input glued to its node each frame. */
  private animatePanTo(tx: number, ty: number): void {
    if (this.panRaf != null) cancelAnimationFrame(this.panRaf);
    const fromX = this.camera.tx;
    const fromY = this.camera.ty;
    if (Math.abs(tx - fromX) < 0.5 && Math.abs(ty - fromY) < 0.5) return;
    const dur = 240;
    const start = performance.now();
    const tick = (now: number): void => {
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      this.camera.tx = fromX + (tx - fromX) * e;
      this.camera.ty = fromY + (ty - fromY) * e;
      this.repositionRenameInput();
      this.render();
      if (p < 1) {
        this.panRaf = window.requestAnimationFrame(tick);
      } else {
        this.panRaf = null;
        this.persistViewport();
      }
    };
    this.panRaf = window.requestAnimationFrame(tick);
  }

  /** Keep the open inline editor glued to its node's current screen position. */
  private repositionRenameInput(): void {
    if (!this.renameInput || this.kbEditNodeId == null || !this.scene) return;
    const box = this.scene.boxes.get(this.kbEditNodeId);
    if (!box) return;
    const s = this.camera.toScreen(box.cx, box.cy);
    this.renameInput.style.setProperty("--nl-rename-left", `${s.x}px`);
    this.renameInput.style.setProperty("--nl-rename-top", `${s.y}px`);
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
    this.loopHi = loopHighlightFor(lp ?? null);
  }

  private selectedEdgeGeom(): EdgeGeom | null {
    if (!this.selEdge || !this.scene) return null;
    return this.scene.edges.find((e) =>
      e.id === this.selEdge && e.renderOnly !== true) ?? null;
  }

  /**
   * Existing qualitative notes stay keyed by the established sorted-label key.
   * Quantitative-only loops use their exact directed key so two executable
   * routes through the same member set cannot share note state.
   */
  private loopNoteCacheKey(lp: DetectedLoop): string {
    const memoKey = `${lp.identityMode}:${lp.exactKey}`;
    let key = this.loopKeyMemo.get(memoKey);
    if (key === undefined) {
      key = resolvedLoopNoteKey(
        lp,
        (id) => this.graph?.nodes.find((node) => node.id === id)?.label ?? id,
      );
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
    const noteKey = this.loopNoteCacheKey(lp);
    this.liveWatcher.markSelfWrite();
    const path = await this.plugin.engine
      .loopNotePath(this.folder, noteKey)
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
