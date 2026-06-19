/**
 * Deterministic Fruchterman-Reingold layout (circle seed, no RNG) — TypeScript
 * port of `autoLayout` in `core/lib/cli/formats.dart`. Produces round, evenly
 * spaced loops; an overlap-removal pass nudges only the node boxes that still
 * collide. Identical inputs yield identical positions across CLI/app/plugin, so
 * "Tidy" is consistent everywhere.
 */

export interface LayoutNode {
  id: string;
  name: string;
  kind?: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

const clampMin = (d: number, lo: number): number => (d < lo ? lo : d);

export function boxSize(name: string, kind?: string): [number, number] {
  const h = kind === "stock" ? 40 : 34;
  const extra = kind === "flow" ? 40 : 36;
  const w = Math.max(60, name.length * 7.2 + extra);
  return [w, h];
}

/** Returns id -> [x, y]. */
export function autoLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  cx = 280,
  cy = 300,
): Map<string, [number, number]> {
  const ids = nodes.map((v) => v.id);
  const n = ids.length;
  const result = new Map<string, [number, number]>();
  if (n === 0) return result;
  if (n === 1) {
    result.set(ids[0], [cx, cy]);
    return result;
  }
  const idx = new Map<string, number>();
  ids.forEach((id, i) => idx.set(id, i));
  const radius = Math.max(170, n * 34);
  const pos = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pos.set(ids[i], [cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }

  const adj: Array<[string, string]> = [];
  for (const e of edges) {
    const s = String(e.source);
    const t = String(e.target);
    if (idx.has(s) && idx.has(t) && s !== t) adj.push([s, t]);
  }

  const area = Math.pow(2.2 * radius, 2);
  const k = 1.15 * Math.sqrt(area / n);
  let temp = radius * 0.3;

  for (let iter = 0; iter < 320; iter++) {
    const disp = new Map<string, [number, number]>();
    for (const id of ids) disp.set(id, [0, 0]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const vi = ids[i];
        const vj = ids[j];
        const pi = pos.get(vi)!;
        const pj = pos.get(vj)!;
        const dx = pi[0] - pj[0];
        const dy = pi[1] - pj[1];
        const d = clampMin(Math.sqrt(dx * dx + dy * dy), 0.01);
        const f = (k * k) / d;
        const ux = dx / d;
        const uy = dy / d;
        const di = disp.get(vi)!;
        const dj = disp.get(vj)!;
        di[0] += ux * f;
        di[1] += uy * f;
        dj[0] -= ux * f;
        dj[1] -= uy * f;
      }
    }
    for (const [a, b] of adj) {
      const pa = pos.get(a)!;
      const pb = pos.get(b)!;
      const dx = pa[0] - pb[0];
      const dy = pa[1] - pb[1];
      const d = clampMin(Math.sqrt(dx * dx + dy * dy), 0.01);
      const f = (d * d) / k;
      const ux = dx / d;
      const uy = dy / d;
      const da = disp.get(a)!;
      const db = disp.get(b)!;
      da[0] -= ux * f;
      da[1] -= uy * f;
      db[0] += ux * f;
      db[1] += uy * f;
    }
    for (const id of ids) {
      const dp = disp.get(id)!;
      const p = pos.get(id)!;
      const d = clampMin(Math.sqrt(dp[0] * dp[0] + dp[1] * dp[1]), 0.01);
      p[0] += (dp[0] / d) * Math.min(d, temp);
      p[1] += (dp[1] / d) * Math.min(d, temp);
    }
    temp *= 0.97;
  }

  // Overlap removal using real label box sizes.
  const sizes = new Map<string, [number, number]>();
  for (const v of nodes) sizes.set(v.id, boxSize(v.name, v.kind));
  const margin = 18;
  for (let iter = 0; iter < 120; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const vi = ids[i];
        const vj = ids[j];
        const si = sizes.get(vi)!;
        const sj = sizes.get(vj)!;
        const pi = pos.get(vi)!;
        const pj = pos.get(vj)!;
        const dx = pj[0] - pi[0];
        const dy = pj[1] - pi[1];
        const ox = (si[0] + sj[0]) / 2 + margin - Math.abs(dx);
        const oy = (si[1] + sj[1]) / 2 + margin - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox <= oy) {
            const push = (ox / 2) * (dx < 0 ? -1 : 1);
            pi[0] -= push;
            pj[0] += push;
          } else {
            const push = (oy / 2) * (dy < 0 ? -1 : 1);
            pi[1] -= push;
            pj[1] += push;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  let mx = 0;
  let my = 0;
  for (const p of pos.values()) {
    mx += p[0];
    my += p[1];
  }
  mx /= n;
  my /= n;
  for (const [id, p] of pos) {
    result.set(id, [Number((p[0] - mx + cx).toFixed(1)), Number((p[1] - my + cy).toFixed(1))]);
  }
  return result;
}
