import { describe, expect, it } from "vitest";
import {
  GraphView,
  SINK_CLOUD,
  SOURCE_CLOUD,
  SceneCache,
  VariableFile,
  VaultLink,
  buildNodeBoxes,
  buildSfdPipeGeoms,
  computeSfdLayout,
  emptyVariable,
  flowOf,
  isMaterialLink,
  resolveFlowSpec,
  sfdPositionOf,
  sfdPositionsFor,
} from "@neoloopy/cld-canvas";

const link = (to: string, polarity: "+" | "-" = "+"): VaultLink => ({
  to,
  polarity,
  delay: false,
  indirect: false,
  nonlinear: false,
});

function node(id: string, label: string, type: VariableFile["type"], extra: Record<string, unknown> = {}): VariableFile {
  return { ...emptyVariable(id, label), type, extra };
}

describe("SFD topology helpers", () => {
  it("reads explicit flow and sfd blocks from extra", () => {
    const f = node("births", "Births", "flow", {
      flow: { from: SOURCE_CLOUD, to: "pop" },
      sfd: { x: -80, y: 20 },
    });
    expect(flowOf(f)).toEqual({ from: SOURCE_CLOUD, to: "pop" });
    expect(sfdPositionOf(f)).toEqual({ x: -80, y: 20 });
  });

  it("infers legacy flow->stock topology when there is no explicit flow block", () => {
    const pop = node("pop", "Population", "stock");
    const births = { ...node("births", "Births", "flow"), links: [link("pop", "+")] };
    const deaths = { ...node("deaths", "Deaths", "flow"), links: [link("pop", "-")] };
    const byId = new Map([pop, births, deaths].map((n) => [n.id, n]));
    expect(resolveFlowSpec(births, byId)).toEqual({ from: SOURCE_CLOUD, to: "pop" });
    expect(resolveFlowSpec(deaths, byId)).toEqual({ from: "pop", to: SINK_CLOUD });
  });

  it("does not fall back to legacy links when an explicit flow block is malformed", () => {
    const pop = node("pop", "Population", "stock");
    const births = {
      ...node("births", "Births", "flow", { flow: { from: SOURCE_CLOUD } }),
      links: [link("pop", "+")],
    };
    const byId = new Map([pop, births].map((entry) => [entry.id, entry]));

    expect(resolveFlowSpec(births, byId)).toBeNull();
    expect(isMaterialLink(births, births.links[0], byId)).toBe(false);
    expect(buildSfdPipeGeoms([pop, births], buildNodeBoxes([pop, births]))).toEqual([]);
  });

  it.each([
    ["indirect", { ...link("pop", "+"), indirect: true }],
    ["unknown-sign", { ...link("pop", "+"), polarity: "?" as const }],
  ])("does not fabricate a legacy pipe from an %s stock connector", (_name, stockLink) => {
    const pop = node("pop", "Population", "stock");
    const births = { ...node("births", "Births", "flow"), links: [stockLink] };
    const byId = new Map([pop, births].map((entry) => [entry.id, entry]));

    expect(resolveFlowSpec(births, byId)).toBeNull();
    expect(isMaterialLink(births, stockLink, byId)).toBe(false);
  });

  it("keeps ambiguous legacy stock links visible instead of hiding them behind no pipe", () => {
    const first = node("first", "First", "stock");
    const second = node("second", "Second", "stock");
    const flow = {
      ...node("flow", "Flow", "flow"),
      links: [link("first", "+"), link("second", "+")],
    };
    const byId = new Map([first, second, flow].map((entry) => [entry.id, entry]));

    expect(resolveFlowSpec(flow, byId)).toBeNull();
    expect(flow.links.map((entry) => isMaterialLink(flow, entry, byId))).toEqual([false, false]);
  });

  it.each([
    ["unknown-sign", { ...link("second", "+"), polarity: "?" as const }],
    ["indirect", { ...link("second", "+"), indirect: true }],
  ])("rejects all legacy material inference when an extra stock candidate is %s", (_name, badLink) => {
    const first = node("first", "First", "stock");
    const second = node("second", "Second", "stock");
    const flow = {
      ...node("flow", "Flow", "flow"),
      links: [link("first", "+"), badLink],
    };
    const nodes = [first, second, flow];
    const byId = new Map(nodes.map((entry) => [entry.id, entry]));

    expect(resolveFlowSpec(flow, byId)).toBeNull();
    expect(buildSfdPipeGeoms(nodes, buildNodeBoxes(nodes))).toEqual([]);
    expect(flow.links.map((entry) => isMaterialLink(flow, entry, byId))).toEqual([false, false]);
    const scene = new SceneCache().build({
      nodes,
      loops: [],
      labels: new Map(),
    } as unknown as GraphView, new Map(), new Map(), "sfd")!;
    expect(scene.edges.map((edge) => edge.id)).toEqual(["flow__first", "flow__second"]);
  });

  it.each([
    ["missing endpoint", { from: SOURCE_CLOUD, to: "ghost" }],
    ["same stock", { from: "pop", to: "pop" }],
    ["wrong source cloud", { from: SINK_CLOUD, to: "pop" }],
    ["cloud to cloud", { from: SOURCE_CLOUD, to: SINK_CLOUD }],
  ])("rejects a complete but invalid explicit flow: %s", (_name, spec) => {
    const pop = node("pop", "Population", "stock");
    const flow = {
      ...node("flow", "Flow", "flow", { flow: spec }),
      links: [link("pop", "+")],
    };
    const nodes = [pop, flow];
    const byId = new Map(nodes.map((entry) => [entry.id, entry]));

    expect(resolveFlowSpec(flow, byId)).toBeNull();
    expect(buildSfdPipeGeoms(nodes, buildNodeBoxes(nodes))).toEqual([]);
    expect(isMaterialLink(flow, flow.links[0], byId)).toBe(false);
  });

  it("computes a deterministic stock-flow fallback layout", () => {
    const a = node("a", "A", "stock");
    const b = node("b", "B", "stock");
    const f = node("f", "Transfer", "flow", { flow: { from: "a", to: "b" } });
    const byId = new Map([a, b, f].map((n) => [n.id, n]));
    const layout = computeSfdLayout([b, f, a], byId);
    expect(layout.get("a")).toEqual({ x: 0, y: 0 });
    expect(layout.get("b")).toEqual({ x: 220, y: 0 });
    expect(layout.get("f")).toEqual({ x: 110, y: 0 });
  });

  it("uses authored SFD positions without moving unpinned nodes off their CLD positions", () => {
    const stock = { ...node("s", "Stock", "stock"), x: 120, y: 80 };
    const flow = {
      ...node("f", "Flow", "flow", { sfd: { x: 180, y: 95 } }),
      x: 160,
      y: 80,
    };
    const aux = { ...node("a", "Aux", "auxiliary"), x: 210, y: -40 };
    const pos = sfdPositionsFor([stock, flow, aux]);
    expect(pos.get("s")).toEqual({ x: 120, y: 80 });
    expect(pos.get("f")).toEqual({ x: 180, y: 95 });
    expect(pos.get("a")).toEqual({ x: 210, y: -40 });
  });

  it("filters material links from SFD information connectors", () => {
    const stock = node("s", "Stock", "stock");
    const aux = node("a", "Aux", "auxiliary");
    const flow = {
      ...node("f", "Flow", "flow", { flow: { from: SOURCE_CLOUD, to: "s" } }),
      links: [link("s"), link("a")],
    };
    const byId = new Map([stock, aux, flow].map((n) => [n.id, n]));
    expect(isMaterialLink(flow, flow.links[0], byId)).toBe(true);
    expect(isMaterialLink(flow, flow.links[1], byId)).toBe(false);
  });
});

describe("SFD render data", () => {
  it("builds pipe geometry and keeps rate information links as edges", () => {
    const stock = { ...node("s", "Stock", "stock"), x: 0, y: 0 };
    const aux = { ...node("a", "Aux", "auxiliary"), x: 50, y: -100 };
    const flow = {
      ...node("f", "Flow", "flow", { flow: { from: SOURCE_CLOUD, to: "s" } }),
      x: -80,
      y: 0,
      links: [link("s"), link("a")],
    };
    const boxes = buildNodeBoxes([stock, aux, flow]);
    const pipes = buildSfdPipeGeoms([stock, aux, flow], boxes);
    expect(pipes).toHaveLength(1);
    expect(pipes[0].fromCloud).not.toBeNull();
    expect(pipes[0].to).toBe("s");

    const graph = {
      nodes: [stock, aux, flow],
      loops: [],
      labels: new Map(),
    } as unknown as GraphView;
    const scene = new SceneCache((s) => s.length * 10).build(graph, new Map(), new Map(), "sfd");
    expect(scene?.mode).toBe("sfd");
    expect(scene?.boxes.get("s")).toMatchObject({ cx: 0, cy: 0 });
    expect(scene?.boxes.get("a")).toMatchObject({ cx: 50, cy: -100 });
    expect(scene?.boxes.get("f")).toMatchObject({ cx: -80, cy: 0 });
    expect(scene?.pipes).toHaveLength(1);
    expect(scene?.edges.map((e) => `${e.source}->${e.target}`)).toEqual(["f->a"]);
  });
});
