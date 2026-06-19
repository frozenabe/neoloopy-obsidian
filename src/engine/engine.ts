/**
 * The engine seam. Everything UI-facing talks to a `NeoloopyEngine`; the sole
 * implementation is `NativeEngine` (pure TypeScript, runs on every platform
 * including mobile, no binary, no network). The interface is kept narrow so the
 * view and tests can depend on it (and mock it) without touching internals.
 */

import {
  DetectedLoop,
  ModelManifest,
  VarType,
  VariableFile,
  Viewport,
} from "./types";
import { Rendered } from "./exporters";
import { ParentAnchor } from "./subsystemLinks";

/** Lightweight model descriptor for pickers/lists (no notes loaded). */
export interface ModelRef {
  id: string;
  name: string;
  /** Vault-relative folder path that holds `model.json` + the notes. */
  folder: string;
  /**
   * Organizational grouping label (the `model.json` `folder` field, set via
   * `set-folder`) — NOT the directory path above. Null/empty when ungrouped.
   * The picker groups by this, mirroring the app's folder-grouped models screen.
   */
  group: string | null;
  modified: string;
  variableCount: number;
  /** Carries quantitative data — read-only in this qualitative engine. */
  quant: boolean;
}

/** A fully loaded model plus its detected loops and labels. */
export interface GraphView {
  folder: string;
  manifest: ModelManifest;
  nodes: VariableFile[];
  loops: DetectedLoop[];
  /** loop.key -> "R1" / "B2" badge label. */
  labels: Map<string, string>;
  quant: boolean;
}

export interface NewVariable {
  label: string;
  type?: VarType;
  x?: number;
  y?: number;
  group?: string;
  shared?: string;
  claLayer?: string;
}

/**
 * Partial update for a variable. A field left `undefined` is untouched; an
 * explicit `null` on a nullable field clears it.
 */
export interface VariablePatch {
  label?: string;
  type?: VarType;
  group?: string | null;
  shared?: string | null;
  claLayer?: string | null;
  status?: string | null;
  tags?: string[];
  body?: string;
}

/**
 * A partial edit to a variable's quantitative definition (`extra.quant`). A
 * field left `undefined` is untouched; an empty string clears that field. When
 * the block ends up empty it is dropped so plain notes stay clean.
 */
export interface QuantPatch {
  equation?: string;
  initial?: string;
  units?: string;
}

export interface LinkInit {
  polarity?: "+" | "-";
  delay?: boolean;
  indirect?: boolean;
  nonlinear?: boolean;
  weight?: number;
  curvature?: number;
  confidence?: number;
  basis?: string;
}

/** Like `LinkInit`, but `curvature: null` explicitly clears it (auto-bow). */
export interface LinkPatch {
  polarity?: "+" | "-";
  delay?: boolean;
  indirect?: boolean;
  nonlinear?: boolean;
  weight?: number;
  curvature?: number | null;
  confidence?: number;
  basis?: string;
}

export interface BuildSpec {
  variables: Array<{
    id?: string;
    label: string;
    type?: VarType;
    group?: string;
    shared?: string;
  }>;
  /** `from`/`to` may be a variable label or id (labels resolved first). */
  links: Array<{ from: string; to: string } & LinkInit>;
  /** Auto-layout positions after building (default true). */
  layout?: boolean;
}

export type ExportFormat = "json" | "mermaid" | "markdown";

export interface NeoloopyEngine {
  listModels(): Promise<ModelRef[]>;
  createModel(name: string): Promise<ModelRef>;
  /**
   * Rename a model from the canvas (title is canonical): set the `model.json`
   * `name` AND re-slug + move the folder to match, suffixing `-2/-3…` on
   * collision. The move is link-aware so wikilinks and subsystem anchors follow.
   * Skips the move when the slug is unchanged. Rejects a blank title.
   */
  renameModel(folder: string, name: string): Promise<ModelRef>;
  /**
   * The inverse of renameModel for an *external* folder rename (folder is
   * canonical): set the `model.json` `name` to the new folder name IN PLACE,
   * without re-slugging or moving the directory. Rejects a blank title.
   */
  retitleModel(folder: string, name: string): Promise<ModelRef>;
  /**
   * The node-level inverse of retitleModel: after the user renames a variable
   * note in the vault (`Nodes/<stem>.md`), set its label to the de-slugged
   * stem. The stable `var_…` id and inbound links are untouched. No-op when the
   * file is gone or the label already matches.
   */
  relabelNodeFromFilename(folder: string, fileStem: string): Promise<void>;
  deleteModel(folder: string): Promise<void>;
  loadGraph(folder: string): Promise<GraphView>;

  addVariable(folder: string, init: NewVariable): Promise<VariableFile>;
  updateVariable(
    folder: string,
    id: string,
    patch: VariablePatch,
  ): Promise<VariableFile>;
  /**
   * Edit a variable's quantitative definition (`extra.quant`): equation,
   * initial value, and/or units. Merges into any existing block, preserving
   * keys it does not manage (e.g. a subscript dimension).
   */
  setEquation(
    folder: string,
    id: string,
    patch: QuantPatch,
  ): Promise<VariableFile>;
  /** Cosmetic position change — never bumps rev/modified. */
  moveVariable(folder: string, id: string, x: number, y: number): Promise<void>;
  removeVariable(folder: string, id: string): Promise<void>;

  /**
   * Link (or clear, with `child=null`) a node's subsystem anchor — the same
   * `[[../<childDir>/System|<Child Name>]]` wikilink the app/CLI write, so the
   * drill-in mark round-trips across all surfaces.
   */
  setSubsystem(
    folder: string,
    varId: string,
    child: { folder: string; name: string } | null,
  ): Promise<void>;

  addLink(
    folder: string,
    from: string,
    to: string,
    init?: LinkInit,
  ): Promise<void>;
  updateLink(
    folder: string,
    from: string,
    to: string,
    patch: LinkPatch,
  ): Promise<void>;
  removeLink(folder: string, from: string, to: string): Promise<void>;

  buildModel(folder: string, spec: BuildSpec): Promise<void>;
  relayout(folder: string): Promise<void>;
  setViewport(folder: string, viewport: Viewport): Promise<void>;

  export(folder: string, format: ExportFormat): Promise<Rendered>;

  /**
   * Loop notes — one `Loops/<slug>.md` file per feedback loop, identity-anchored
   * in frontmatter (the same files the Dart app/CLI write). Resolved into a map
   * keyed by `<R|B>:<sorted unique variable names>` so both surfaces agree.
   * `getLoopNotes` returns the body text per live loop; `setLoopNote` writes it
   * into the identity-matched file (preserving title/valence/archetype).
   */
  getLoopNotes(folder: string): Promise<Record<string, string>>;
  setLoopNote(folder: string, key: string, text: string): Promise<void>;

  /**
   * Vault-relative path of the canonical `Loops/*.md` file for `key`, creating
   * an empty anchored note if none exists. Null when no live loop carries that
   * key. The canvas opens this file directly for editing.
   */
  loopNotePath(folder: string, key: string): Promise<string | null>;

  /**
   * Ensure the model has a `System.md`, creating a minimal valid one (frontmatter
   * `model: "<id>"`) when absent. Returns its vault-relative path. The canvas
   * opens this file directly.
   */
  ensureSystemNote(folder: string): Promise<string>;

  /**
   * Parent systems of `folder` — models whose nodes anchor it as a subsystem.
   * Each anchor names the parent model + the linking variable. Empty when none.
   */
  deriveParents(folder: string): Promise<ParentAnchor[]>;
}
