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
  EndogeneityResult,
  GraphView,
  LoopType,
  ParentAnchor,
  endogeneity,
} from "@neoloopy/cld-canvas";
import { RefModeRow, referenceModeRows } from "../engine/panelModel";

/** What the panel needs from the canvas. Kept to reads + one selection command. */
export interface InsightHost {
  /** Whether the panel is open (settings.insightPanelOpen). */
  isOpen(): boolean;
  graph(): GraphView | null;
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
  // Memo of the two pure analyses, keyed by graph-object identity. The panel
  // re-renders on every selection change with the *same* graph object, while a
  // graph reload always yields a fresh object — so identity is the cheapest
  // signature that recomputes exactly when (and only when) the model changes.
  private memoGraph: GraphView | null = null;
  private memoEndogeneity: EndogeneityResult | null = null;
  private memoRefModes: RefModeRow[] | null = null;

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
    head.createSpan({
      cls: "neoloopy-ip-count",
      text: g ? `${g.loops.length} loop${g.loops.length === 1 ? "" : "s"}` : "",
    });

    if (!g) {
      p.createDiv({ cls: "neoloopy-ip-empty", text: "Open a model to see its insights." });
      return;
    }

    this.renderSystem(p);
    this.renderParents(p);
    this.renderLoops(p, g);
    this.renderStructure(p, g);
    this.renderReferenceModes(p, g);
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
    if (loops.length === 0) return;
    const selected = this.host.selectedLoop();
    const sec = this.section(parent, "Feedback loops");
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
  }

  private renderReferenceModes(parent: HTMLElement, g: GraphView): void {
    const rows = this.analysisFor(g).refModes;
    if (rows.length === 0) return;
    const sec = this.section(parent, "Reference modes");
    for (const r of rows) {
      const row = sec.createDiv({ cls: "neoloopy-ip-ref-row" });
      this.sparkline(row, r.series);
      const txt = row.createDiv({ cls: "neoloopy-ip-ref-text" });
      txt.createSpan({ cls: "neoloopy-ip-ref-var", text: r.variable });
      txt.createSpan({ cls: "neoloopy-ip-ref-note", text: r.label });
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
