/**
 * Pure double-tap detection over the canvas's own pointer stream.
 *
 * iOS WebKit (Obsidian mobile) does not reliably deliver a `dblclick`
 * MouseEvent for a touch double-tap, so on touch the canvas cannot lean on the
 * native event the way the desktop app does. Instead it records each simple tap
 * and asks this helper whether the latest one closes a double-tap: two taps in
 * quick succession at nearly the same spot. Kept side-effect-free so the timing
 * rule is testable without a DOM.
 */

import { Point } from "@neoloopy/cld-canvas";

export interface Tap {
  /** Event timestamp in ms (`PointerEvent.timeStamp`). */
  time: number;
  /** Canvas-space point of the tap. */
  point: Point;
}

/** Max gap between two taps to count as a double-tap (ms). */
export const DOUBLE_TAP_MS = 300;
/** Max movement between two taps to count as a double-tap (canvas px). Looser
 *  than a mouse's couple of pixels because a finger's contact point wanders. */
export const DOUBLE_TAP_SLOP = 24;

/**
 * True when `curr` closes a double-tap against the previously recorded `prev`.
 * `prev` is null when there is no pending tap (none yet, or the last one was
 * already consumed or timed out).
 */
export function isDoubleTap(
  prev: Tap | null,
  curr: Tap,
  maxDelayMs: number = DOUBLE_TAP_MS,
  maxSlopPx: number = DOUBLE_TAP_SLOP,
): boolean {
  if (!prev) return false;
  const dt = curr.time - prev.time;
  if (dt < 0 || dt > maxDelayMs) return false;
  return Math.hypot(curr.point.x - prev.point.x, curr.point.y - prev.point.y) <= maxSlopPx;
}
