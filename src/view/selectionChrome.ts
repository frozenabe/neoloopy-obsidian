/**
 * SelectionChrome — the screen-space HTML chrome layered over the canvas for the
 * current selection: the node `⋯` reveal (kind picker + color palette +
 * subsystem + ƒx), the edge `⋯` reveal (polarity + delay/indirect/nonlinear/
 * weight), the loop badge-note button, and the trash FAB. Each `⋯` toggle
 * collapses to a circle and flips to a teal `✕` when open, mirroring the native
 * app's `_menuToggle` reveal.
 *
 * Owns its own DOM and its menu open/closed state; everything causal (selection,
 * camera, edits) comes from the host. `update()` repositions + shows/hides to
 * match the selection and is called once per `render()`.
 */

import { setIcon } from "obsidian";
import {
  Camera,
  DetectedLoop,
  DiagramViewMode,
  EdgeGeom,
  GROUP_PALETTE,
  GraphView,
  LinkPatch,
  SINK_CLOUD,
  Scene,
  SOURCE_CLOUD,
  VarType,
  flowOf,
} from "@neoloopy/cld-canvas";

/** What the chrome needs from the canvas: reads + the edit commands it fires. */
export interface ChromeHost {
  readonly camera: Camera;
  scene(): Scene | null;
  graph(): GraphView | null;
  diagramMode(): DiagramViewMode;
  selection(): { node: string | null; edge: string | null; loop: string | null };
  /** True only when no drag/pan gesture is in flight (chrome hides mid-gesture). */
  isIdle(): boolean;
  selectedEdgeGeom(): EdgeGeom | null;
  /** Whether the loop already has a non-empty note (drives the badge icon). */
  loopHasNote(loop: DetectedLoop): boolean;
  listen(el: HTMLElement, type: string, cb: (e: Event) => void): void;

  setNodeType(id: string, type: VarType): void;
  setFlowEndpoints(id: string, from: string, to: string): void;
  setNodeGroup(id: string, group: string | null): void;
  openSubsystemMenu(ev: MouseEvent): void;
  openEquationModal(): void;
  patchLink(g: { source: string; target: string }, patch: LinkPatch): void;
  deleteSelection(): void;
  openLoopNote(loopKey: string): void;
}

export class SelectionChrome {
  // Public so the canvas (and the view smoke harness) can read element state.
  readonly overlay: HTMLElement;
  readonly nodeMenuToggle: HTMLElement;
  readonly nodeMenu: HTMLElement;
  readonly edgeMenuToggle: HTMLElement;
  readonly edgeMenu: HTMLElement;
  readonly badgeNoteBtn: HTMLElement;
  readonly trashBtn: HTMLElement;

  private nodeMenuOpen = false;
  private edgeMenuOpen = false;
  /** Last icon set on the badge-note button, so we only swap it when it changes. */
  private badgeNoteIcon: string | null = null;
  /** Last ⋯/✕ icon set per menu toggle, to avoid redundant DOM swaps. */
  private readonly toggleIcons: Record<string, string> = {};

  private readonly nodeTypeBtns: Partial<Record<VarType, HTMLElement>> = {};
  private readonly subsysBtn: HTMLElement;
  private readonly fxBtn: HTMLElement;
  private readonly flowEndpointEl: HTMLElement;
  private readonly flowFromSelect: HTMLSelectElement;
  private readonly flowToSelect: HTMLSelectElement;
  private readonly paletteBtns: Record<string, HTMLElement> = {};
  private readonly edgePolBtns: Partial<Record<"+" | "-", HTMLElement>> = {};
  private readonly edgeFlagBtns: Partial<
    Record<"delay" | "indirect" | "nonlinear" | "weight", HTMLElement>
  > = {};

  constructor(wrapper: HTMLElement, private readonly host: ChromeHost) {
    this.overlay = wrapper.createDiv({ cls: "neoloopy-overlay" });

    // ---- node selection: ⋯ toggle + (kind picker | color palette) panel -----
    this.nodeMenuToggle = this.overlay.createEl("button", { cls: "neoloopy-toggle neoloopy-node-toggle" });
    setIcon(this.nodeMenuToggle, "more-horizontal");
    this.nodeMenuToggle.setAttribute("aria-label", "Edit variable");
    host.listen(this.nodeMenuToggle, "click", () => this.toggleNodeMenu());

    this.nodeMenu = this.overlay.createDiv({ cls: "neoloopy-popover neoloopy-node-menu" });

    // Top row: the shape (kind) picker pill + the subsystem drill-in button.
    const row = this.nodeMenu.createDiv({ cls: "neoloopy-node-row" });

    const kind = row.createDiv({ cls: "neoloopy-pill neoloopy-kind" });
    const kindLabel: Record<VarType, string> = { stock: "Stock", flow: "Flow", auxiliary: "Auxiliary" };
    for (const t of ["stock", "flow", "auxiliary"] as VarType[]) {
      const b = kind.createEl("button", { cls: `neoloopy-kind-btn neoloopy-kind-${t}` });
      this.kindIcon(b, t);
      b.setAttribute("aria-label", kindLabel[t]);
      this.nodeTypeBtns[t] = b;
      host.listen(b, "click", () => {
        const id = host.selection().node;
        if (id) host.setNodeType(id, t);
      });
    }

    // Subsystem: a layered-pane glyph linking a node to a child model.
    this.subsysBtn = row.createEl("button", { cls: "neoloopy-circ neoloopy-subsys" });
    setIcon(this.subsysBtn, "layers");
    this.subsysBtn.setAttribute("aria-label", "Subsystem");
    host.listen(this.subsysBtn, "click", (ev) => host.openSubsystemMenu(ev as MouseEvent));

    // ƒx: shown only for promoted (quantitative) models.
    this.fxBtn = row.createEl("button", { cls: "neoloopy-circ neoloopy-fx", text: "ƒx" });
    this.fxBtn.setAttribute("aria-label", "Equation");
    host.listen(this.fxBtn, "click", () => host.openEquationModal());

    this.flowEndpointEl = this.nodeMenu.createDiv({ cls: "neoloopy-flow-endpoints" });
    this.flowFromSelect = this.endpointField(this.flowEndpointEl, "From");
    this.flowToSelect = this.endpointField(this.flowEndpointEl, "To");
    host.listen(this.flowFromSelect, "change", () => this.commitEndpointChange());
    host.listen(this.flowToSelect, "change", () => this.commitEndpointChange());

    // Color palette: a no-group swatch + the eight curated group hues.
    const palette = this.nodeMenu.createDiv({ cls: "neoloopy-pill neoloopy-palette" });
    const none = palette.createEl("button", { cls: "neoloopy-swatch neoloopy-swatch-none" });
    setIcon(none, "ban");
    none.setAttribute("aria-label", "No group");
    this.paletteBtns["__none__"] = none;
    host.listen(none, "click", () => {
      const id = host.selection().node;
      if (id) host.setNodeGroup(id, null);
    });
    for (const sw of GROUP_PALETTE) {
      const b = palette.createEl("button", { cls: "neoloopy-swatch" });
      b.style.setProperty("--sw-l", sw.fillLight);
      b.style.setProperty("--sw-d", sw.fillDark);
      b.style.setProperty("--bd-l", sw.borderLight);
      b.style.setProperty("--bd-d", sw.borderDark);
      b.setAttribute("aria-label", sw.name);
      this.paletteBtns[sw.name] = b;
      host.listen(b, "click", () => {
        const id = host.selection().node;
        if (id) host.setNodeGroup(id, sw.name);
      });
    }

    // ---- edge selection: ⋯ toggle + (polarity | flags) panel ---------------
    this.edgeMenuToggle = this.overlay.createEl("button", { cls: "neoloopy-toggle neoloopy-edge-toggle" });
    setIcon(this.edgeMenuToggle, "more-horizontal");
    this.edgeMenuToggle.setAttribute("aria-label", "Edit link");
    host.listen(this.edgeMenuToggle, "click", () => this.toggleEdgeMenu());

    this.edgeMenu = this.overlay.createDiv({ cls: "neoloopy-popover neoloopy-edge-menu" });

    // Segmented polarity pill: the active sign reads as a filled black half.
    const seg = this.edgeMenu.createDiv({ cls: "neoloopy-pill neoloopy-seg" });
    for (const p of ["+", "-"] as const) {
      const b = seg.createEl("button", { cls: "neoloopy-seg-btn", text: p === "-" ? "–" : "+" });
      b.setAttribute("aria-label", p === "-" ? "Negative (opposite)" : "Positive (same)");
      this.edgePolBtns[p] = b;
      host.listen(b, "click", () => {
        const g = host.selectedEdgeGeom();
        if (g && g.link.polarity !== p) host.patchLink(g, { polarity: p });
      });
    }

    // Flag buttons: standalone white circles (delay ‖, indirect ⋯, nonlinear ∿).
    const flagGlyph: Record<"delay" | "indirect" | "nonlinear", [string, string]> = {
      delay: ["‖", "Delay"],
      indirect: ["⋯", "Indirect (dashed)"],
      nonlinear: ["∿", "Nonlinear"],
    };
    for (const flag of ["delay", "indirect", "nonlinear"] as const) {
      const [glyph, label] = flagGlyph[flag];
      const b = this.edgeMenu.createEl("button", { cls: "neoloopy-circ", text: glyph });
      b.setAttribute("aria-label", label);
      this.edgeFlagBtns[flag] = b;
      host.listen(b, "click", () => {
        const g = host.selectedEdgeGeom();
        if (!g) return;
        if (flag === "delay") host.patchLink(g, { delay: !g.link.delay });
        else if (flag === "indirect") host.patchLink(g, { indirect: !g.link.indirect });
        else host.patchLink(g, { nonlinear: !g.link.nonlinear });
      });
    }
    const weight = this.edgeMenu.createEl("button", { cls: "neoloopy-circ neoloopy-weight" });
    weight.createDiv({ cls: "neoloopy-weight-bar" });
    weight.setAttribute("aria-label", "Cycle weight");
    this.edgeFlagBtns.weight = weight;
    host.listen(weight, "click", () => {
      const g = host.selectedEdgeGeom();
      if (g) host.patchLink(g, { weight: ((g.link.weight ?? 0) + 1) % 3 });
    });

    // Loop badge → open the loop's markdown note.
    this.badgeNoteBtn = this.overlay.createEl("button", { cls: "neoloopy-badge-note" });
    setIcon(this.badgeNoteBtn, "file-text");
    this.badgeNoteBtn.setAttribute("aria-label", "Open loop note");
    host.listen(this.badgeNoteBtn, "click", () => {
      const loop = host.selection().loop;
      if (loop) host.openLoopNote(loop);
    });

    // Trash FAB → delete the selected node or edge.
    this.trashBtn = this.overlay.createEl("button", { cls: "neoloopy-trash-fab" });
    setIcon(this.trashBtn, "trash-2");
    this.trashBtn.setAttribute("aria-label", "Delete selection");
    host.listen(this.trashBtn, "click", () => host.deleteSelection());
  }

  /** Flip the node menu and repaint the chrome (the ⋯ tap). */
  toggleNodeMenu(): void {
    this.nodeMenuOpen = !this.nodeMenuOpen;
    this.update();
  }

  /** Flip the edge menu and repaint the chrome (the ⋯ tap / Enter on an edge). */
  toggleEdgeMenu(): void {
    this.edgeMenuOpen = !this.edgeMenuOpen;
    this.update();
  }

  /** Collapse a menu when its selection changes (a new selection starts closed). */
  collapseNodeMenu(): void {
    this.nodeMenuOpen = false;
  }

  collapseEdgeMenu(): void {
    this.edgeMenuOpen = false;
  }

  /** Reposition + show/hide the screen-space chrome to match the selection. */
  update(): void {
    const idle = this.host.isIdle();
    const scene = this.host.scene();
    const graph = this.host.graph();
    const sel = this.host.selection();
    const cam = this.host.camera;

    // Node: a ⋯ toggle just below the node; tapping it reveals the kind/color
    // panel below the toggle and flips the toggle to a teal ✕.
    const nodeBox = idle && sel.node ? scene?.boxes.get(sel.node) : undefined;
    if (nodeBox) {
      const node = graph?.nodes.find((n) => n.id === sel.node);
      const top = cam.toScreen(nodeBox.cx, nodeBox.cy + nodeBox.h / 2);
      this.place(this.nodeMenuToggle, top.x, top.y + 8);
      this.setToggleState(this.nodeMenuToggle, "node", this.nodeMenuOpen);
      this.nodeMenuToggle.toggleClass("is-visible", true);
      if (this.nodeMenuOpen) {
        this.place(this.nodeMenu, top.x, top.y + 44);
        for (const t of ["stock", "flow", "auxiliary"] as VarType[])
          this.nodeTypeBtns[t]?.toggleClass("is-active", node?.type === t);
        const grp = node?.group ?? "__none__";
        for (const [name, btn] of Object.entries(this.paletteBtns))
          btn.toggleClass("is-active", name === grp);
        this.subsysBtn.toggleClass("is-active", !!(node?.subsystem && node.subsystem.trim().length));
        this.fxBtn.toggleClass("is-hidden", !graph?.quant);
        this.syncFlowEndpointEditor(node ?? null, graph ?? null);
        this.nodeMenu.toggleClass("is-visible", true);
      } else this.nodeMenu.toggleClass("is-visible", false);
    } else {
      this.nodeMenuToggle.toggleClass("is-visible", false);
      this.nodeMenu.toggleClass("is-visible", false);
    }

    // Edge: the same ⋯ reveal just below the midpoint chip.
    const g = idle ? this.host.selectedEdgeGeom() : null;
    if (g) {
      const s = cam.toScreen(g.mid.x, g.mid.y);
      this.place(this.edgeMenuToggle, s.x, s.y + 14);
      this.setToggleState(this.edgeMenuToggle, "edge", this.edgeMenuOpen);
      this.edgeMenuToggle.toggleClass("is-visible", true);
      if (this.edgeMenuOpen) {
        this.place(this.edgeMenu, s.x, s.y + 50);
        this.edgePolBtns["+"]?.toggleClass("is-active", g.link.polarity === "+");
        this.edgePolBtns["-"]?.toggleClass("is-active", g.link.polarity === "-");
        this.edgeFlagBtns.delay?.toggleClass("is-active", g.link.delay);
        this.edgeFlagBtns.indirect?.toggleClass("is-active", g.link.indirect);
        this.edgeFlagBtns.nonlinear?.toggleClass("is-active", g.link.nonlinear);
        const w = g.link.weight ?? 0;
        this.edgeFlagBtns.weight?.style.setProperty("--wt", `${1 + w}px`);
        this.edgeFlagBtns.weight?.toggleClass("is-active", w > 0);
        this.edgeMenu.toggleClass("is-visible", true);
      } else this.edgeMenu.toggleClass("is-visible", false);
    } else {
      this.edgeMenuToggle.toggleClass("is-visible", false);
      this.edgeMenu.toggleClass("is-visible", false);
    }

    const badge = idle && sel.loop ? scene?.badges.get(sel.loop) : undefined;
    if (badge) {
      const s = cam.toScreen(badge.x, badge.y);
      this.place(this.badgeNoteBtn, s.x + 20, s.y - 20);
      // A "+" file icon to add a note, a lined file once one exists.
      const lp = graph?.loops.find((l) => l.key === sel.loop);
      const hasNote = lp ? this.host.loopHasNote(lp) : false;
      const wantIcon = hasNote ? "file-text" : "file-plus";
      if (this.badgeNoteIcon !== wantIcon) {
        setIcon(this.badgeNoteBtn, wantIcon);
        this.badgeNoteIcon = wantIcon;
      }
      this.badgeNoteBtn.toggleClass("is-visible", true);
    } else this.badgeNoteBtn.toggleClass("is-visible", false);

    this.trashBtn.toggleClass("is-visible", !!(sel.node || sel.edge));
  }

  private place(el: HTMLElement, x: number, y: number): void {
    el.style.setProperty("--nl-x", `${Math.round(x)}px`);
    el.style.setProperty("--nl-y", `${Math.round(y)}px`);
  }

  /** Flip a menu toggle between ⋯ (closed) and ✕ (open), swapping the icon only
   *  when it changes so we don't thrash the DOM every animation frame. */
  private setToggleState(el: HTMLElement, key: "node" | "edge", open: boolean): void {
    el.toggleClass("is-open", open);
    const want = open ? "x" : "more-horizontal";
    if (this.toggleIcons[key] !== want) {
      setIcon(el, want);
      this.toggleIcons[key] = want;
    }
  }

  private endpointField(parent: HTMLElement, label: string): HTMLSelectElement {
    const wrap = parent.createDiv({ cls: "neoloopy-flow-endpoint-field" });
    wrap.createSpan({ cls: "neoloopy-flow-endpoint-label", text: label });
    return wrap.createEl("select", { cls: "neoloopy-flow-endpoint-select" });
  }

  private commitEndpointChange(): void {
    const id = this.host.selection().node;
    if (!id) return;
    this.host.setFlowEndpoints(id, this.flowFromSelect.value, this.flowToSelect.value);
  }

  private syncFlowEndpointEditor(node: { type: VarType; extra: Record<string, unknown> } | null, graph: GraphView | null): void {
    const show = this.host.diagramMode() === "sfd" && node?.type === "flow" && !!graph;
    this.flowEndpointEl.toggleClass("is-hidden", !show);
    if (!show || !graph) return;
    const flow = flowOf(node as GraphView["nodes"][number]);
    const stocks = graph.nodes
      .filter((n) => n.type === "stock")
      .slice()
      .sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));
    this.setEndpointOptions(this.flowFromSelect, [
      [SOURCE_CLOUD, "Source"],
      ...stocks.map((s): [string, string] => [s.id, s.label || s.id]),
    ], flow?.from ?? SOURCE_CLOUD);
    this.setEndpointOptions(this.flowToSelect, [
      ...stocks.map((s): [string, string] => [s.id, s.label || s.id]),
      [SINK_CLOUD, "Sink"],
    ], flow?.to ?? SINK_CLOUD);
  }

  private setEndpointOptions(select: HTMLSelectElement, items: Array<[string, string]>, value: string): void {
    const present = items.some(([v]) => v === value);
    const all = present ? items : [[value, value], ...items] as Array<[string, string]>;
    const sig = all.map(([v, label]) => `${v}\u001f${label}`).join("\u001e");
    if (select.dataset["sig"] !== sig) {
      select.empty();
      for (const [v, label] of all) {
        select.createEl("option", { value: v, text: label });
      }
      select.dataset["sig"] = sig;
    }
    select.value = value;
  }

  /** Append a node-kind shape icon (stock rect · flow valve · aux pill). */
  private kindIcon(parent: HTMLElement, kind: VarType): void {
    const svg = parent.createSvg("svg", {
      attr: { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor" },
    });
    if (kind === "flow") {
      svg.createSvg("path", {
        attr: { d: "M6 7 L12 12 L6 17 Z M18 7 L12 12 L18 17 Z", "stroke-width": "1.5", "stroke-linejoin": "round" },
      });
    } else {
      svg.createSvg("rect", {
        attr: { x: "3.5", y: "8", width: "17", height: "8", rx: kind === "stock" ? "1.5" : "4", "stroke-width": "1.6" },
      });
    }
  }
}
