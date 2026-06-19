import { describe, expect, it } from "vitest";
import { DOUBLE_TAP_MS, DOUBLE_TAP_SLOP, Tap, isDoubleTap } from "../src/view/tapGesture";

const tap = (time: number, x = 0, y = 0): Tap => ({ time, point: { x, y } });

describe("isDoubleTap", () => {
  it("never fires without a prior tap", () => {
    expect(isDoubleTap(null, tap(100))).toBe(false);
  });

  it("fires for two quick taps at the same spot", () => {
    expect(isDoubleTap(tap(100), tap(100 + DOUBLE_TAP_MS - 1))).toBe(true);
  });

  it("does not fire once the gap exceeds the window", () => {
    expect(isDoubleTap(tap(100), tap(100 + DOUBLE_TAP_MS + 1))).toBe(false);
  });

  it("does not fire when the second tap lands too far away", () => {
    expect(isDoubleTap(tap(100, 0, 0), tap(150, DOUBLE_TAP_SLOP + 1, 0))).toBe(false);
  });

  it("tolerates touch wander up to the slop radius", () => {
    expect(isDoubleTap(tap(100, 0, 0), tap(150, DOUBLE_TAP_SLOP, 0))).toBe(true);
  });

  it("ignores a non-monotonic timestamp (curr before prev)", () => {
    expect(isDoubleTap(tap(200), tap(100))).toBe(false);
  });
});
