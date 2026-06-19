/**
 * Pure keyboard routing — maps a key press (plus modifiers and the current
 * selection) to a canvas command. `onKeyDown` in the view does the I/O
 * (preventDefault, execute, render); this owns the dispatch table so the
 * app-parity key set is testable without a DOM event.
 *
 * Every handled command implies `preventDefault`; `{ kind: "none" }` means the
 * press is left to Obsidian. Mirrors the native app's `_keyBindings`.
 */

/** Just the fields routing needs from a `KeyboardEvent`. */
export interface KeyChord {
  key: string;
  shift: boolean;
  /** Cmd on macOS / Ctrl elsewhere — the app-command chord. */
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
}

/** What the canvas currently has selected (only `node` matters for routing). */
export interface KeySelection {
  node: string | null;
}

export type KeyCommand =
  | { kind: "export" }
  | { kind: "tidy" }
  | { kind: "shortcuts" }
  | { kind: "selectStep"; dir: number }
  | { kind: "selectEdgeStep"; dir: number }
  | { kind: "selectLoopStep"; dir: number }
  | { kind: "addNode" }
  | { kind: "armLink" }
  | { kind: "enter" }
  | { kind: "rename" }
  | { kind: "deleteSelection" }
  | { kind: "escape" }
  | { kind: "nudge"; dx: number; dy: number; big: boolean }
  | { kind: "zoom"; factor: number }
  | { kind: "fit" }
  | { kind: "none" };

const ZOOM_IN = 1.15;

export function routeKey(e: KeyChord, sel: KeySelection): KeyCommand {
  // App-level chords (Cmd/Ctrl). Every other modifier combo is left to Obsidian
  // so we never shadow its shortcuts.
  if (e.meta || e.ctrl) {
    switch (e.key.toLowerCase()) {
      case "e":
        return { kind: "export" };
      case "t":
        return { kind: "tidy" };
      case "/":
        return { kind: "shortcuts" };
      default:
        return { kind: "none" };
    }
  }
  if (e.alt) return { kind: "none" };

  switch (e.key) {
    case "?":
      return { kind: "shortcuts" };
    case "Tab":
      return { kind: "selectStep", dir: e.shift ? -1 : 1 };
    case "e":
    case "E":
      return { kind: "selectEdgeStep", dir: e.shift ? -1 : 1 };
    case "o":
    case "O":
      return { kind: "selectLoopStep", dir: e.shift ? -1 : 1 };
    case "n":
    case "N":
      return { kind: "addNode" };
    case "l":
    case "L":
      return { kind: "armLink" };
    case "Enter":
      return { kind: "enter" };
    case "F2":
      // F2 renames only when a node is selected; otherwise leave it to Obsidian.
      return sel.node ? { kind: "rename" } : { kind: "none" };
    case "Delete":
    case "Backspace":
      return { kind: "deleteSelection" };
    case "Escape":
      return { kind: "escape" };
    case "ArrowUp":
      return { kind: "nudge", dx: 0, dy: -1, big: e.shift };
    case "ArrowDown":
      return { kind: "nudge", dx: 0, dy: 1, big: e.shift };
    case "ArrowLeft":
      return { kind: "nudge", dx: -1, dy: 0, big: e.shift };
    case "ArrowRight":
      return { kind: "nudge", dx: 1, dy: 0, big: e.shift };
    case "+":
    case "=":
      return { kind: "zoom", factor: ZOOM_IN };
    case "-":
      return { kind: "zoom", factor: 1 / ZOOM_IN };
    case "0":
      return { kind: "fit" };
    default:
      return { kind: "none" };
  }
}

/**
 * Cyclic selection stepping shared by Tab/E/O. Returns the id `dir` steps from
 * `current` in `ids` (wrapping both ways), or null when the pool is empty. A
 * `current` that is not in the pool (or null) starts from the end the step
 * approaches — matching the app's `_kbSelect*` index math.
 */
export function stepId(ids: string[], current: string | null, dir: number): string | null {
  if (ids.length === 0) return null;
  let i = current === null ? (dir > 0 ? -1 : 0) : ids.indexOf(current);
  if (i < 0) i = dir > 0 ? -1 : 0;
  i = (i + dir) % ids.length;
  if (i < 0) i += ids.length;
  return ids[i];
}
