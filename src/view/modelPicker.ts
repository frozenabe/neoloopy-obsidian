/**
 * Pure decision logic for keeping the canvas's active model in sync with the set
 * of models on disk. When a model folder is created, deleted, or renamed outside
 * the plugin (e.g. in Obsidian's file explorer), the picker is rebuilt — and if
 * the *open* model was the one removed, the view has to pick what to show next.
 * Kept obsidian-free so it can be unit-tested directly.
 */

import { ModelRef } from "@neoloopy/cld-canvas";

export type PickerReconcile =
  | { action: "keep" }
  | { action: "switch"; folder: string }
  | { action: "clear" };

/**
 * Decide what the open canvas should do after the model set changes externally:
 * - `keep`   — nothing open, or the open model still exists; leave selection.
 * - `switch` — the open model was deleted but others remain; open the first.
 * - `clear`  — the open model was the last one deleted; show the empty state.
 *
 * `models` is assumed already sorted (listModels sorts by name), so the switch
 * target is deterministic.
 */
export function reconcileActiveModel(
  models: ModelRef[],
  current: string | null,
): PickerReconcile {
  if (current === null) return { action: "keep" };
  if (models.some((m) => m.folder === current)) return { action: "keep" };
  if (models.length === 0) return { action: "clear" };
  return { action: "switch", folder: models[0].folder };
}
