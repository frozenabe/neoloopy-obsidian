/**
 * PointerInteraction — the canvas pointer state machine, lifted whole out of
 * CanvasView. It owns the gesture mode and all transient drag/pinch state, and
 * binds the canvas pointer/wheel/dblclick/contextmenu listeners itself. Hit-test
 * routing (what a press means) is delegated to the pure `routePointerDown`; this
 * class only applies the resulting side effects through a narrow `PointerHost`.
 *
 * Gestures (ported faithfully from the app): pan (drag empty space / two-finger
 * swipe), pinch-zoom, move a node, draw a link from the selected node's
 * connect-ring, bow an edge's curvature, drag a loop badge, double-click (mouse)
 * or double-tap (touch) to add a variable or rename a node. Right-click is a
 * deliberate no-op (parity).
 */

import {
  Camera,
  GraphView,
  NodeBox,
  Point,
  Scene,
  hitEdge,
  hitNode,
} from "@neoloopy/cld-canvas";
import { routePointerDown } from "./pointerRouting";
import { Tap, isDoubleTap } from "./tapGesture";

export type PointerMode = "idle" | "pan" | "moveNode" | "moveBadge" | "drawLink" | "bowEdge" | "pinch";

/** What the pointer machine needs from the canvas view. */
export interface PointerHost {
  readonly camera: Camera;
  scene(): Scene | null;
  graph(): GraphView | null;
  selection(): { node: string | null; edge: string | null; loop: string | null };
  hasFolder(): boolean;
  /** Session-only loop-badge positions; a badge drag writes here directly. */
  loopBadgeOverrides(): Map<string, Point>;
  listen(el: HTMLElement, type: string, cb: (e: Event) => void, options?: AddEventListenerOptions): void;

  select(node: string | null, edge: string | null, loop: string | null): void;
  render(): void;
  rebuildScene(): void;
  persistViewport(): void;
  commitRename(): void;
  /** A new pointer gesture cancels any keyboard-armed link (app parity). */
  cancelArmedLink(): void;
  startRename(id: string): void;

  previewNodePosition(id: string, x: number, y: number): void;
  renderPosition(id: string): Point | null;
  persistNodePosition(id: string, x: number, y: number): Promise<void>;
  createConnection(from: string, to: string | null, at: Point): Promise<string | null>;
  commitBow(source: string, target: string, curvature: number | undefined): Promise<void>;
  createNodeAt(world: Point): Promise<void>;
}

export class PointerInteraction {
  private mode: PointerMode = "idle";
  private readonly pointers = new Map<number, Point>();
  private downScreen: Point = { x: 0, y: 0 };
  private lastScreen: Point = { x: 0, y: 0 };
  private moved = false;
  private dragNodeId: string | null = null;
  private dragNodeStart: Point = { x: 0, y: 0 };
  private dragWorldStart: Point = { x: 0, y: 0 };
  private linkFrom: string | null = null;
  private previewPoint: Point | null = null;
  private connectNodeId: string | null = null;
  private dragLoopKey: string | null = null;
  private pinchDist = 0;
  private pinchMid: Point = { x: 0, y: 0 };
  private bowLink: { curvature?: number } | null = null;
  private bowSource: string | null = null;
  private bowTarget: string | null = null;
  /** Last simple touch/pen tap, for synthesizing double-taps (iOS has no
   *  reliable `dblclick` on touch). Null when none is pending or one was used. */
  private lastTap: Tap | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly host: PointerHost) {
    host.listen(canvas, "pointerdown", (e) => this.onPointerDown(e as PointerEvent));
    host.listen(canvas, "pointermove", (e) => this.onPointerMove(e as PointerEvent));
    host.listen(canvas, "pointerup", (e) => void this.onPointerUp(e as PointerEvent));
    host.listen(canvas, "pointercancel", (e) => void this.onPointerUp(e as PointerEvent));
    host.listen(canvas, "wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
    host.listen(canvas, "dblclick", (e) => this.onDoubleClick(e as MouseEvent));
    host.listen(canvas, "contextmenu", (e) => this.onContextMenu(e as MouseEvent));
  }

  /** True when no gesture is in flight — drives the selection chrome's visibility. */
  isIdle(): boolean {
    return this.mode === "idle";
  }

  /** The active link-draw preview line (drawLink gesture), else null. */
  get linkPreview(): { from: string; to: Point } | null {
    return this.linkFrom && this.previewPoint ? { from: this.linkFrom, to: this.previewPoint } : null;
  }

  /** The node currently under a drawLink cursor (highlighted as a drop target). */
  get connectNode(): string | null {
    return this.connectNodeId;
  }

  private canvasPoint(e: PointerEvent | MouseEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.host.hasFolder()) return;
    this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.canvasPoint(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2) {
      this.beginPinch();
      return;
    }
    this.host.commitRename();
    // Any pointer gesture cancels a keyboard-armed link, like the app.
    this.host.cancelArmedLink();

    this.downScreen = p;
    this.lastScreen = p;
    this.moved = false;
    const world = this.host.camera.toWorld(p.x, p.y);
    const scene = this.host.scene();
    if (!scene) return;

    // Resolve what this press means via the pure router (badge → connect-ring →
    // bow-edge → node → edge → empty), then apply the side effects here.
    const intent = routePointerDown(scene, world, this.host.camera.scale, this.host.selection());
    switch (intent.kind) {
      case "moveBadge":
        this.mode = "moveBadge";
        this.dragLoopKey = intent.loop;
        break;
      case "selectBadge":
        this.host.select(null, null, intent.loop);
        this.mode = "idle";
        break;
      case "drawLink":
        this.mode = "drawLink";
        this.linkFrom = intent.from;
        this.previewPoint = world;
        break;
      case "bowEdge":
        this.mode = "bowEdge";
        this.bowLink = intent.edge.link;
        this.bowSource = intent.edge.source;
        this.bowTarget = intent.edge.target;
        break;
      case "moveNode": {
        // Selection-first: this node was already active, so the press begins a drag.
        this.host.select(intent.node, null, null);
        this.mode = "moveNode";
        this.dragNodeId = intent.node;
        const box = scene.boxes.get(intent.node) as NodeBox;
        this.dragNodeStart = { x: box.cx, y: box.cy };
        this.dragWorldStart = world;
        break;
      }
      case "selectNode":
        this.host.select(intent.node, null, null);
        this.mode = "idle";
        break;
      case "selectEdge":
        this.host.select(null, intent.edge, null);
        this.mode = "idle";
        break;
      case "pan":
        this.host.select(null, null, null);
        this.mode = "pan";
        break;
    }
    this.host.render();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.canvasPoint(e);
    this.pointers.set(e.pointerId, p);

    if (this.mode === "pinch") {
      this.updatePinch();
      return;
    }

    const dx = p.x - this.downScreen.x;
    const dy = p.y - this.downScreen.y;
    if (Math.hypot(dx, dy) > 3) this.moved = true;

    const camera = this.host.camera;
    const graph = this.host.graph();
    const scene = this.host.scene();
    if (this.mode === "pan" && this.moved) {
      camera.panBy(p.x - this.lastScreen.x, p.y - this.lastScreen.y);
      this.host.persistViewport();
    } else if (this.mode === "moveNode" && this.moved && this.dragNodeId && graph) {
      const world = camera.toWorld(p.x, p.y);
      const node = graph.nodes.find((n) => n.id === this.dragNodeId);
      if (node) {
        this.host.previewNodePosition(
          node.id,
          this.dragNodeStart.x + (world.x - this.dragWorldStart.x),
          this.dragNodeStart.y + (world.y - this.dragWorldStart.y),
        );
        this.host.rebuildScene();
      }
    } else if (this.mode === "moveBadge" && this.moved && this.dragLoopKey) {
      this.host.loopBadgeOverrides().set(this.dragLoopKey, camera.toWorld(p.x, p.y));
      this.host.rebuildScene();
    } else if (this.mode === "drawLink" && scene) {
      const world = camera.toWorld(p.x, p.y);
      this.previewPoint = world;
      const over = hitNode(scene.boxes, world);
      this.connectNodeId = over && over !== this.linkFrom ? over : null;
    } else if (this.mode === "bowEdge" && this.moved && this.bowLink && scene) {
      const world = camera.toWorld(p.x, p.y);
      const a = scene.boxes.get(this.bowSource as string);
      const b = scene.boxes.get(this.bowTarget as string);
      if (a && b) {
        const ex = b.cx - a.cx;
        const ey = b.cy - a.cy;
        const len = Math.hypot(ex, ey) || 1;
        const nx = -ey / len;
        const ny = ex / len;
        const mx = (a.cx + b.cx) / 2;
        const my = (a.cy + b.cy) / 2;
        this.bowLink.curvature = (world.x - mx) * nx + (world.y - my) * ny;
        this.host.rebuildScene();
      }
    }
    this.lastScreen = p;
    this.host.render();
  }

  private async onPointerUp(e: PointerEvent): Promise<void> {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);

    const mode = this.mode;
    if (mode === "pinch") {
      if (this.pointers.size < 2) {
        this.mode = "idle";
        this.host.persistViewport();
      }
      return;
    }

    const graph = this.host.graph();
    if (mode === "moveNode" && this.moved && this.dragNodeId && this.host.hasFolder() && graph) {
      const p = this.host.renderPosition(this.dragNodeId);
      if (p) await this.host.persistNodePosition(this.dragNodeId, p.x, p.y);
    } else if (mode === "drawLink" && this.host.hasFolder()) {
      const scene = this.host.scene();
      const world = this.host.camera.toWorld(this.canvasPoint(e).x, this.canvasPoint(e).y);
      const target = scene ? hitNode(scene.boxes, world) : null;
      if (this.linkFrom) {
        const next = await this.host.createConnection(
          this.linkFrom,
          target && target !== this.linkFrom ? target : null,
          world,
        );
        if (next) this.host.select(next, null, null); // chain: A→B→C, or select the new flow valve
      }
    } else if (mode === "bowEdge" && this.moved && this.bowLink && this.host.hasFolder() && this.bowSource && this.bowTarget) {
      await this.host.commitBow(this.bowSource, this.bowTarget, this.bowLink.curvature);
    }

    // iOS WebKit doesn't fire `dblclick` for touch, so synthesize a double-tap
    // from the pointer stream: two quick, stationary single-finger taps run the
    // same add/rename action as a desktop double-click. Mouse keeps using the
    // native `dblclick` handler, so guard on pointer type to avoid firing twice.
    // Runs synchronously (no prior `await` on a stationary tap) so a node's
    // rename input still focuses inside the gesture and iOS shows the keyboard.
    if (e.pointerType !== "mouse" && this.pointers.size === 0) {
      if (this.moved) {
        this.lastTap = null; // a drag breaks any double-tap sequence
      } else {
        const curr: Tap = { time: e.timeStamp, point: this.canvasPoint(e) };
        if (isDoubleTap(this.lastTap, curr)) {
          this.lastTap = null;
          this.doubleTapAt(curr.point);
        } else {
          this.lastTap = curr;
        }
      }
    }

    this.mode = "idle";
    this.dragNodeId = null;
    this.dragLoopKey = null;
    this.linkFrom = null;
    this.previewPoint = null;
    this.connectNodeId = null;
    this.bowLink = null;
    this.bowSource = null;
    this.bowTarget = null;
    this.host.render();
  }

  private beginPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    this.mode = "pinch";
    this.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    this.pinchMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  private updatePinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    if (this.pinchDist > 0) this.host.camera.zoomAt(mid.x, mid.y, dist / this.pinchDist);
    this.host.camera.panBy(mid.x - this.pinchMid.x, mid.y - this.pinchMid.y);
    this.pinchDist = dist;
    this.pinchMid = mid;
    this.host.persistViewport();
    this.host.render();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.host.hasFolder()) return;
    e.preventDefault();
    // Match the app's trackpad motion: ctrl-wheel (a macOS pinch) zooms about the
    // cursor; a plain two-finger swipe (or mouse wheel) pans. There is no
    // mouse-wheel zoom — plain-mouse zoom is the +/−/0 keys, as in the app.
    if (e.ctrlKey) {
      const p = this.canvasPoint(e);
      // Chromium reports a trackpad pinch as ctrl+wheel where deltaY ≈ −100×
      // magnification, so exp(−deltaY·0.01) tracks the OS magnification 1:1.
      this.host.camera.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.01));
    } else {
      this.host.camera.panBy(-e.deltaX, -e.deltaY);
    }
    this.host.persistViewport();
    this.host.render();
  }

  private onDoubleClick(e: MouseEvent): void {
    this.doubleTapAt(this.canvasPoint(e));
  }

  /** The double-click/double-tap action, shared by the native `dblclick` (mouse)
   *  and the touch double-tap detector: rename the node under `p`, do nothing on
   *  an edge, else create a node there. `p` is canvas-space. */
  private doubleTapAt(p: Point): void {
    const scene = this.host.scene();
    if (!this.host.hasFolder() || !scene) return;
    const world = this.host.camera.toWorld(p.x, p.y);
    const node = hitNode(scene.boxes, world);
    if (node) {
      this.host.startRename(node);
      return;
    }
    if (hitEdge(scene.edges, world, this.host.camera.scale)) return;
    void this.host.createNodeAt(world);
  }

  private onContextMenu(e: MouseEvent): void {
    // The app has no canvas context menu — right-click is a no-op there. Match
    // it: suppress the default menu and show nothing. Node/edge actions live on
    // the on-canvas reveal menus and the trash FAB.
    e.preventDefault();
  }
}
