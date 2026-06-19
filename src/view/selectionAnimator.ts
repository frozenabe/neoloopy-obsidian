/**
 * SelectionAnimator — the requestAnimationFrame loop driving the two canvas
 * animations: the selection pulse (2.4s) and the loop-flow dash (0.9s). It runs
 * only while something is selected and honors `prefers-reduced-motion`. It owns
 * the phase clocks and exposes them to the painter; `sync(active)` starts/stops
 * the loop to match the current selection.
 */

export class SelectionAnimator {
  private pulse = 0;
  private flow = 0;
  private anim: number | null = null;
  private animStart = 0;

  /** @param render repaint callback, invoked once per animation frame. */
  constructor(private readonly render: () => void) {}

  get pulsePhase(): number {
    return this.pulse;
  }

  get flowPhase(): number {
    return this.flow;
  }

  /** Run the loop while `active` (and motion is allowed); stop otherwise. A
   *  no-op when already in the desired state, so it's cheap to call on every
   *  selection change. */
  sync(active: boolean): void {
    if (!active || !this.canAnimate()) {
      this.stop();
      return;
    }
    if (this.anim !== null) return;
    this.animStart = this.nowMs();
    const tick = () => {
      const t = this.nowMs() - this.animStart;
      this.pulse = (t % 2400) / 2400;
      this.flow = (t % 900) / 900;
      this.render();
      this.anim = window.requestAnimationFrame(tick);
    };
    this.anim = window.requestAnimationFrame(tick);
  }

  /** Stop the loop and reset the phases (also used on view close). */
  stop(): void {
    if (this.anim !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.anim);
    this.anim = null;
    this.pulse = 0;
    this.flow = 0;
  }

  private canAnimate(): boolean {
    if (typeof requestAnimationFrame !== "function") return false;
    const mm = typeof window !== "undefined" ? window.matchMedia : undefined;
    if (mm && mm("(prefers-reduced-motion: reduce)").matches) return false;
    return true;
  }

  private nowMs(): number {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }
}
