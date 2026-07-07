import { VariableFile, VaultLink } from "./types";

export const SOURCE_CLOUD = "~source";
export const SINK_CLOUD = "~sink";

export interface FlowSpec {
  from: string;
  to: string;
}

export interface SfdPosition {
  x: number;
  y: number;
}

export interface FlowTouch {
  stockId: string;
  sign: 1 | -1;
}

export function isCloud(end: string | null | undefined): boolean {
  return end === SOURCE_CLOUD || end === SINK_CLOUD;
}

function objectMap(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function cleanEndpoint(v: unknown): string {
  return String(v ?? "").trim();
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Explicit `extra.flow` topology on a flow note, or null when absent/malformed. */
export function flowOf(v: VariableFile): FlowSpec | null {
  const f = objectMap(v.extra["flow"]);
  if (!f) return null;
  const from = cleanEndpoint(f["from"]);
  const to = cleanEndpoint(f["to"]);
  return from.length > 0 && to.length > 0 ? { from, to } : null;
}

/** Optional SFD-view position from `extra.sfd`, distinct from CLD `x`/`y`. */
export function sfdPositionOf(v: VariableFile): SfdPosition | null {
  const s = objectMap(v.extra["sfd"]);
  if (!s) return null;
  const x = num(s["x"]);
  const y = num(s["y"]);
  return x !== undefined && y !== undefined ? { x, y } : null;
}

/** True when the model has any authored SFD coordinate. */
export function hasAuthoredSfd(nodes: VariableFile[]): boolean {
  return nodes.some((v) => {
    const s = objectMap(v.extra["sfd"]);
    return !!s && (num(s["x"]) !== undefined || num(s["y"]) !== undefined);
  });
}

export function extraWithFlow(extra: Record<string, unknown>, flow: FlowSpec): Record<string, unknown> {
  return { ...extra, flow: { from: flow.from, to: flow.to } };
}

export function extraWithoutFlow(extra: Record<string, unknown>): Record<string, unknown> {
  const next = { ...extra };
  delete next["flow"];
  return next;
}

export function extraWithSfdPosition(
  extra: Record<string, unknown>,
  x: number,
  y: number,
): Record<string, unknown> {
  return { ...extra, sfd: { x, y } };
}

/** The stock deltas this flow implies: +1 inflow, -1 outflow. */
export function flowTouches(flow: VariableFile, byId: Map<string, VariableFile>): FlowTouch[] {
  const out: FlowTouch[] = [];
  const spec = flowOf(flow);
  if (spec) {
    if (!isCloud(spec.from) && byId.get(spec.from)?.type === "stock") {
      out.push({ stockId: spec.from, sign: -1 });
    }
    if (!isCloud(spec.to) && byId.get(spec.to)?.type === "stock") {
      out.push({ stockId: spec.to, sign: 1 });
    }
    return out;
  }
  for (const l of flow.links) {
    const t = byId.get(l.to);
    if (t?.type !== "stock") continue;
    out.push({ stockId: l.to, sign: l.polarity === "-" ? -1 : 1 });
  }
  return out;
}

/**
 * Material endpoints, stored-block first, then legacy flow->stock inference.
 * Returns null when the flow cannot be represented as exactly one from/to pair.
 */
export function resolveFlowSpec(flow: VariableFile, byId: Map<string, VariableFile>): FlowSpec | null {
  const stored = flowOf(flow);
  if (stored) return stored;
  const touched = flowTouches(flow, byId);
  const inflows = touched.filter((t) => t.sign > 0).map((t) => t.stockId);
  const outflows = touched.filter((t) => t.sign < 0).map((t) => t.stockId);
  if (inflows.length === 1 && outflows.length === 1) {
    return { from: outflows[0], to: inflows[0] };
  }
  if (inflows.length === 1 && outflows.length === 0) {
    return { from: SOURCE_CLOUD, to: inflows[0] };
  }
  if (outflows.length === 1 && inflows.length === 0) {
    return { from: outflows[0], to: SINK_CLOUD };
  }
  return null;
}

export function validateFlowEndpoints(
  from: string,
  to: string,
  byId: Map<string, VariableFile>,
): { ok: true } | { ok: false; error: string } {
  const bad = (end: string, isFrom: boolean): string | null => {
    if (isCloud(end)) {
      if (isFrom && end !== SOURCE_CLOUD) return "From cloud must be ~source.";
      if (!isFrom && end !== SINK_CLOUD) return "To cloud must be ~sink.";
      return null;
    }
    const v = byId.get(end);
    if (!v) return `Endpoint not found: ${end}`;
    if (v.type !== "stock") return `Endpoint must be a stock: ${v.label || v.id}`;
    return null;
  };
  const fromErr = bad(from, true);
  if (fromErr) return { ok: false, error: fromErr };
  const toErr = bad(to, false);
  if (toErr) return { ok: false, error: toErr };
  if (from === to) return { ok: false, error: "Flow endpoints must differ." };
  if (isCloud(from) && isCloud(to)) {
    return { ok: false, error: "A flow must touch at least one stock." };
  }
  return { ok: true };
}

/**
 * In SFD mode, material flow->stock links are represented by pipes. Remaining
 * links, including auxiliaries feeding a flow's rate, stay information connectors.
 */
export function isMaterialLink(
  source: VariableFile,
  link: VaultLink,
  byId: Map<string, VariableFile>,
): boolean {
  if (source.type !== "flow") return false;
  const spec = flowOf(source);
  if (spec) return link.to === spec.from || link.to === spec.to;
  return byId.get(link.to)?.type === "stock";
}

/** Deterministic SFD fallback layout, ported from loopy core `sfd_layout.dart`. */
export function computeSfdLayout(
  vars: VariableFile[],
  byId: Map<string, VariableFile>,
): Map<string, SfdPosition> {
  const cmp = (a: VariableFile, b: VariableFile): number => {
    const byLabel = a.label.localeCompare(b.label);
    return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
  };
  const stocks = vars.filter((v) => v.type === "stock").sort(cmp);
  const flows = vars.filter((v) => v.type === "flow").sort(cmp);
  const auxes = vars.filter((v) => v.type === "auxiliary").sort(cmp);
  const stockIds = stocks.map((s) => s.id);
  const stockSet = new Set(stockIds);
  const cmpId = (x: string, y: string): number => {
    const a = byId.get(x);
    const b = byId.get(y);
    return a && b ? cmp(a, b) : x.localeCompare(y);
  };

  const out = new Map(stockIds.map((id) => [id, new Set<string>()]));
  const inn = new Map(stockIds.map((id) => [id, new Set<string>()]));
  for (const f of flows) {
    const spec = resolveFlowSpec(f, byId);
    if (!spec) continue;
    if (!stockSet.has(spec.from) || !stockSet.has(spec.to)) continue;
    if (spec.from === spec.to) continue;
    out.get(spec.from)?.add(spec.to);
    inn.get(spec.to)?.add(spec.from);
  }
  const sortedOut = new Map<string, string[]>();
  for (const id of stockIds) sortedOut.set(id, [...(out.get(id) ?? [])].sort(cmpId));

  const white = 0;
  const grey = 1;
  const black = 2;
  const color = new Map(stockIds.map((id) => [id, white]));
  const backEdges = new Set<string>();
  const edgeKey = (from: string, to: string): string => `${from}\u001f${to}`;
  const visit = (u: string): void => {
    color.set(u, grey);
    for (const v of sortedOut.get(u) ?? []) {
      const c = color.get(v) ?? white;
      if (c === grey) backEdges.add(edgeKey(u, v));
      else if (c === white) visit(v);
    }
    color.set(u, black);
  };
  for (const id of stockIds) if ((color.get(id) ?? white) === white) visit(id);

  const dagPreds = new Map<string, string[]>();
  for (const id of stockIds) {
    dagPreds.set(
      id,
      [...(inn.get(id) ?? [])].filter((p) => !backEdges.has(edgeKey(p, id))).sort(cmpId),
    );
  }

  const col = new Map<string, number>();
  const onStack = new Set<string>();
  const columnOf = (u: string): number => {
    const cached = col.get(u);
    if (cached !== undefined) return cached;
    if (onStack.has(u)) return 0;
    onStack.add(u);
    let c = 0;
    for (const p of dagPreds.get(u) ?? []) c = Math.max(c, columnOf(p) + 1);
    onStack.delete(u);
    col.set(u, c);
    return c;
  };
  for (const id of stockIds) columnOf(id);

  const maxCol = Math.max(0, ...col.values());
  const byColumn = new Map<number, string[]>();
  for (let c = 0; c <= maxCol; c++) byColumn.set(c, []);
  for (const id of stockIds) byColumn.get(col.get(id) ?? 0)?.push(id);
  const row = new Map<string, number>();
  for (let c = 0; c <= maxCol; c++) {
    const ids = (byColumn.get(c) ?? []).sort(cmpId);
    const used = new Set<number>();
    for (const id of ids) {
      const preds = dagPreds.get(id) ?? [];
      let r: number | undefined;
      if (preds.length === 1) {
        const pr = row.get(preds[0]);
        if (pr !== undefined && !used.has(pr)) r = pr;
      }
      if (r === undefined) {
        r = 0;
        while (used.has(r)) r++;
      }
      used.add(r);
      row.set(id, r);
    }
  }

  const result = new Map<string, SfdPosition>();
  for (const id of stockIds) {
    result.set(id, { x: (col.get(id) ?? 0) * 220, y: (row.get(id) ?? 0) * 130 });
  }

  for (const f of flows) {
    const spec = resolveFlowSpec(f, byId);
    let valve: SfdPosition | undefined;
    if (spec) {
      const fromPos = isCloud(spec.from) ? undefined : result.get(spec.from);
      const toPos = isCloud(spec.to) ? undefined : result.get(spec.to);
      if (fromPos && toPos) valve = { x: (fromPos.x + toPos.x) / 2, y: (fromPos.y + toPos.y) / 2 };
      else if (toPos) valve = { x: toPos.x - 80, y: toPos.y };
      else if (fromPos) valve = { x: fromPos.x + 80, y: fromPos.y };
    }
    if (!valve) {
      const touched = flowTouches(f, byId).map((t) => result.get(t.stockId)).filter((p): p is SfdPosition => !!p);
      valve = touched.length === 0
        ? { x: 0, y: 0 }
        : {
            x: touched.reduce((sum, p) => sum + p.x, 0) / touched.length,
            y: touched.reduce((sum, p) => sum + p.y, 0) / touched.length,
          };
    }
    result.set(f.id, valve);
  }

  const auxIds = new Set(auxes.map((v) => v.id));
  const incoming = new Map(auxes.map((v) => [v.id, new Set<string>()]));
  for (const v of vars) {
    if (auxIds.has(v.id)) continue;
    for (const l of v.links) incoming.get(l.to)?.add(v.id);
  }
  const minStockY = stockIds.length === 0
    ? 0
    : Math.min(...stockIds.map((id) => result.get(id)?.y ?? 0));
  const auxY = minStockY - 110;
  for (const v of auxes) {
    const anchors = new Set<string>();
    for (const l of v.links) {
      if (result.has(l.to) && !auxIds.has(l.to)) anchors.add(l.to);
    }
    for (const id of incoming.get(v.id) ?? []) anchors.add(id);
    const xs = [...anchors].sort(cmpId).map((id) => result.get(id)?.x).filter((x): x is number => x !== undefined);
    result.set(v.id, { x: xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length, y: auxY });
  }
  return result;
}

export function sfdPositionsFor(nodes: VariableFile[]): Map<string, SfdPosition> {
  return new Map(nodes.map((n) => [n.id, sfdPositionOf(n) ?? { x: n.x, y: n.y }]));
}
