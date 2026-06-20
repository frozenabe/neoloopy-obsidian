/**
 * 2D pan/zoom camera. Mirrors the transform model in
 * `app/lib/features/canvas/canvas_screen.dart`:
 *   screen = world * scale + translate
 *   world  = (screen - translate) / scale
 * Zoom is clamped to [0.08, 3.0]; zoom-to-cursor keeps the focal world point
 * pinned under the cursor.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_SCALE = 0.08;
export const MAX_SCALE = 3.0;
/** Zoom a fresh model opens at when there's nothing to fit (no nodes yet). */
export const DEFAULT_SCALE = 1.2;

export class Camera {
  scale = DEFAULT_SCALE;
  tx = 40;
  ty = 120;

  toScreen(wx: number, wy: number): Point {
    return { x: wx * this.scale + this.tx, y: wy * this.scale + this.ty };
  }

  toWorld(sx: number, sy: number): Point {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.tx += dxScreen;
    this.ty += dyScreen;
  }

  /** Zoom by `factor` keeping the world point under (sx,sy) fixed on screen. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    const after = this.toWorld(sx, sy);
    this.tx += (after.x - before.x) * this.scale;
    this.ty += (after.y - before.y) * this.scale;
  }

  setScaleAt(sx: number, sy: number, scale: number): void {
    const before = this.toWorld(sx, sy);
    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    const after = this.toWorld(sx, sy);
    this.tx += (after.x - before.x) * this.scale;
    this.ty += (after.y - before.y) * this.scale;
  }

  /** Frame `bounds` (world) within a viewport of `vw`×`vh` screen px. */
  fit(bounds: Bounds, vw: number, vh: number, pad = 120): void {
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    // Cap padding to a fraction of the viewport so a fixed margin can't exceed a
    // small (mobile) viewport — a 120px pad on a ~390px phone would leave a
    // negative content box and pin the camera at MIN_SCALE (nodes invisibly tiny).
    const p = Math.min(pad, vw * 0.15, vh * 0.15);
    const sx = (vw - p * 2) / w;
    const sy = (vh - p * 2) / h;
    this.scale = clamp(Math.min(sx, sy), MIN_SCALE, MAX_SCALE);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    this.tx = vw / 2 - cx * this.scale;
    this.ty = vh / 2 - cy * this.scale;
  }

  /** Pan (no zoom) so world point (wx,wy) sits at the center of a vw×vh view. */
  centerOn(wx: number, wy: number, vw: number, vh: number): void {
    this.tx = vw / 2 - wx * this.scale;
    this.ty = vh / 2 - wy * this.scale;
  }

  /** Restore the default zoom and center world origin in a vw×vh viewport. Used
   *  when opening a model with no saved viewport so an empty model can't inherit
   *  the previous view's scale (which could be tiny → first node invisibly small). */
  reset(vw: number, vh: number): void {
    this.scale = DEFAULT_SCALE;
    this.centerOn(0, 0, vw, vh);
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
