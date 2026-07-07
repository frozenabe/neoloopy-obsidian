/**
 * InsightPanel — the right-dock "Insights" reader: detected feedback loops,
 * structural endogeneity, and reference-mode sparklines. A self-contained DOM
 * renderer over a `GraphView`; it owns no canvas state, only reads what the host
 * exposes and rebuilds its element on `render()`. Per-variable quant detail
 * renders on the canvas (painter caption) and in the ƒx modal — only model-level
 * reference modes live here.
 */

import { setIcon } from "obsidian";
import {
  DiagramViewMode,
  EndogeneityResult,
  GraphView,
  LoopType,
  ParentAnchor,
  endogeneity,
} from "@neoloopy/cld-canvas";
import { RefModeRow, referenceModeRows } from "../engine/panelModel";
import {
  INSIGHT_DESTINATIONS,
  HealthCheck,
  InsightDestination,
  modelHealthChecks,
  resolveInsightDestination,
} from "../engine/insightsModel";

/** What the panel needs from the canvas. Kept to reads + one selection command. */
export interface InsightHost {
  /** Whether the panel is open (settings.insightPanelOpen). */
  isOpen(): boolean;
  graph(): GraphView | null;
  diagramMode(): DiagramViewMode;
  setDiagramMode(mode: DiagramViewMode): void;
  selectedLoop(): string | null;
  /** Select a loop (or clear with null) and repaint the canvas. */
  selectLoop(key: string | null): void;
  /** Register a DOM listener tied to the view lifecycle (auto-removed). */
  listen(el: HTMLElement, type: string, cb: (e: Event) => void): void;
  /** Parent models that anchor the current model as a subsystem (precomputed). */
  parents(): ParentAnchor[];
  /** Switch to a model, optionally selecting + centering a variable. */
  openModel(folder: string, focusVarId?: string): void;
  /** Ensure + open the current model's System.md in Obsidian. */
  openSystemNote(): void;
}

export class InsightPanel {
  private active: InsightDestination = "structure";
  // Memo of the two pure analyses, keyed by graph-object identity. The panel
  // re-renders on every selection change with the *same* graph object, while a
  // graph reload always yields a fresh object — so identity is the cheapest
  // signature that recomputes exactly when (and only when) the model changes.
  private memoGraph: GraphView | null = null;
  private memoEndogeneity: EndogeneityResult | null = null;
  private memoRefModes: RefModeRow[] | null = null;
  private healthGraph: GraphView | null = null;
  private healthChecks: HealthCheck[] | null = null;
  private healthCheckedAt = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly host: InsightHost,
  ) {}

  /** Recompute the cached analyses iff the graph object changed since last call. */
  private analysisFor(g: GraphView): { endo: EndogeneityResult; refModes: RefModeRow[] } {
    if (this.memoGraph !== g) {
      this.memoGraph = g;
      this.memoEndogeneity = endogeneity(g.nodes, g.loops);
      this.memoRefModes = referenceModeRows(g.manifest);
    }
    return { endo: this.memoEndogeneity as EndogeneityResult, refModes: this.memoRefModes as RefModeRow[] };
  }

  render(): void {
    const p = this.root;
    p.empty();
    if (!this.host.isOpen()) return;

    const g = this.host.graph();
    const head = p.createDiv({ cls: "neoloopy-ip-head" });
    head.createSpan({ cls: "neoloopy-ip-title", text: "Insights" });
    if (g?.quant) head.createSpan({ cls: "neoloopy-ip-quant-pill", text: "Quant" });
    this.renderDiagramToggle(head);
    head.createSpan({
      cls: "neoloopy-ip-count",
      text: g ? `${g.loops.length} loop${g.loops.length === 1 ? "" : "s"}` : "",
    });

    if (!g) {
      p.createDiv({ cls: "neoloopy-ip-empty", text: "Open a model to see its insights." });
      return;
    }

    this.active = resolveInsightDestination(this.active);
    const shell = p.createDiv({ cls: "neoloopy-ip-shell" });
    this.renderRail(shell);
    const body = shell.createDiv({ cls: "neoloopy-ip-body" });
    this.renderDestination(body, g, this.active);
  }

  private nameOf(g: GraphView, id: string): string {
    const n = g.nodes.find((x) => x.id === id);
    return n?.label || n?.id || id;
  }

  private section(parent: HTMLElement, title: string): HTMLElement {
    const sec = parent.createDiv({ cls: "neoloopy-ip-section" });
    sec.createDiv({ cls: "neoloopy-ip-label", text: title });
    return sec;
  }

  private renderDiagramToggle(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: "neoloopy-ip-view-toggle" });
    for (const [mode, label] of [["cld", "CLD"], ["sfd", "SFD"]] as const) {
      const btn = wrap.createEl("button", { cls: "neoloopy-ip-view-btn", text: label });
      btn.toggleClass("is-active", this.host.diagramMode() === mode);
      btn.setAttribute("aria-pressed", this.host.diagramMode() === mode ? "true" : "false");
      this.host.listen(btn, "click", () => this.host.setDiagramMode(mode));
    }
  }

  private renderRail(parent: HTMLElement): void {
    const rail = parent.createDiv({ cls: "neoloopy-ip-rail" });
    const icon: Record<InsightDestination, string> = {
      structure: "git-fork",
      loops: "repeat-2",
      docs: "file-text",
      health: "shield-check",
    };
    const label: Record<InsightDestination, string> = {
      structure: "Structure",
      loops: "Loops",
      docs: "Docs",
      health: "Health",
    };
    for (const d of INSIGHT_DESTINATIONS) {
      const btn = rail.createEl("button", {
        cls: `neoloopy-ip-rail-btn${this.active === d ? " is-active" : ""}`,
        attr: {
          type: "button",
          title: label[d],
          "aria-label": label[d],
          "aria-pressed": this.active === d ? "true" : "false",
        },
      });
      setIcon(btn, icon[d]);
      this.host.listen(btn, "click", () => {
        this.active = d;
        this.render();
      });
    }
  }

  private renderDestination(parent: HTMLElement, g: GraphView, d: InsightDestination): void {
    switch (d) {
      case "structure":
        this.renderStructure(parent, g);
        return;
      case "loops":
        this.renderLoops(parent, g);
        return;
      case "docs":
        this.renderSystem(parent);
        this.renderParents(parent);
        this.renderReferenceModes(parent, g);
        return;
      case "health":
        this.renderHealth(parent, g);
        return;
    }
  }

  private renderSystem(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "neoloopy-ip-system" });
    const head = card.createDiv({ cls: "neoloopy-ip-system-head" });
    head.createSpan({ cls: "neoloopy-ip-label", text: "System" });
    const btn = head.createSpan({
      cls: "neoloopy-ip-system-open",
      attr: { role: "button", "aria-label": "Open System note" },
    });
    setIcon(btn, "file-text");
    this.host.listen(btn, "click", () => this.host.openSystemNote());
  }

  private renderParents(parent: HTMLElement): void {
    const parents = this.host.parents();
    if (parents.length === 0) return;
    const sec = this.section(parent, "Parents");
    for (const pr of parents) {
      const row = sec.createDiv({ cls: "neoloopy-ip-parent" });
      const icon = row.createSpan({ cls: "neoloopy-ip-parent-icon" });
      setIcon(icon, "arrow-up-right");
      const txt = row.createDiv({ cls: "neoloopy-ip-parent-text" });
      txt.createSpan({ cls: "neoloopy-ip-parent-name", text: pr.modelName });
      txt.createSpan({ cls: "neoloopy-ip-parent-via", text: `via ${pr.anchorVarLabel}` });
      this.host.listen(row, "click", () => this.host.openModel(pr.modelFolder, pr.anchorVarId));
    }
  }

  private renderLoops(parent: HTMLElement, g: GraphView): void {
    const loops = g.loops;
    const selected = this.host.selectedLoop();
    const sec = this.section(parent, "Loops");
    if (loops.length === 0) {
      sec.createDiv({ cls: "neoloopy-ip-stat is-muted", text: "No feedback loops detected." });
      return;
    }
    for (const l of loops) {
      const label = g.labels.get(l.key) ?? "?";
      const reinforcing = l.type === LoopType.reinforcing;
      const row = sec.createDiv({
        cls: `neoloopy-ip-loop${selected === l.key ? " is-selected" : ""}`,
      });
      row.createSpan({ cls: `neoloopy-ip-badge ${reinforcing ? "is-r" : "is-b"}`, text: label });
      row.createSpan({
        cls: "neoloopy-ip-loop-path",
        text: l.nodeIds.slice(0, 4).map((id) => this.nameOf(g, id)).join(" → "),
      });
      this.host.listen(row, "click", () => {
        this.host.selectLoop(this.host.selectedLoop() === l.key ? null : l.key);
      });
    }
  }

  private renderStructure(parent: HTMLElement, g: GraphView): void {
    const r = this.analysisFor(g).endo;
    if (r.total === 0) return;
    const pct = Math.round((100 * r.inLoop) / r.total);
    const sec = this.section(parent, "Structure");
    sec.createDiv({
      cls: "neoloopy-ip-stat",
      text: `In feedback loops: ${r.inLoop}/${r.total} · ${pct}%`,
    });
    if (r.exogenous.length) {
      const wrap = sec.createDiv({ cls: "neoloopy-ip-chips" });
      wrap.createSpan({ cls: "neoloopy-ip-chip-label", text: "Exogenous drivers" });
      for (const id of r.exogenous) wrap.createSpan({ cls: "neoloopy-ip-chip", text: this.nameOf(g, id) });
    }
    if (r.openLoop.length) {
      sec.createDiv({
        cls: "neoloopy-ip-stat is-muted",
        text: `${r.openLoop.length} variable${r.openLoop.length === 1 ? "" : "s"} outside every loop`,
      });
    }
    const stocks = g.nodes.filter((n) => n.type === "stock").length;
    const flows = g.nodes.filter((n) => n.type === "flow").length;
    if (stocks > 0 || flows > 0) {
      sec.createDiv({
        cls: "neoloopy-ip-stat",
        text: `SFD structure: ${stocks} stock${stocks === 1 ? "" : "s"} · ${flows} flow${flows === 1 ? "" : "s"}`,
      });
    }
  }

  private renderReferenceModes(parent: HTMLElement, g: GraphView): void {
    const rows = this.analysisFor(g).refModes;
    const sec = this.section(parent, "Reference modes");
    if (rows.length === 0) {
      sec.createDiv({ cls: "neoloopy-ip-stat is-muted", text: "No reference modes authored." });
      return;
    }
    for (const r of rows) {
      const row = sec.createDiv({ cls: "neoloopy-ip-ref-row" });
      this.sparkline(row, r.series);
      const txt = row.createDiv({ cls: "neoloopy-ip-ref-text" });
      txt.createSpan({ cls: "neoloopy-ip-ref-var", text: r.variable });
      txt.createSpan({ cls: "neoloopy-ip-ref-note", text: r.label });
    }
  }

  private renderHealth(parent: HTMLElement, g: GraphView): void {
    const sec = this.section(parent, "Health");
    const actions = sec.createDiv({ cls: "neoloopy-ip-health-actions" });
    const run = actions.createEl("button", {
      cls: "neoloopy-ip-health-run",
      text: "Run checks",
      attr: { type: "button" },
    });
    this.host.listen(run, "click", () => {
      this.healthGraph = g;
      this.healthChecks = modelHealthChecks(g);
      this.healthCheckedAt = new Date().toLocaleTimeString();
      this.render();
    });

    const checks = this.healthGraph === g ? this.healthChecks : null;
    if (!checks) {
      sec.createDiv({
        cls: "neoloopy-ip-stat is-muted",
        text: "Run local checks for structure, labels, and flow endpoints.",
      });
      return;
    }

    if (this.healthCheckedAt) {
      sec.createDiv({ cls: "neoloopy-ip-health-stamp", text: `Checked ${this.healthCheckedAt}` });
    }
    for (const check of checks) {
      const row = sec.createDiv({ cls: `neoloopy-ip-health is-${check.severity}` });
      row.createDiv({ cls: "neoloopy-ip-health-label", text: check.label });
      row.createDiv({ cls: "neoloopy-ip-health-detail", text: check.detail });
    }
  }

  private sparkline(parent: HTMLElement, series: number[]): void {
    const w = 64;
    const h = 22;
    const svg = parent.createSvg("svg", {
      cls: "neoloopy-ip-spark",
      attr: { width: String(w), height: String(h), viewBox: `0 0 ${w} ${h}` },
    });
    if (series.length < 2) return;
    const lo = Math.min(...series);
    const hi = Math.max(...series);
    const span = hi - lo < 1e-9 ? 1 : hi - lo;
    const pts = series
      .map((v, i) => {
        const x = (i / (series.length - 1)) * (w - 2) + 1;
        const y = h - 1 - ((v - lo) / span) * (h - 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    svg.createSvg("polyline", { attr: { points: pts, fill: "none", "stroke-width": "1.5" } });
  }
}
