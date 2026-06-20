import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  MemoryStorage,
  NativeEngine,
  baseName,
  joinPath,
  parseLoopNote,
} from "@neoloopy/cld-canvas";
import type { VaultStorage } from "@neoloopy/cld-canvas";

const yaml = (s: string): unknown => parseYaml(s);

function makeEngine(modelsRoot = "models") {
  const storage = new MemoryStorage();
  const engine = new NativeEngine(storage, yaml, { modelsRoot });
  return { storage, engine };
}

/** Build a tiny 2-node model {A,B} with a reinforcing A→B→A loop. */
async function buildAB(engine: NativeEngine, name = "M"): Promise<string> {
  const { folder } = await engine.createModel(name);
  await engine.buildModel(folder, {
    variables: [{ label: "A" }, { label: "B" }],
    links: [
      { from: "A", to: "B", polarity: "+" },
      { from: "B", to: "A", polarity: "+" },
    ],
  });
  return folder;
}

/** Byte-for-byte copy of a model folder (simulates Obsidian's native copy,
 *  which clones ids verbatim). */
async function rawCopyTree(
  storage: VaultStorage,
  src: string,
  dst: string,
): Promise<void> {
  await storage.mkdirs(dst);
  const listing = await storage.list(src);
  for (const f of listing.files) {
    await storage.write(joinPath(dst, baseName(f)), await storage.read(f));
  }
  for (const sub of listing.folders) {
    await rawCopyTree(storage, sub, joinPath(dst, baseName(sub)));
  }
}

/** Member ids recorded in the model's single Loops/*.md file. */
async function loopMembers(
  storage: VaultStorage,
  folder: string,
): Promise<string[]> {
  const files = (await storage.list(joinPath(folder, "Loops"))).files.filter((f) =>
    f.endsWith(".md"),
  );
  expect(files.length).toBe(1);
  return parseLoopNote(await storage.read(files[0]), yaml).members;
}

describe("duplicateModel", () => {
  it("creates a fresh-keyed, internally-consistent copy", async () => {
    const { storage, engine } = makeEngine();
    const src = await buildAB(engine);
    const srcId = await engine.modelId(src);
    // Annotate the loop so the copy exercises loop-note member remapping.
    await engine.setLoopNote(src, "R:A|B", "the engine of growth");

    const copy = await engine.duplicateModel(src);
    expect(copy.name).toBe("M (copy)");
    expect(copy.id).not.toBe(srcId);
    expect(copy.folder).not.toBe(src);

    const srcGraph = await engine.loadGraph(src);
    const copyGraph = await engine.loadGraph(copy.folder);
    expect(copyGraph.nodes.length).toBe(srcGraph.nodes.length);

    // every copied variable id is brand new
    const srcVarIds = new Set(srcGraph.nodes.map((n) => n.id));
    for (const n of copyGraph.nodes) expect(srcVarIds.has(n.id)).toBe(false);

    // link targets resolve within the copy
    const copyVarIds = new Set(copyGraph.nodes.map((n) => n.id));
    for (const n of copyGraph.nodes) {
      for (const l of n.links) expect(copyVarIds.has(l.to)).toBe(true);
    }

    // the loop note's members were re-pointed to the copy's fresh ids
    const copyMembers = await loopMembers(storage, copy.folder);
    expect(copyMembers.length).toBe(2);
    for (const m of copyMembers) {
      expect(copyVarIds.has(m)).toBe(true);
      expect(srcVarIds.has(m)).toBe(false);
    }
    // the copy's loop note still carries its body
    expect((await engine.getLoopNotes(copy.folder))["R:A|B"]).toBe(
      "the engine of growth",
    );

    // the source is untouched
    const srcAfter = await engine.loadGraph(src);
    expect(new Set(srcAfter.nodes.map((n) => n.id))).toEqual(srcVarIds);
    expect(await engine.modelId(src)).toBe(srcId);
  });

  it("bumps the title on a name clash", async () => {
    const { engine } = makeEngine();
    const src = await buildAB(engine);
    const first = await engine.duplicateModel(src);
    expect(first.name).toBe("M (copy)");
    const second = await engine.duplicateModel(src);
    expect(second.name).toBe("M (copy 2)");
    expect(second.folder).not.toBe(first.folder);
  });
});

describe("healDuplicateIds", () => {
  it("re-keys a raw-copied model so ids are unique again", async () => {
    const { storage, engine } = makeEngine();
    const src = await buildAB(engine);
    await rawCopyTree(storage, src, "models/m-rawcopy");

    // collision exists before healing
    let ids = (await engine.listModels()).map((m) => m.id);
    expect(new Set(ids).size).toBeLessThan(ids.length);

    const healed = await engine.healDuplicateIds();
    expect(healed.length).toBe(1);

    // ids are unique afterwards
    ids = (await engine.listModels()).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    // the re-keyed copy still has its structure
    const copy = await engine.loadGraph("models/m-rawcopy");
    expect(copy.nodes.length).toBe(2);
    const copyVarIds = new Set(copy.nodes.map((n) => n.id));
    for (const n of copy.nodes) {
      for (const l of n.links) expect(copyVarIds.has(l.to)).toBe(true);
    }
  });

  it("heals every model of a raw-copied folder (folder copy)", async () => {
    const { storage, engine } = makeEngine();
    const a = await buildAB(engine, "Alpha");
    const b = await buildAB(engine, "Beta");
    // simulate copying a folder that held both models
    await rawCopyTree(storage, a, "copy/alpha");
    await rawCopyTree(storage, b, "copy/beta");

    const healed = await engine.healDuplicateIds();
    expect(healed.length).toBe(2);

    const ids = (await engine.listModels()).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is a no-op when there are no collisions", async () => {
    const { engine } = makeEngine();
    await buildAB(engine, "One");
    await buildAB(engine, "Two");
    const healed = await engine.healDuplicateIds();
    expect(healed.length).toBe(0);
  });
});
