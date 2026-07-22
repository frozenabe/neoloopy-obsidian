import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Camera,
  DiagramViewMode,
  GraphView,
  SINK_CLOUD,
  Scene,
  SceneCache,
  VariableFile,
  emptyVariable,
  extraWithSfdPosition,
  hitNode,
} from "@neoloopy/cld-canvas";
import { KeyboardController } from "../src/view/keyboardController";
import { PointerInteraction } from "../src/view/pointerInteraction";
import { SelectionChrome } from "../src/view/selectionChrome";

class TestStyle {
  private readonly values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
  }
}

class TestElement {
  readonly children: TestElement[] = [];
  readonly style = new TestStyle();
  readonly dataset: Record<string, string> = {};
  readonly classes = new Set<string>();
  value = "";

  createDiv(opts?: { cls?: string; text?: string }): TestElement {
    return this.child(opts);
  }

  createSpan(opts?: { cls?: string; text?: string }): TestElement {
    return this.child(opts);
  }

  createEl(
    _tag: string,
    opts?: { cls?: string; text?: string; value?: string },
  ): TestElement {
    const child = this.child(opts);
    if (opts?.value !== undefined) child.value = opts.value;
    return child;
  }

  createSvg(_tag: string, opts?: { cls?: string }): TestElement {
    return this.child(opts);
  }

  private child(opts?: { cls?: string }): TestElement {
    const child = new TestElement();
    for (const name of opts?.cls?.split(/\s+/).filter(Boolean) ?? []) {
      child.classes.add(name);
    }
    this.children.push(child);
    return child;
  }

  toggleClass(name: string, enabled: boolean): void {
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
  }

  hasClass(name: string): boolean {
    return this.classes.has(name);
  }

  setAttribute(): void {}
  empty(): void {
    this.children.length = 0;
  }
}

type TestListener = (event: Event) => void;

class TestCanvas extends TestElement {
  private readonly listeners = new Map<string, TestListener[]>();
  private readonly captures = new Set<number>();
  clientWidth = 900;
  clientHeight = 700;

  listen(type: string, cb: TestListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(cb);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: Record<string, unknown>): void {
    for (const cb of this.listeners.get(type) ?? [])
      cb(event as unknown as Event);
  }

  getBoundingClientRect(): DOMRect {
    return {
      left: 0,
      top: 0,
      right: this.clientWidth,
      bottom: this.clientHeight,
      width: this.clientWidth,
      height: this.clientHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }

  focus(): void {}
  setPointerCapture(id: number): void {
    this.captures.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.captures.has(id);
  }
  releasePointerCapture(id: number): void {
    this.captures.delete(id);
  }
}

function variable(
  id: string,
  label: string,
  type: VariableFile["type"],
  x: number,
  y: number,
  sfdX: number,
  sfdY: number,
  extra: Record<string, unknown> = {},
): VariableFile {
  const node = { ...emptyVariable(id, label), type, x, y, extra };
  node.extra = { ...extraWithSfdPosition(node.extra, sfdX, sfdY), ...extra };
  return node;
}

function graph(): GraphView {
  const stock = variable("stock", "Reservoir", "stock", 10, 20, 120, 140);
  const drain = variable("drain", "Extraction", "flow", 40, 50, 320, 140, {
    flow: { from: "stock", to: SINK_CLOUD },
  });
  return {
    folder: "models/reservoir",
    manifest: {
      id: "mdl_reservoir",
      name: "Reservoir",
      schemaVersion: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      created: "",
      modified: "",
      order: 0,
      extra: {},
    },
    nodes: [stock, drain],
    loops: [],
    labels: new Map(),
    quant: true,
  };
}

function pointerEvent(x: number, y: number): Record<string, unknown> {
  return {
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: "mouse",
    timeStamp: 1,
    preventDefault: () => {},
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CRITICAL SFD node movement keeps canvas geometry and chrome coherent", () => {
  it("drags the active SFD coordinate, refreshes hit/pipe geometry, and reanchors chrome without touching CLD", async () => {
    const current = graph();
    const cache = new SceneCache((label) => label.length * 8);
    const bows = new Map<string, number>();
    let scene = cache.build(current, bows, new Map(), "sfd") as Scene;
    const initialScene = scene;
    const initialPipePoint = scene.pipes[0].fromPoint;
    const camera = new Camera();
    camera.scale = 1;
    camera.tx = 0;
    camera.ty = 0;
    const selection = {
      node: "stock" as string | null,
      edge: null,
      loop: null,
    };
    const canvas = new TestCanvas();
    const persisted: Array<{ id: string; x: number; y: number }> = [];
    let pointer!: PointerInteraction;
    const wrapper = new TestElement();
    const chrome = new SelectionChrome(wrapper as unknown as HTMLElement, {
      camera,
      scene: () => scene,
      graph: () => current,
      diagramMode: () => "sfd",
      selection: () => selection,
      isIdle: () => pointer.isIdle(),
      selectedEdgeGeom: () => null,
      loopHasNote: () => false,
      listen: () => {},
      setNodeType: () => {},
      setFlowEndpoints: () => {},
      setNodeGroup: () => {},
      openSubsystemMenu: () => {},
      openEquationModal: () => {},
      patchLink: () => {},
      deleteSelection: () => {},
      openLoopNote: () => {},
    });

    const rebuild = (): void => {
      scene = cache.build(current, bows, new Map(), "sfd") as Scene;
    };
    const render = (): void => chrome.update();
    pointer = new PointerInteraction(canvas as unknown as HTMLCanvasElement, {
      camera,
      scene: () => scene,
      graph: () => current,
      selection: () => selection,
      hasFolder: () => true,
      loopBadgeOverrides: () => new Map(),
      listen: (el, type, cb) => {
        if (el === (canvas as unknown as HTMLElement)) canvas.listen(type, cb);
      },
      select: (node, edge, loop) =>
        Object.assign(selection, { node, edge, loop }),
      render,
      rebuildScene: rebuild,
      persistViewport: () => {},
      commitRename: () => {},
      cancelArmedLink: () => {},
      startRename: () => {},
      previewNodePosition: (id, x, y) => {
        const node = current.nodes.find((candidate) => candidate.id === id)!;
        node.extra = extraWithSfdPosition(node.extra, x, y);
      },
      renderPosition: (id) => {
        const box = scene.boxes.get(id);
        return box ? { x: box.cx, y: box.cy } : null;
      },
      persistNodePosition: async (id, x, y) => {
        persisted.push({ id, x, y });
      },
      createConnection: async () => null,
      commitBow: async () => {},
      createNodeAt: async () => {},
    });

    render();
    const toggle = chrome.nodeMenuToggle as unknown as TestElement;
    expect(toggle.hasClass("is-visible")).toBe(true);
    expect(toggle.style.getPropertyValue("--nl-x")).toBe("120px");

    canvas.emit("pointerdown", pointerEvent(120, 140));
    expect(pointer.isIdle()).toBe(false);
    expect(toggle.hasClass("is-visible")).toBe(false);

    canvas.emit("pointermove", pointerEvent(240, 210));
    expect(scene).not.toBe(initialScene);
    expect(scene.boxes.get("stock")).toMatchObject({ cx: 240, cy: 210 });
    expect(hitNode(scene.boxes, { x: 240, y: 210 })).toBe("stock");
    expect(hitNode(scene.boxes, { x: 120, y: 140 })).toBeNull();
    expect(scene.pipes[0].fromPoint).not.toEqual(initialPipePoint);
    expect(current.nodes[0]).toMatchObject({ x: 10, y: 20 });
    expect(current.nodes[0].extra["sfd"]).toEqual({ x: 240, y: 210 });

    canvas.emit("pointerup", pointerEvent(240, 210));
    await Promise.resolve();
    await Promise.resolve();

    expect(persisted).toEqual([{ id: "stock", x: 240, y: 210 }]);
    expect(pointer.isIdle()).toBe(true);
    expect(toggle.hasClass("is-visible")).toBe(true);
    expect(toggle.style.getPropertyValue("--nl-x")).toBe("240px");
    expect(toggle.style.getPropertyValue("--nl-y")).toBe("238px");
  });

  it("keeps rapid SFD and CLD keyboard nudges in their own coordinate spaces", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    const current = graph();
    const cache = new SceneCache((label) => label.length * 8);
    const bows = new Map<string, number>();
    let mode: DiagramViewMode = "sfd";
    let scene = cache.build(current, bows, new Map(), mode) as Scene;
    const camera = new Camera();
    camera.scale = 1;
    camera.tx = 0;
    camera.ty = 0;
    const selection = {
      node: "stock" as string | null,
      edge: null,
      loop: null,
    };
    const canvas = new TestCanvas();
    let persistenceScope = current.folder;
    const persisted: Array<{
      x: number;
      y: number;
      space: DiagramViewMode;
      scope: string | null | undefined;
    }> = [];
    const keyboard = new KeyboardController(
      canvas as unknown as HTMLCanvasElement,
      {
        app: {} as never,
        camera,
        scene: () => scene,
        graph: () => current,
        selection: () => selection,
        hasFolder: () => true,
        positionPersistenceScope: () => persistenceScope,
        isRenaming: () => false,
        listen: (el, type, cb) => {
          if (el === (canvas as unknown as HTMLElement))
            canvas.listen(type, cb);
        },
        select: () => {},
        render: () => {},
        rebuildScene: () => {
          scene = cache.build(current, bows, new Map(), mode) as Scene;
        },
        persistViewport: () => {},
        startRename: () => {},
        toggleEdgeMenu: () => {},
        openExportMenuAt: () => {},
        openLoopNote: async () => {},
        tidy: async () => {},
        fitToContent: () => {},
        createNodeAt: async () => {},
        createConnection: async () => null,
        previewNodePosition: (id, x, y) => {
          const node = current.nodes.find((candidate) => candidate.id === id)!;
          if (mode === "sfd")
            node.extra = extraWithSfdPosition(node.extra, x, y);
          else Object.assign(node, { x, y });
        },
        persistNodePosition: async (_id, x, y, space, scope) => {
          persisted.push({ x, y, space: space ?? mode, scope });
        },
        deleteSelection: async () => {},
      },
    );

    canvas.emit("keydown", {
      key: "ArrowRight",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault: () => {},
    });
    expect(current.nodes[0]).toMatchObject({ x: 10, y: 20 });
    expect(current.nodes[0].extra["sfd"]).toEqual({ x: 128, y: 140 });

    mode = "cld";
    scene = cache.build(current, bows, new Map(), mode) as Scene;
    canvas.emit("keydown", {
      key: "ArrowDown",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault: () => {},
    });
    expect(current.nodes[0]).toMatchObject({ x: 10, y: 28 });
    expect(current.nodes[0].extra["sfd"]).toEqual({ x: 128, y: 140 });
    await vi.advanceTimersByTimeAsync(450);

    expect(persisted).toEqual([
      { x: 128, y: 140, space: "sfd", scope: "models/reservoir" },
      { x: 10, y: 28, space: "cld", scope: "models/reservoir" },
    ]);

    persisted.length = 0;
    mode = "sfd";
    scene = cache.build(current, bows, new Map(), mode) as Scene;
    canvas.emit("keydown", {
      key: "ArrowRight",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault: () => {},
    });
    persistenceScope = "models/other";
    keyboard.reset();
    expect(persisted).toEqual([
      { x: 136, y: 140, space: "sfd", scope: "models/reservoir" },
    ]);
  });
});
