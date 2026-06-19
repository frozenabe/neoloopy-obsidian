import {
  Plugin,
  WorkspaceLeaf,
  parseYaml,
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  NeoloopySettings,
  NeoloopySettingTab,
} from "./settings";
import { NeoloopyEngine } from "./engine/engine";
import { NativeEngine } from "./engine/nativeEngine";
import { ObsidianStorage } from "./engine/obsidianStorage";
import { CanvasView, VIEW_TYPE_CANVAS } from "./view/canvasView";

/**
 * neoloopy — local-first causal-loop diagrams in Obsidian.
 *
 * The engine is pure TypeScript and runs entirely on-device — no network calls.
 * Quantitative models are viewed read-only; the plugin never simulates. See
 * docs/superpowers/specs/2026-06-17-obsidian-insight-panel-design.md.
 */
export default class NeoloopyPlugin extends Plugin {
  settings: NeoloopySettings = DEFAULT_SETTINGS;
  /** The native TypeScript engine — the only backend. */
  engine!: NeoloopyEngine;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.rebuildEngine();
    this.addSettingTab(new NeoloopySettingTab(this.app, this));

    this.registerView(VIEW_TYPE_CANVAS, (leaf) => new CanvasView(leaf, this));

    this.addRibbonIcon("git-fork", "Open neoloopy canvas", () => {
      void this.openCanvas();
    });

    this.addCommand({
      id: "open-canvas",
      name: "Open canvas",
      callback: () => void this.openCanvas(),
    });

    this.addCommand({
      id: "new-model",
      name: "Create new model",
      callback: () => void this.newModelCommand(),
    });

    // Commands that act on the model in the active canvas.
    const onCanvas = (
      id: string,
      name: string,
      run: (view: CanvasView) => void,
    ): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking: boolean) => {
          const view = this.activeCanvas();
          if (!view || !view.hasModel()) return false;
          if (!checking) run(view);
          return true;
        },
      });
    };

    onCanvas("add-variable", "Add variable", (v) => void v.cmdAddVariable());
    onCanvas("tidy-layout", "Tidy layout", (v) => void v.cmdTidy());
    onCanvas("detect-loops", "Detect feedback loops", (v) => v.reportLoops());
    onCanvas("export-markdown", "Export model as Markdown", (v) => void v.cmdExport("markdown"));
    onCanvas("export-json", "Export model as JSON", (v) => void v.cmdExport("json"));
    onCanvas("export-mermaid", "Export model as Mermaid", (v) => void v.cmdExport("mermaid"));
  }

  /** The CanvasView in the active leaf, if any. */
  private activeCanvas(): CanvasView | null {
    return this.app.workspace.getActiveViewOfType(CanvasView);
  }

  private async newModelCommand(): Promise<void> {
    await this.openCanvas();
    const view = this.activeCanvas();
    if (view) await view.cmdNewModel();
  }

  /** Open (or focus) the canvas view in the main workspace. */
  async openCanvas(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_CANVAS)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_CANVAS, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /** Rebuild the engine after a settings change (e.g. the default model folder). */
  rebuildEngine(): void {
    const storage = new ObsidianStorage(this.app.vault, this.app.fileManager);
    const modelsRoot = (this.settings.defaultModelFolder ?? "").trim();
    this.engine = new NativeEngine(storage, parseYaml, { modelsRoot });
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<NeoloopySettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
