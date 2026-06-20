/**
 * View-side loop-key derivation. The canvas needs the engine's resolved-map key
 * (`<R|B>:<sorted unique member labels>`) to look a loop up in the loop-notes
 * cache and to ask the engine for its `Loops/*.md` path. It derives that key
 * from a `DetectedLoop` plus a name resolver, delegating the actual formatting
 * to the shared `loopKey` so the view and engine never drift.
 */

import { LoopType, loopKey } from "@neoloopy/cld-canvas";

/** A loop's resolvable shape — just what key derivation needs. */
export interface LoopLike {
  nodeIds: string[];
  type: LoopType;
}

/**
 * Member variable names of a loop, resolved through `nameOf` (`?? id`, not
 * `|| id`, so an empty label stays empty and matches the engine's `name`).
 * De-duplicated and sorted, matching the engine's `loopKey` ordering.
 */
export function loopMemberNames(loop: LoopLike, nameOf: (id: string) => string): string[] {
  return [...new Set(loop.nodeIds.map((id) => nameOf(id)))].sort();
}

/**
 * The `model.json`/loop-notes map key for a loop — identical to the engine's
 * `loopKey`, so a note shown on the canvas is the same note the app/CLI write.
 */
export function loopNoteKey(loop: LoopLike, nameOf: (id: string) => string): string {
  const letter = loop.type === LoopType.reinforcing ? "R" : "B";
  return loopKey(loop.nodeIds.map((id) => nameOf(id)), letter);
}
