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
  WorkspaceLeaf,
  debounce,
  normalizePath,
} from "obsidian";
import type NeoloopyPlugin from "../main";
import { GraphView, QuantPatch } from "../engine/engine";
import { LoopType } from "../engine/types";
import { ParentAnchor, linkPointsToModel } from "../engine/subsystemLinks";
import { Camera, Point } from "./camera";
import { loopNoteKey } from "./loopKeys";
import { InsightPanel } from "./insightPanel";
import { CanvasToolbar } from "./canvasToolbar";
import { SelectionChrome } from "./selectionChrome";
import { EquationModal } from "./dialogs";
import { LoopHighlight, Scene, paint } from "./painter";
import { Theme, resolveTheme } from "./theme";
import { SceneCache } from "./sceneCache";
import { PointerInteraction } from "./pointerInteraction";
import { KeyboardController } from "./keyboardController";
import { ModelController } from "./modelController";
import { LiveEditWatcher } from "./liveEditWatcher";
import { SelectionAnimator } from "./selectionAnimator";
import { EdgeGeom, loopEdgeIds } from "./geometry";

export const VIEW_TYPE_CANVAS = "neoloopy-canvas";

/** Session-only camera memory per model folder (mirrors the app's _viewMemory). */
const viewMemory = new Map<string, { tx: number; ty: number; scale: number }>();

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
    // The tab title comes from getDisplayText() (the current model name), but
    // Obsidian caches it until the leaf is told to refresh — without this the
    // tab keeps the first model's name. updateHeader() re-reads it for the TAB;
    // it does NOT re-read the inline view-header title (`view.titleEl`), which
    // is set once at view-load (when no model is open). Set that one directly so
    // the tab and the centered header agree on the live model name.
    (this.leaf as unknown as { updateHeader(): void }).updateHeader();
    const titleEl = (this as unknown as { titleEl?: { setText(t: string): void } }).titleEl;
    if (titleEl) titleEl.setText(this.getDisplayText());
  }

  private async reloadGraph(): Promise<void> {
    if (!this.folder) return;
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
    const name = `Model ${new Date().toLocaleDateString()}`;
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
    this.registerEvent(this.app.vault.on("modify", (f) => this.liveWatcher.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("create", (f) => this.liveWatcher.onVaultChange(f)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.liveWatcher.onVaultChange(f)));
    // A theme/appearance switch changes the resolved CSS colors — drop the cache
    // so the next render repaints in the new palette.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        this.themeCache = null;
        this.render();
      }),
    );
  }

  private async createNodeAt(world: Point): Promise<void> {
    if (!this.folder) return;
    const v = await this.model.addVariable(this.folder, { label: "", x: world.x, y: world.y });
    await this.reloadGraph();
    this.select(v.id, null, null);
    this.render();
    this.startRename(v.id);
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
    this.commitRename();
    const screen = this.camera.toScreen(box.cx, box.cy);
    const input = this.wrapper.createEl("input", { type: "text", cls: "neoloopy-rename-input" });
    input.value = node.label;
    // Position is the only genuinely dynamic style (follows the node on screen).
    input.style.setProperty("--nl-rename-left", `${screen.x - 70}px`);
    input.style.setProperty("--nl-rename-top", `${screen.y - 14}px`);
    this.renameInput = input;
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
      const value = input.value.trim();
      this.renameInput = null;
      input.remove();
      void this.endRename(id, commit ? value : null, node.label);
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
