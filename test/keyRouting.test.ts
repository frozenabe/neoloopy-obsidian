import { describe, expect, it } from "vitest";
import { KeyChord, routeKey, stepId } from "../src/view/keyRouting";

const chord = (key: string, mods: Partial<KeyChord> = {}): KeyChord => ({
  key,
  shift: false,
  meta: false,
  ctrl: false,
  alt: false,
  ...mods,
});

const noNode = { node: null };
const withNode = { node: "a" };

describe("routeKey", () => {
  it("Cmd/Ctrl+E exports, +T tidies, +/ shows shortcuts", () => {
    expect(routeKey(chord("e", { meta: true }), noNode)).toEqual({ kind: "export" });
    expect(routeKey(chord("t", { ctrl: true }), noNode)).toEqual({ kind: "tidy" });
    expect(routeKey(chord("/", { meta: true }), noNode)).toEqual({ kind: "shortcuts" });
  });

  it("an unhandled Cmd/Ctrl chord is left to Obsidian", () => {
    expect(routeKey(chord("p", { meta: true }), noNode)).toEqual({ kind: "none" });
  });

  it("Alt combos are left to Obsidian", () => {
    expect(routeKey(chord("n", { alt: true }), noNode)).toEqual({ kind: "none" });
  });

  it("Tab / Shift+Tab step node selection", () => {
    expect(routeKey(chord("Tab"), noNode)).toEqual({ kind: "selectStep", dir: 1 });
    expect(routeKey(chord("Tab", { shift: true }), noNode)).toEqual({ kind: "selectStep", dir: -1 });
  });

  it("E / O step edges and loops (case-insensitive)", () => {
    expect(routeKey(chord("e"), noNode)).toEqual({ kind: "selectEdgeStep", dir: 1 });
    expect(routeKey(chord("E", { shift: true }), noNode)).toEqual({ kind: "selectEdgeStep", dir: -1 });
    expect(routeKey(chord("o"), noNode)).toEqual({ kind: "selectLoopStep", dir: 1 });
  });

  it("N adds, L arms a link, Enter is context-sensitive", () => {
    expect(routeKey(chord("n"), noNode)).toEqual({ kind: "addNode" });
    expect(routeKey(chord("l"), noNode)).toEqual({ kind: "armLink" });
    expect(routeKey(chord("Enter"), noNode)).toEqual({ kind: "enter" });
  });

  it("F2 renames only with a selected node", () => {
    expect(routeKey(chord("F2"), withNode)).toEqual({ kind: "rename" });
    expect(routeKey(chord("F2"), noNode)).toEqual({ kind: "none" });
  });

  it("Delete/Backspace delete, Escape clears", () => {
    expect(routeKey(chord("Delete"), withNode)).toEqual({ kind: "deleteSelection" });
    expect(routeKey(chord("Backspace"), withNode)).toEqual({ kind: "deleteSelection" });
    expect(routeKey(chord("Escape"), noNode)).toEqual({ kind: "escape" });
  });

  it("arrows nudge with direction + magnitude flag", () => {
    expect(routeKey(chord("ArrowUp"), withNode)).toEqual({ kind: "nudge", dx: 0, dy: -1, big: false });
    expect(routeKey(chord("ArrowRight", { shift: true }), withNode)).toEqual({
      kind: "nudge",
      dx: 1,
      dy: 0,
      big: true,
    });
  });

  it("+/-/0 zoom and fit", () => {
    expect(routeKey(chord("+"), noNode)).toEqual({ kind: "zoom", factor: 1.15 });
    expect(routeKey(chord("="), noNode)).toEqual({ kind: "zoom", factor: 1.15 });
    expect(routeKey(chord("-"), noNode)).toEqual({ kind: "zoom", factor: 1 / 1.15 });
    expect(routeKey(chord("0"), noNode)).toEqual({ kind: "fit" });
  });

  it("an unhandled key is left to Obsidian", () => {
    expect(routeKey(chord("z"), noNode)).toEqual({ kind: "none" });
  });
});

describe("stepId", () => {
  const ids = ["a", "b", "c"];

  it("wraps forward and backward", () => {
    expect(stepId(ids, "a", 1)).toBe("b");
    expect(stepId(ids, "c", 1)).toBe("a");
    expect(stepId(ids, "a", -1)).toBe("c");
  });

  it("null current starts at first (fwd) or last (back)", () => {
    expect(stepId(ids, null, 1)).toBe("a");
    expect(stepId(ids, null, -1)).toBe("c");
  });

  it("a current outside the pool restarts from the approached end", () => {
    expect(stepId(ids, "zz", 1)).toBe("a");
    expect(stepId(ids, "zz", -1)).toBe("c");
  });

  it("empty pool → null", () => {
    expect(stepId([], "a", 1)).toBeNull();
  });
});
