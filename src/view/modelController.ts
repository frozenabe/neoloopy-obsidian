/**
 * ModelController — the canvas's guarded write surface over the engine. Every
 * mutating call is bracketed by `markSelfWrite` (via the injected callback, wired
 * to the LiveEditWatcher) so the plugin's own saves never trigger a spurious
 * live-edit flash. Reads stay on the engine handle directly — they need no guard.
 *
 * The view keeps the orchestration (what to select/reload/render after a write);
 * this class only centralizes the "guard, then write" plumbing that was repeated
 * at every call site.
 */

import {
  LinkInit,
  LinkPatch,
  ModelRef,
  NeoloopyEngine,
  NewVariable,
  QuantPatch,
  VariablePatch,
} from "../engine/engine";
import { VariableFile } from "../engine/types";

export class ModelController {
  constructor(
    private readonly engine: NeoloopyEngine,
    private readonly markSelfWrite: () => void,
  ) {}

  /** Bracket a write with the self-write window so it doesn't flash as external. */
  private async guarded<T>(op: () => Promise<T>): Promise<T> {
    this.markSelfWrite();
    const result = await op();
    this.markSelfWrite();
    return result;
  }

  createModel(name: string): Promise<ModelRef> {
    return this.guarded(() => this.engine.createModel(name));
  }

  renameModel(folder: string, name: string): Promise<ModelRef> {
    return this.guarded(() => this.engine.renameModel(folder, name));
  }

  retitleModel(folder: string, name: string): Promise<ModelRef> {
    return this.guarded(() => this.engine.retitleModel(folder, name));
  }

  addVariable(folder: string, init: NewVariable): Promise<VariableFile> {
    return this.guarded(() => this.engine.addVariable(folder, init));
  }

  updateVariable(folder: string, id: string, patch: VariablePatch): Promise<VariableFile> {
    return this.guarded(() => this.engine.updateVariable(folder, id, patch));
  }

  setEquation(folder: string, id: string, patch: QuantPatch): Promise<VariableFile> {
    return this.guarded(() => this.engine.setEquation(folder, id, patch));
  }

  moveVariable(folder: string, id: string, x: number, y: number): Promise<void> {
    return this.guarded(() => this.engine.moveVariable(folder, id, x, y));
  }

  removeVariable(folder: string, id: string): Promise<void> {
    return this.guarded(() => this.engine.removeVariable(folder, id));
  }

  setSubsystem(
    folder: string,
    varId: string,
    child: { folder: string; name: string } | null,
  ): Promise<void> {
    return this.guarded(() => this.engine.setSubsystem(folder, varId, child));
  }

  addLink(folder: string, from: string, to: string, init?: LinkInit): Promise<void> {
    return this.guarded(() => this.engine.addLink(folder, from, to, init));
  }

  updateLink(folder: string, from: string, to: string, patch: LinkPatch): Promise<void> {
    return this.guarded(() => this.engine.updateLink(folder, from, to, patch));
  }

  removeLink(folder: string, from: string, to: string): Promise<void> {
    return this.guarded(() => this.engine.removeLink(folder, from, to));
  }

  relayout(folder: string): Promise<void> {
    return this.guarded(() => this.engine.relayout(folder));
  }
}
