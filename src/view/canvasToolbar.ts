/**
 * CanvasToolbar — the canvas header: a folder-grouped model picker, a new-model
 * button, and the four action buttons (Spread out · Export · Glossary · Keyboard
 * shortcuts) plus the insights toggle. Owns the model `<select>` and its
 * grouping; everything else is delegated to the host. The native app switches
 * models from a separate folder-grouped screen — the plugin folds that into this
 * in-header dropdown.
 */

import { App, ButtonComponent, DropdownComponent } from "obsidian";
import { DiagramViewMode, ModelRef } from "@neoloopy/cld-canvas";
import { GlossaryModal, ShortcutsModal } from "./dialogs";

/** What the toolbar needs from the canvas. */
export interface ToolbarHost {
  readonly app: App;
  listModels(): Promise<ModelRef[]>;
  currentFolder(): string | null;
  openModel(folder: string): void;
  newModel(): void;
  renameModel(): void;
  diagramMode(): DiagramViewMode;
  setDiagramMode(mode: DiagramViewMode): void;
  tidy(): void;
  openExportMenu(evt: MouseEvent): void;
  toggleInsightPanel(): void;
}

export class CanvasToolbar {
  private readonly dropdown: DropdownComponent;
  private readonly modeButtons = new Map<DiagramViewMode, HTMLButtonElement>();

  constructor(root: HTMLElement, private readonly host: ToolbarHost) {
    const bar = root.createDiv({ cls: "neoloopy-toolbar" });

    // Left cluster: the model picker (folder-grouped) + new-model button.
    this.dropdown = new DropdownComponent(bar);
    this.dropdown.onChange((value) => {
      if (value) host.openModel(value);
    });

    // `+` styled to read like the model dropdown (form-field surface) so the
    // left cluster looks like one control.
    new ButtonComponent(bar)
      .setIcon("plus")
      .setTooltip("New model")
      .onClick(() => host.newModel())
      .buttonEl.addClass("neoloopy-new-model");

    // Rename the current model's title — sits with the picker it acts on.
    new ButtonComponent(bar)
      .setIcon("pencil")
      .setTooltip("Rename model")
      .onClick(() => host.renameModel())
      .buttonEl.addClass("neoloopy-rename-model");

    const modeToggle = bar.createDiv({ cls: "neoloopy-toolbar-view-toggle" });
    for (const [mode, label] of [["cld", "CLD"], ["sfd", "SFD"]] as const) {
      const btn = modeToggle.createEl("button", {
        cls: "neoloopy-toolbar-view-btn",
        text: label,
        attr: { type: "button" },
      });
      btn.addEventListener("click", () => host.setDiagramMode(mode));
      this.modeButtons.set(mode, btn);
    }
    this.setDiagramMode(host.diagramMode());

    bar.createDiv({ cls: "neoloopy-toolbar-spacer" });

    // Right cluster: four action buttons, identical to the native canvas header.
    new ButtonComponent(bar).setIcon("network").setTooltip("Spread out").onClick(() => host.tidy());
    new ButtonComponent(bar).setIcon("share").setTooltip("Export").onClick((evt) => host.openExportMenu(evt));
    new ButtonComponent(bar)
      .setIcon("book-open")
      .setTooltip("Systems-thinking glossary")
      .onClick(() => new GlossaryModal(host.app).open());
    new ButtonComponent(bar)
      .setIcon("keyboard")
      .setTooltip("Keyboard shortcuts (Ctrl /)")
      .onClick(() => new ShortcutsModal(host.app).open());
    new ButtonComponent(bar)
      .setIcon("sidebar-right")
      .setTooltip("Toggle insights")
      .onClick(() => host.toggleInsightPanel());
  }

  /** Reflect the active model in the dropdown without firing `onChange`. */
  setSelected(folder: string): void {
    this.dropdown.setValue(folder);
  }

  setDiagramMode(mode: DiagramViewMode): void {
    for (const [key, btn] of this.modeButtons) {
      const active = key === mode;
      btn.toggleClass("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  /**
   * Rebuild the model `<select>`, grouped by each model's organizational folder
   * (the `model.json` `folder` label, NOT the directory path). Native rule: if
   * NO model has a folder, show a plain flat list; otherwise render folder
   * headers. A `<select>` can't collapse, so folders become alphabetical
   * `<optgroup>`s and ungrouped models sit as bare options above them.
   */
  async refreshModelList(): Promise<void> {
    const models = await this.host.listModels();
    const dd = this.dropdown;
    dd.selectEl.empty();
    if (models.length === 0) {
      dd.addOption("", "No models yet");
      return;
    }

    const byName = (a: ModelRef, b: ModelRef): number => a.name.localeCompare(b.name);
    const optText = (m: ModelRef): string => m.name + (m.quant ? " · quant" : "");
    const grouped = new Map<string, ModelRef[]>();
    const ungrouped: ModelRef[] = [];
    for (const m of models) {
      const g = (m.group ?? "").trim();
      if (g === "") ungrouped.push(m);
      else (grouped.get(g) ?? grouped.set(g, []).get(g)!).push(m);
    }

    if (grouped.size === 0) {
      for (const m of models.slice().sort(byName)) dd.addOption(m.folder, optText(m));
    } else {
      for (const m of ungrouped.sort(byName)) dd.addOption(m.folder, optText(m));
      for (const folder of [...grouped.keys()].sort((a, b) => a.localeCompare(b))) {
        const og = dd.selectEl.createEl("optgroup", { attr: { label: folder } });
        for (const m of (grouped.get(folder) as ModelRef[]).sort(byName)) {
          og.createEl("option", { value: m.folder, text: optText(m) });
        }
      }
    }
    const folder = this.host.currentFolder();
    if (folder) dd.setValue(folder);
  }
}
