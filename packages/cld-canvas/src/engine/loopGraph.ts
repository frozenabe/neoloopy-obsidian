/**
 * Pure in-memory graph built from parsed vault notes — TypeScript port of
 * `core/lib/graph/loop_graph.dart`.
 *
 * Loop detection excludes `indirect` (dashed) links and classifies each simple
 * directed cycle by the product of its link polarities: even number of `-` -> R
 * (reinforcing), odd -> B (balancing). `delay` is ignored. Enumeration
 * canonicalizes each cycle to start at its minimum node id and only extends to
 * ids >= the start, yielding each cycle once with no artificial depth bound.
 */

import {
  DetectedLoop,
  LoopType,
  VariableFile,
} from "./types";

/** One adjacency edge as seen by a trace. */
export interface TracedEdge {
  to: string;
  polarity: number;
  indirect: boolean;
  confidence?: number;
  basis?: string;
}

export interface VarMetrics {
  inDegree: number;
  outDegree: number;
  loopCount: number;
}

const strcmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Deterministic loop labels: reinforcing -> R1,R2,… and balancing -> B1,B2,….
 * Existing qualitative loops keep their historical ordering and numbering;
 * quantitative-only loops follow them in the same deterministic name order.
 */
export function labelLoopsByKey(
  loops: DetectedLoop[],
  name: (id: string) => string,
): Map<string, string> {
  const sortNames = (l: DetectedLoop): string[] =>
    l.nodeIds.map((id) => name(id).toLowerCase()).sort();
  const compareNames = (a: DetectedLoop, b: DetectedLoop): number => {
    const left = sortNames(a);
    const right = sortNames(b);
    if (left.length !== right.length) return left.length - right.length;
    for (let i = 0; i < left.length; i++) {
      const compared = strcmp(left[i], right[i]);
      if (compared !== 0) return compared;
    }
    return 0;
  };
  const result = new Map<string, string>();
  for (const type of [LoopType.reinforcing, LoopType.balancing]) {
    const qualitative = loops
      .filter((l) => l.type === type && l.identityMode === "qualitative")
      .sort(compareNames);
    const quantitative = loops
      .filter((l) => l.type === type && l.identityMode === "quantitative")
      .sort((a, b) => {
        const names = compareNames(a, b);
        return names !== 0 ? names : strcmp(a.key, b.key);
      });
    const group = [...qualitative, ...quantitative];
    const prefix = type === LoopType.reinforcing ? "R" : "B";
    group.forEach((l, i) => result.set(l.key, `${prefix}${i + 1}`));
  }
  return result;
}

export class LoopGraph {
  private readonly nodes: Map<string, VariableFile>;

  constructor(notes: Iterable<VariableFile>) {
    this.nodes = new Map();
    for (const n of notes) this.nodes.set(n.id, n);
  }

  get allNodes(): VariableFile[] {
    return [...this.nodes.values()];
  }

  node(id: string): VariableFile | undefined {
    return this.nodes.get(id);
  }

  /** Full causal adjacency including `indirect` links, with evidence carries. */
  adjacency(reverse = false): Map<string, TracedEdge[]> {
    const adj = new Map<string, TracedEdge[]>();
    for (const id of this.nodes.keys()) adj.set(id, []);
    for (const n of this.nodes.values()) {
      for (const l of n.links) {
        if (!this.nodes.has(l.to)) continue;
        const pol = l.polarity === "-" ? -1 : l.polarity === "+" ? 1 : 0;
        const from = reverse ? l.to : n.id;
        const to = reverse ? n.id : l.to;
        adj.get(from)!.push({
          to,
          polarity: pol,
          indirect: l.indirect,
          confidence: l.confidence,
          basis: l.basis,
        });
      }
    }
    return adj;
  }

  /** Direct (loop-relevant) adjacency: source -> [target, polaritySign]. */
  private directAdjacency(): Map<string, Array<[string, number]>> {
    const adj = new Map<string, Array<[string, number]>>();
    for (const n of this.nodes.values()) {
      for (const l of n.links) {
        if (l.indirect) continue;
        if (l.polarity !== "+" && l.polarity !== "-") continue;
        if (!this.nodes.has(l.to)) continue;
        if (!adj.has(n.id)) adj.set(n.id, []);
        adj.get(n.id)!.push([l.to, l.polarity === "-" ? -1 : 1]);
      }
    }
    return adj;
  }

  /**
   * All simple directed cycles, R/B classified, deduped by the legacy node
   * set. When distinct directed routes collapse to that compatibility key, the
   * retained CLD loop is marked ambiguous so SFD resolution can fail closed.
   */
  detectLoops(): DetectedLoop[] {
    const adj = this.directAdjacency();
    const found: DetectedLoop[] = [];
    const ids = [...this.nodes.keys()].sort(strcmp);

    for (const start of ids) {
      const stack: string[] = [start];
      const onPath = new Set<string>([start]);

      const dfs = (u: string, prod: number): void => {
        for (const [v, pol] of adj.get(u) ?? []) {
          if (v === start) {
            found.push(
              new DetectedLoop(
                [...stack],
                prod * pol === 1 ? LoopType.reinforcing : LoopType.balancing,
              ),
            );
            continue;
          }
          if (v < start) continue; // start stays the minimum id
          if (onPath.has(v)) continue; // simple cycles only
          stack.push(v);
          onPath.add(v);
          dfs(v, prod * pol);
          stack.pop();
          onPath.delete(v);
        }
      };

      dfs(start, 1);
    }

    const byCompatibilityKey = new Map<string, DetectedLoop>();
    for (const l of found) {
      if (l.nodeIds.length < 2) continue;
      if (new Set(l.nodeIds).size !== l.nodeIds.length) continue;
      const retained = byCompatibilityKey.get(l.key);
      if (!retained) {
        byCompatibilityKey.set(l.key, l);
      } else if (retained.exactKey !== l.exactKey) {
        byCompatibilityKey.set(
          l.key,
          new DetectedLoop(
            retained.nodeIds,
            retained.type,
            retained.canvasPath,
            retained.identityMode,
            true,
          ),
        );
      }
    }
    return [...byCompatibilityKey.values()];
  }

  /**
   * The Shortest Independent Loop Set (SILS): the minimum-weight basis of the
   * cycle space, found by a greedy GF(2) XOR-basis pass over cycles sorted by
   * length (ties broken on `key`). Covers every loop edge with a minimal,
   * independent set.
   */
  shortestIndependentLoopSet(): DetectedLoop[] {
    const loops = this.detectLoops();
    if (loops.length <= 1) return loops;

    const edgeIndex = new Map<string, number>();
    const edgeBits = (l: DetectedLoop): bigint => {
      const ids = l.nodeIds;
      let bits = 0n;
      for (let i = 0; i < ids.length; i++) {
        const edge = `${ids[i]}>${ids[(i + 1) % ids.length]}`;
        let idx = edgeIndex.get(edge);
        if (idx === undefined) {
          idx = edgeIndex.size;
          edgeIndex.set(edge, idx);
        }
        bits |= 1n << BigInt(idx);
      }
      return bits;
    };

    const order = loops
      .map((_, i) => i)
      .sort((a, b) => {
        const c = loops[a].nodeIds.length - loops[b].nodeIds.length;
        return c !== 0 ? c : strcmp(loops[a].key, loops[b].key);
      });

    const basis = new Map<number, bigint>();
    const chosen: DetectedLoop[] = [];
    for (const i of order) {
      let v = edgeBits(loops[i]);
      while (v !== 0n) {
        const lead = v.toString(2).length - 1; // bitLength - 1
        const pivot = basis.get(lead);
        if (pivot === undefined) {
          basis.set(lead, v);
          chosen.push(loops[i]);
          break;
        }
        v ^= pivot;
      }
    }
    return chosen;
  }

  /** Degree (in/out over ALL links) + loop participation per variable. */
  metrics(): Map<string, VarMetrics> {
    const inD = new Map<string, number>();
    const outD = new Map<string, number>();
    const loopCount = new Map<string, number>();
    for (const id of this.nodes.keys()) {
      inD.set(id, 0);
      outD.set(id, 0);
      loopCount.set(id, 0);
    }
    for (const n of this.nodes.values()) {
      for (const l of n.links) {
        if (!this.nodes.has(l.to)) continue;
        outD.set(n.id, (outD.get(n.id) ?? 0) + 1);
        inD.set(l.to, (inD.get(l.to) ?? 0) + 1);
      }
    }
    for (const loop of this.detectLoops()) {
      for (const id of new Set(loop.nodeIds)) {
        loopCount.set(id, (loopCount.get(id) ?? 0) + 1);
      }
    }
    const out = new Map<string, VarMetrics>();
    for (const id of this.nodes.keys()) {
      out.set(id, {
        inDegree: inD.get(id)!,
        outDegree: outD.get(id)!,
        loopCount: loopCount.get(id)!,
      });
    }
    return out;
  }
}
