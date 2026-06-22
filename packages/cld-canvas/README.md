# @neoloopy/cld-canvas

Framework-agnostic causal loop diagram (CLD) canvas renderer and in-memory edit
engine used by neoloopy surfaces, including the Obsidian plugin and web app.

The package is pure TypeScript, ESM-only, and has no runtime dependency on
Obsidian, React, Vue, or a server. It gives you two pieces:

- A vault-compatible CLD engine for creating, editing, loading, exporting, and
  analyzing neoloopy models.
- A canvas rendering layer for drawing nodes, causal links, polarity chips,
  loop badges, selection state, and pan/zoom views.

## Install

```sh
npm install @neoloopy/cld-canvas
```

If you use `NativeEngine`, provide a YAML parser for note frontmatter. The
package does not bundle one:

```sh
npm install yaml
```

## Requirements

- TypeScript or JavaScript with ESM imports
- `ES2020` runtime support
- A `CanvasRenderingContext2D` if you use the painter

## Quick Start

```ts
import { parse } from "yaml";
import {
  MemoryStorage,
  NativeEngine,
} from "@neoloopy/cld-canvas";

const storage = new MemoryStorage();
const engine = new NativeEngine(storage, parse, {
  modelsRoot: "Models",
});

const model = await engine.createModel("Growth Loop");

await engine.buildModel(model.folder, {
  variables: [
    { label: "Users" },
    { label: "Word of mouth" },
    { label: "Signups" },
  ],
  links: [
    { from: "Users", to: "Word of mouth", polarity: "+" },
    { from: "Word of mouth", to: "Signups", polarity: "+" },
    { from: "Signups", to: "Users", polarity: "+" },
  ],
});

const graph = await engine.loadGraph(model.folder);

console.log(graph.nodes.map((node) => node.label));
console.log(graph.loops.length);
```

## Rendering to Canvas

The renderer is intentionally UI-framework neutral. Build a renderable scene
from a `GraphView`, configure a `Camera`, then call `paint`.

```ts
import {
  Camera,
  LIGHT,
  SceneCache,
  paint,
} from "@neoloopy/cld-canvas";

const canvas = document.querySelector("canvas")!;
const ctx = canvas.getContext("2d")!;
const dpr = window.devicePixelRatio || 1;

const width = canvas.clientWidth;
const height = canvas.clientHeight;
canvas.width = Math.floor(width * dpr);
canvas.height = Math.floor(height * dpr);

const camera = new Camera();
const sceneCache = new SceneCache();
const scene = sceneCache.build(graph, new Map(), new Map());

if (scene) {
  sceneCache.fit(camera, width, height);

  paint(ctx, scene, camera, LIGHT, {
    cssWidth: width,
    cssHeight: height,
    dpr,
    selectedNodeId: null,
    selectedEdgeId: null,
    selectedLoopKey: null,
    liveNodeIds: new Set(),
    linkPreview: null,
    connectNodeId: null,
    loopHighlight: null,
    pulsePhase: 0,
    flowPhase: 0,
  });
}
```

Use `Camera.panBy`, `Camera.zoomAt`, `Camera.setScaleAt`, and
`Camera.centerOn` to wire your own pointer, wheel, trackpad, minimap, or toolbar
controls.

## Using It in React (or any framework)

There is no framework-specific component — `paint` only needs a `<canvas>` 2D
context, so a thin wrapper is all it takes. A minimal React component that turns
a spec into a rendered diagram:

```tsx
import { useEffect, useRef } from "react";
import { parse } from "yaml";
import {
  MemoryStorage,
  NativeEngine,
  Camera,
  SceneCache,
  paint,
  LIGHT,
} from "@neoloopy/cld-canvas";
import type { BuildSpec } from "@neoloopy/cld-canvas";

export function CldCanvas({ spec }: { spec: BuildSpec }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const engine = new NativeEngine(new MemoryStorage(), parse, {
        modelsRoot: "Models",
      });
      const model = await engine.createModel("model");
      await engine.buildModel(model.folder, spec);
      const graph = await engine.loadGraph(model.folder);

      const canvas = ref.current;
      const ctx = canvas?.getContext("2d");
      if (!alive || !canvas || !ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);

      const camera = new Camera();
      const sceneCache = new SceneCache();
      const scene = sceneCache.build(graph, new Map(), new Map());
      if (!scene) return;
      sceneCache.fit(camera, w, h);

      paint(ctx, scene, camera, LIGHT, {
        cssWidth: w,
        cssHeight: h,
        dpr,
        selectedNodeId: null,
        selectedEdgeId: null,
        selectedLoopKey: null,
        liveNodeIds: new Set(),
        linkPreview: null,
        connectNodeId: null,
        loopHighlight: null,
        pulsePhase: 0,
        flowPhase: 0,
      });
    })();
    return () => {
      alive = false;
    };
  }, [spec]);

  return <canvas ref={ref} style={{ width: "100%", height: 400 }} />;
}
```

To make it interactive, keep one `Camera` and one `SceneCache` across renders,
wire `Camera.panBy` / `Camera.zoomAt` to pointer and wheel events, and repaint.
The same wrapper shape works in Vue, Svelte, or plain DOM — only the lifecycle
hook changes.

## Engine Concepts

### Storage

`NativeEngine` works against a small filesystem-like `VaultStorage` interface:

```ts
interface VaultStorage {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdirs(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}
```

Use `MemoryStorage` for tests, demos, and server-side transforms. In production,
adapt this interface to your host filesystem, browser persistence layer.

All paths are vault-relative and use `/` separators.

### Model Format

A model is stored as:

- `model.json` for model metadata and viewport
- `Nodes/*.md` for variable notes with YAML frontmatter and Markdown body
- `Loops/*.md` for feedback loop notes
- optional system notes such as `System.md`

The engine preserves unknown frontmatter keys so other neoloopy tools can add
metadata without being clobbered.

### Main Engine Methods

```ts
const model = await engine.createModel("Model name");
const models = await engine.listModels();
const graph = await engine.loadGraph(model.folder);

const node = await engine.addVariable(model.folder, {
  label: "Inventory",
  type: "stock",
  x: 120,
  y: 80,
});

await engine.updateVariable(model.folder, node.id, {
  label: "Available inventory",
  tags: ["operations"],
});

await engine.addLink(model.folder, node.id, "other-node-id", {
  polarity: "-",
  delay: true,
});

await engine.relayout(model.folder);
await engine.setViewport(model.folder, { x: 0, y: 0, zoom: 1 });
```

Bulk build is useful when importing generated or external CLD specs:

```ts
await engine.buildModel(model.folder, {
  variables: [
    { id: "demand", label: "Demand" },
    { id: "capacity", label: "Capacity", type: "stock" },
  ],
  links: [
    { from: "demand", to: "capacity", polarity: "+" },
    { from: "capacity", to: "demand", polarity: "-" },
  ],
  layout: true,
});
```

## Exporting

`NativeEngine.export` supports `json`, `mermaid`, and `markdown`.

```ts
const mermaid = await engine.export(model.folder, "mermaid");

console.log(mermaid.ext);     // "mmd"
console.log(mermaid.mime);    // "text/plain"
console.log(mermaid.content); // graph LR...
```

You can also use the lower-level renderer functions directly:

```ts
import { buildMermaid, render } from "@neoloopy/cld-canvas";
```

## Analysis Helpers

```ts
import { LoopGraph, endogeneity } from "@neoloopy/cld-canvas";

const loopGraph = new LoopGraph(graph.nodes);
const loops = loopGraph.detectLoops();
const metrics = loopGraph.metrics();
const summary = endogeneity(graph.nodes, loops);
```

## What Is Exported

The package exports the public modules from `src/index.ts`, including:

- Engine: `NativeEngine`, `NeoloopyEngine`, `MemoryStorage`, `VaultStorage`
- Domain types: `VariableFile`, `VaultLink`, `ModelManifest`, `GraphView`
- Graph logic: `LoopGraph`, `DetectedLoop`, `LoopType`, `labelLoopsByKey`
- Rendering: `paint`, `SceneCache`, `Camera`, `LIGHT`, `DARK`, geometry helpers
- File codecs: `parseNote`, `serializeNote`, `manifestFromJson`
- Exporters: `render`, `buildMermaid`, `loopNoteKey`
- Analysis: `endogeneity`

## Notes for Integrators

- The package is ESM-only. Use `import`, not `require`.
- The engine is asynchronous because real storage adapters usually perform I/O.
- `move` should preserve or update links when your host platform supports it.
  The Obsidian adapter, for example, should route folder moves through Obsidian's
  file manager so wikilinks remain valid.
- Canvas rendering is stateless. Keep selection, hover, animation clocks, bow
  caches, and badge overrides in your application state and pass them to
  `SceneCache` or `paint`.
- `MemoryStorage` is not persistent; it is intended for tests and examples.

## License

MIT
