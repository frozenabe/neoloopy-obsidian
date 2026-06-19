/**
 * Reference-mode behavior-over-time shapes — a TypeScript port of the Dart
 * helpers in `core/lib/cli/formats.dart` (`kReferenceShapes`,
 * `normReferencePattern`, `referenceSeries`). Each shape is a normalized 0..1
 * series sampled over equal time steps; the *shape* is what matters (neoloopy is
 * qualitative). Used to draw a reference-mode sparkline read-only.
 */

export const kReferenceShapes: Record<string, number[]> = {
  growth: [0.05, 0.08, 0.13, 0.22, 0.38, 0.62, 0.85, 1.0],
  decline: [1.0, 0.85, 0.62, 0.38, 0.22, 0.13, 0.08, 0.05],
  linear: [0.0, 0.14, 0.28, 0.42, 0.56, 0.7, 0.84, 1.0],
  "s-shaped": [0.05, 0.08, 0.16, 0.35, 0.65, 0.84, 0.92, 0.95],
  "goal-seeking": [0.0, 0.4, 0.65, 0.8, 0.88, 0.93, 0.96, 0.98],
  oscillation: [0.5, 0.85, 1.0, 0.85, 0.5, 0.15, 0.0, 0.15, 0.5],
  "overshoot-collapse": [0.1, 0.3, 0.6, 0.85, 1.0, 0.7, 0.35, 0.12, 0.05],
  "overshoot-oscillation": [0.2, 0.6, 0.95, 1.0, 0.8, 0.55, 0.62, 0.7, 0.66],
  flat: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
};

const ALIASES: Record<string, string> = {
  sigmoid: "s-shaped",
  s: "s-shaped",
  logistic: "s-shaped",
  exponential: "growth",
  "exponential-growth": "growth",
  decay: "decline",
  "exponential-decay": "decline",
  asymptotic: "goal-seeking",
  goal: "goal-seeking",
  oscillating: "oscillation",
  overshoot: "overshoot-collapse",
  collapse: "overshoot-collapse",
  equilibrium: "flat",
  steady: "flat",
};

/** Normalize a user-supplied pattern name to a canonical key, or null. */
export function normReferencePattern(p: string | null | undefined): string | null {
  if (p == null) return null;
  const k = p.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (k in kReferenceShapes) return k;
  return ALIASES[k] ?? null;
}

/** Resolve a reference mode to a 0..1 series: explicit points win, else the
 *  canonical shape for the pattern, else empty. */
export function referenceSeries(
  pattern?: string | null,
  points?: number[] | null,
): number[] {
  if (points != null && points.length > 0) return points;
  const p = normReferencePattern(pattern);
  return p == null ? [] : kReferenceShapes[p];
}
