import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { NativeEngine } from "../src/engine/nativeEngine";
import { MemoryStorage, baseName, joinPath } from "../src/engine/storage";
import { LoopType } from "../src/engine/types";
import { parseLoopNote } from "../src/engine/loopNote";
import { parseNote, serializeNote } from "../src/engine/noteCodec";

const yaml = (s: string): unknown => parseYaml(s);

function makeEngine(modelsRoot = "models") {
  const storage = new MemoryStorage();
  const engine = new NativeEngine(storage, yaml, { modelsRoot });
  return { storage, engine };
}

/** A model with a reinforcing loop {A,B} (key R:A|B) and a balancing loop
 * {C,D} (key B:C|D), so loop notes can be anchored to a real detected loop. */
async function twoLoopModel(engine: NativeEngine): Promise<string> {
  const { folder } = await engine.createModel("M");
  await engine.buildModel(folder, {
    variables: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
    links: [
      { from: "A", to: "B", polarity: "+" },
      { from: "B", to: "A", polarity: "+" },
      { from: "C", to: "D", polarity: "+" },
      { from: "D", to: "C", polarity: "-" },
    ],
  });
  return folder;
}

async function loopFiles(storage: MemoryStorage, folder: string): Promise<string[]> {
  const { files } = await storage.list(`${folder}/Loops`);
  return files.map(baseName).sort();
}

describe("NativeEngine — model lifecycle", () => {
  it("creates, lists, and deletes a model", async () => {
    const { engine } = makeEngine();
    const ref = await engine.createModel("Population Dynamics");
    expect(ref.id).toMatch(/^mdl_/);
    expect(ref.folder).toBe("models/population-dynamics");

    const list = await engine.listModels();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Population Dynamics");
    expect(list[0].variableCount).toBe(0);

    await engine.deleteModel(ref.folder);
    expect(await engine.listModels()).toHaveLength(0);
  });

  it("suffixes the folder on name-slug collision", async () => {
    const { engine } = makeEngine();
    const a = await engine.createModel("Growth");
    const b = await engine.createModel("Growth");
    expect(a.folder).toBe("models/growth");
    expect(b.folder).toBe("models/growth-2");
  });

  it("renames a model's title and syncs the folder to the new slug", async () => {
    const { storage, engine } = makeEngine();
    const ref = await engine.createModel("Old Name");
    expect(ref.folder).toBe("models/old-name");

    const renamed = await engine.renameModel(ref.folder, "New Name");
    expect(renamed.name).toBe("New Name");
    expect(renamed.id).toBe(ref.id);
    expect(renamed.folder).toBe("models/new-name");

    // The old folder is gone; the manifest now lives at the new path.
    expect(await storage.exists("models/old-name")).toBe(false);
    expect(await storage.exists("models/new-name/model.json")).toBe(true);

    const list = await engine.listModels();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("New Name");
    expect(list[0].folder).toBe("models/new-name");
  });

  it("carries the model's notes to the renamed folder", async () => {
    const { storage, engine } = makeEngine();
    const { folder } = await engine.createModel("Has Notes");
    const v = await engine.addVariable(folder, { label: "Births" });

    const renamed = await engine.renameModel(folder, "Renamed");
    expect(await storage.exists(`models/renamed/Nodes/${v.id}.md`)).toBe(true);
    expect(await storage.exists("models/has-notes")).toBe(false);

    const view = await engine.loadGraph(renamed.folder);
    expect(view.nodes.map((n) => n.label)).toContain("Births");
  });

  it("suffixes the folder when the new title collides with a sibling", async () => {
    const { engine } = makeEngine();
    await engine.createModel("Alpha");
    const b = await engine.createModel("Beta");

    const renamed = await engine.renameModel(b.folder, "Alpha");
    expect(renamed.name).toBe("Alpha");
    expect(renamed.folder).toBe("models/alpha-2"); // "alpha" is taken
  });

  it("keeps the folder put when the slug is unchanged", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("My Model");
    const renamed = await engine.renameModel(folder, "My Model!!!"); // same slug
    expect(renamed.folder).toBe("models/my-model");
    expect(renamed.name).toBe("My Model!!!");
  });

  it("trims and rejects a blank new title", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("Keep Me");
    const renamed = await engine.renameModel(folder, "  Trimmed  ");
    expect(renamed.name).toBe("Trimmed");
    expect(renamed.folder).toBe("models/trimmed");
    await expect(engine.renameModel(renamed.folder, "   ")).rejects.toThrow();
  });

  it("retitles a model in place without moving its folder (folder → title sync)", async () => {
    const { storage, engine } = makeEngine();
    const { folder } = await engine.createModel("Original");
    expect(folder).toBe("models/original");

    // Mirrors an external folder rename: the directory is already where the user
    // put it, so only the title (model.json name) follows — no re-slug, no move.
    const ref = await engine.retitleModel(folder, "Renamed In Vault");
    expect(ref.name).toBe("Renamed In Vault");
    expect(ref.folder).toBe(folder); // folder stays put
    expect(await storage.exists("models/original/model.json")).toBe(true);
    expect(ref.modified >= (await engine.listModels())[0].modified).toBe(true);

    const list = await engine.listModels();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Renamed In Vault");
    expect(list[0].folder).toBe(folder);
  });

  it("trims and rejects a blank retitle", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("Keep");
    const ref = await engine.retitleModel(folder, "  Spaced  ");
    expect(ref.name).toBe("Spaced");
    await expect(engine.retitleModel(folder, "   ")).rejects.toThrow();
  });
});

describe("NativeEngine — variables and links", () => {
  it("adds variables with var_ ids and persists them as notes", async () => {
    const { storage, engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Births", type: "flow" });
    expect(v.id).toMatch(/^var_[0-9a-f]{8}$/);
    expect(await storage.exists(`${folder}/Nodes/${v.id}.md`)).toBe(true);

    const view = await engine.loadGraph(folder);
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0].label).toBe("Births");
    expect(view.nodes[0].type).toBe("flow");
  });

  it("detects a reinforcing loop after linking two variables both ways", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const a = await engine.addVariable(folder, { label: "Population" });
    const b = await engine.addVariable(folder, { label: "Births" });
    await engine.addLink(folder, a.id, b.id, { polarity: "+" });
    await engine.addLink(folder, b.id, a.id, { polarity: "+" });

    const view = await engine.loadGraph(folder);
    expect(view.loops).toHaveLength(1);
    expect(view.loops[0].type).toBe(LoopType.reinforcing);
    expect(view.labels.get(view.loops[0].key)).toBe("R1");
  });

  it("removing a variable also drops inbound links", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const a = await engine.addVariable(folder, { label: "A" });
    const b = await engine.addVariable(folder, { label: "B" });
    await engine.addLink(folder, a.id, b.id, { polarity: "+" });
    await engine.removeVariable(folder, b.id);

    const view = await engine.loadGraph(folder);
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0].links).toHaveLength(0);
  });

  it("moveVariable is cosmetic — preserves rev, updates position", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "A" });
    const before = (await engine.loadGraph(folder)).nodes[0];
    await engine.moveVariable(folder, v.id, 123, 456);
    const after = (await engine.loadGraph(folder)).nodes[0];
    expect(after.x).toBe(123);
    expect(after.y).toBe(456);
    expect(after.rev).toBe(before.rev); // cosmetic: no bump
  });

  it("updateVariable bumps rev and changes content", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "A" });
    const updated = await engine.updateVariable(folder, v.id, { label: "B", body: "note" });
    expect(updated.label).toBe("B");
    expect(updated.rev).toBe(v.rev + 1);
  });
});

describe("NativeEngine — quant equation writes", () => {
  it("writes equation/units into extra.quant and round-trips", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Drain", type: "flow" });
    await engine.setEquation(folder, v.id, { equation: "Water / 10", units: "L/min" });
    const node = (await engine.loadGraph(folder)).nodes.find((n) => n.id === v.id)!;
    expect(node.extra.quant).toEqual({ equation: "Water / 10", units: "L/min" });
  });

  it("merges successive edits instead of replacing the block", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Drain", type: "flow" });
    await engine.setEquation(folder, v.id, { equation: "Water / 10" });
    await engine.setEquation(folder, v.id, { units: "L/min" });
    const node = (await engine.loadGraph(folder)).nodes.find((n) => n.id === v.id)!;
    expect(node.extra.quant).toEqual({ equation: "Water / 10", units: "L/min" });
  });

  it("clears a field with an empty string and drops the block when empty", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Drain", type: "flow" });
    await engine.setEquation(folder, v.id, { equation: "Water / 10", units: "L/min" });
    await engine.setEquation(folder, v.id, { units: "" });
    let node = (await engine.loadGraph(folder)).nodes.find((n) => n.id === v.id)!;
    expect(node.extra.quant).toEqual({ equation: "Water / 10" });
    await engine.setEquation(folder, v.id, { equation: "" });
    node = (await engine.loadGraph(folder)).nodes.find((n) => n.id === v.id)!;
    expect("quant" in node.extra).toBe(false);
  });

  it("preserves quant keys it does not manage (e.g. a subscript dimension)", async () => {
    const { storage, engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Pop", type: "stock" });
    // Seed a richer quant block as the app/CLI might write it.
    const path = `${folder}/Nodes/${v.id}.md`;
    const seeded = parseNote(await storage.read(path), yaml, v.id);
    seeded.extra.quant = { initial: "990", dimension: "age" };
    await storage.write(path, serializeNote(seeded));

    await engine.setEquation(folder, v.id, { initial: "1000" });
    const node = (await engine.loadGraph(folder)).nodes.find((n) => n.id === v.id)!;
    expect(node.extra.quant).toEqual({ initial: "1000", dimension: "age" });
  });
});

describe("NativeEngine — build + export", () => {
  it("builds a model from a spec (links by label) and lays it out", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("Coffee");
    await engine.buildModel(folder, {
      variables: [
        { label: "Tiredness" },
        { label: "Coffee" },
        { label: "Alertness" },
      ],
      links: [
        { from: "Tiredness", to: "Coffee", polarity: "+" },
        { from: "Coffee", to: "Alertness", polarity: "+" },
        { from: "Alertness", to: "Tiredness", polarity: "-" },
      ],
    });
    const view = await engine.loadGraph(folder);
    expect(view.nodes).toHaveLength(3);
    expect(view.loops).toHaveLength(1);
    expect(view.loops[0].type).toBe(LoopType.balancing); // one '-' => B
    // layout assigned non-default positions
    expect(view.nodes.some((n) => n.x !== 0 || n.y !== 0)).toBe(true);
  });

  it("exports json with model + graph + loops", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("Coffee");
    await engine.buildModel(folder, {
      variables: [{ label: "A" }, { label: "B" }],
      links: [
        { from: "A", to: "B", polarity: "+" },
        { from: "B", to: "A", polarity: "+" },
      ],
    });
    const out = await engine.export(folder, "json");
    expect(out.ext).toBe("json");
    const parsed = JSON.parse(out.content);
    expect(parsed.model.name).toBe("Coffee");
    expect(parsed.graph.nodes).toHaveLength(2);
    expect(parsed.graph.edges).toHaveLength(2);
    expect(parsed.loops).toHaveLength(1);
  });
});

describe("NativeEngine — link curvature & loop notes", () => {
  it("sets a link curvature and clears it with null", async () => {
    const { engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const a = await engine.addVariable(folder, { label: "A" });
    const b = await engine.addVariable(folder, { label: "B" });
    await engine.addLink(folder, a.id, b.id, { polarity: "+", curvature: 42 });

    let link = (await engine.loadGraph(folder)).nodes.find((n) => n.id === a.id)!.links[0];
    expect(link.curvature).toBe(42);

    await engine.updateLink(folder, a.id, b.id, { curvature: null });
    link = (await engine.loadGraph(folder)).nodes.find((n) => n.id === a.id)!.links[0];
    expect(link.curvature).toBeUndefined();
  });

});

describe("NativeEngine — loop notes as Loops/*.md files", () => {
  it("anchors a note to a detected loop and resolves it by legacy key", async () => {
    const { storage, engine } = makeEngine();
    const folder = await twoLoopModel(engine);

    await engine.setLoopNote(folder, "R:A|B", "reinforcing growth");
    expect(await engine.getLoopNotes(folder)).toEqual({ "R:A|B": "reinforcing growth" });
    // Persisted as a real markdown file under Loops/, not in model.json.
    expect(await loopFiles(storage, folder)).toHaveLength(1);
    const m = JSON.parse(await storage.read(`${folder}/model.json`));
    expect(m.loopNotes).toBeUndefined(); // never written back to the manifest

    await engine.setLoopNote(folder, "B:C|D", "balancer");
    expect(await engine.getLoopNotes(folder)).toEqual({
      "R:A|B": "reinforcing growth",
      "B:C|D": "balancer",
    });

    // Clearing leaves the (now body-less) file but drops it from the resolved map.
    await engine.setLoopNote(folder, "R:A|B", "   ");
    expect(await engine.getLoopNotes(folder)).toEqual({ "B:C|D": "balancer" });
  });

  it("re-anchors the same file by identity (no duplicate on edit)", async () => {
    const { storage, engine } = makeEngine();
    const folder = await twoLoopModel(engine);
    await engine.setLoopNote(folder, "R:A|B", "first");
    await engine.setLoopNote(folder, "R:A|B", "second");
    expect(await loopFiles(storage, folder)).toHaveLength(1);
    expect(await engine.getLoopNotes(folder)).toEqual({ "R:A|B": "second" });
  });

  it("is a no-op when no live loop carries the key", async () => {
    const { storage, engine } = makeEngine();
    const folder = await twoLoopModel(engine);
    await engine.setLoopNote(folder, "R:ghost|gone", "into the void");
    expect(await engine.getLoopNotes(folder)).toEqual({});
    expect(await loopFiles(storage, folder)).toHaveLength(0);
  });

  it("loopNotePath finds-or-creates the canonical file, idempotently", async () => {
    const { storage, engine } = makeEngine();
    const folder = await twoLoopModel(engine);
    const p1 = await engine.loopNotePath(folder, "R:A|B");
    // Member order follows the (random) var-id ordering, so the slug is r-a-b or
    // r-b-a — the filename is cosmetic; identity lives in the frontmatter.
    expect(p1).toMatch(new RegExp(`^${folder}/Loops/r-(a-b|b-a)\\.md$`));
    const p2 = await engine.loopNotePath(folder, "R:A|B");
    expect(p2).toBe(p1);
    expect(await loopFiles(storage, folder)).toHaveLength(1);
    expect(await engine.loopNotePath(folder, "R:ghost|gone")).toBeNull();
  });

  it("migrates legacy model.json loop maps into Loops/*.md on first touch", async () => {
    const { storage, engine } = makeEngine();
    const folder = await twoLoopModel(engine);
    // Seed the legacy maps the old Dart app / old plugin used to write. The
    // manifest spreads `extra` at the JSON top level, so they live there.
    const mpath = `${folder}/model.json`;
    const m = JSON.parse(await storage.read(mpath));
    m.loopNotes = { "R:A|B": "reinforcing", "R:ghost|gone": "orphaned annotation" };
    m.loopTitles = { "R:A|B": "Growth engine" };
    m.loopValence = { "R:A|B": "virtuous" };
    m.loopArchetypes = { "R:A|B": "limits-to-growth" };
    await storage.write(mpath, JSON.stringify(m, null, 2));

    const notes = await engine.getLoopNotes(folder);
    expect(notes["R:A|B"]).toBe("reinforcing");
    expect(notes["R:ghost|gone"]).toBeUndefined(); // orphan: no live loop

    // Both the matched and the orphan note were written as files.
    const files = await loopFiles(storage, folder);
    expect(files).toHaveLength(2);
    // Legacy maps stripped from the manifest (fallback is now dead).
    const m2 = JSON.parse(await storage.read(mpath));
    expect(m2.loopNotes).toBeUndefined();
    expect(m2.loopTitles).toBeUndefined();
    expect(m2.loopValence).toBeUndefined();
    expect(m2.loopArchetypes).toBeUndefined();

    // Title / valence / archetype survived the migration on the matched file.
    const parsed = await Promise.all(
      files.map(async (f) =>
        parseLoopNote((await storage.read(`${folder}/Loops/${f}`)) ?? "", yaml),
      ),
    );
    const matched = parsed.find((n) => n.members.length > 0)!;
    expect(matched.title).toBe("Growth engine");
    expect(matched.valence).toBe("virtuous");
    expect(matched.extra.archetype).toBe("limits-to-growth");
    expect(matched.body).toBe("reinforcing");

    const orphan = parsed.find((n) => n.members.length === 0)!;
    expect(orphan.loopEcho).toBe("R:ghost|gone");
    expect(orphan.body).toBe("orphaned annotation");

    // Idempotent: a second read does not duplicate or re-migrate.
    expect(await engine.getLoopNotes(folder)).toEqual({ "R:A|B": "reinforcing" });
    expect(await loopFiles(storage, folder)).toHaveLength(2);
  });
});

describe("NativeEngine — discovery", () => {
  it("finds models nested anywhere under the scan root", async () => {
    const { engine } = makeEngine("");
    await engine.createModel("Top");
    // a model created under a subfolder root should still be discovered
    const nested = new NativeEngine(
      new MemoryStorage(),
      yaml,
      { modelsRoot: "deep/nested/path" },
    );
    const ref = await nested.createModel("Buried");
    expect(ref.folder).toBe("deep/nested/path/buried");
    const found = await nested.listModels();
    expect(found.map((m) => m.name)).toContain("Buried");
  });

  it("discovers models across the whole vault, not just the creation folder", async () => {
    const storage = new MemoryStorage();
    // This engine *creates* new models under a subfolder...
    const engine = new NativeEngine(storage, yaml, { modelsRoot: "neoloopy" });
    // ...but models already live at the vault top level (as the Dart app/CLI
    // and existing vaults write them).
    const root = new NativeEngine(storage, yaml, { modelsRoot: "" });
    await root.createModel("Top Level Work");
    await engine.createModel("Inside Subfolder");

    // Discovery must surface BOTH regardless of where new models are created.
    const found = (await engine.listModels()).map((m) => m.name);
    expect(found).toContain("Top Level Work");
    expect(found).toContain("Inside Subfolder");
  });
});

describe("NativeEngine — Nodes/ layout & legacy migration", () => {
  it("writes variable notes under Nodes/, not flat at the model root", async () => {
    const { storage, engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Births", type: "flow" });
    expect(await storage.exists(`${folder}/Nodes/${v.id}.md`)).toBe(true);
    expect(await storage.exists(`${folder}/${v.id}.md`)).toBe(false);
    // The manifest still lives at the model root, not under Nodes/.
    expect(await storage.exists(`${folder}/model.json`)).toBe(true);
  });

  /** Demote a Nodes/ note to the legacy flat location (a pre-Nodes vault). */
  async function demoteToFlat(
    storage: MemoryStorage,
    folder: string,
    id: string,
  ): Promise<void> {
    const body = await storage.read(`${folder}/Nodes/${id}.md`);
    await storage.write(`${folder}/${id}.md`, body);
    await storage.remove(`${folder}/Nodes/${id}.md`);
  }

  it("reads a legacy flat note when no Nodes/ copy exists", async () => {
    const { storage, engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Pop" });
    await demoteToFlat(storage, folder, v.id);

    const view = await engine.loadGraph(folder);
    expect(view.nodes.map((n) => n.label)).toEqual(["Pop"]);
    expect((await engine.listModels())[0].variableCount).toBe(1);
  });

  it("sweeps a legacy flat note into Nodes/ when it is next written", async () => {
    const { storage, engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Pop" });
    await demoteToFlat(storage, folder, v.id);

    await engine.updateVariable(folder, v.id, { label: "Population" });
    expect(await storage.exists(`${folder}/Nodes/${v.id}.md`)).toBe(true);
    expect(await storage.exists(`${folder}/${v.id}.md`)).toBe(false); // swept
    const view = await engine.loadGraph(folder);
    expect(view.nodes).toHaveLength(1); // not double-counted across both spots
    expect(view.nodes[0].label).toBe("Population");
  });

  it("lets a Nodes/ note win over a stale flat note with the same id", async () => {
    const { storage, engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Fresh" }); // in Nodes/
    // Plant a stale flat copy at the root carrying the same id.
    const stale = parseNote(await storage.read(`${folder}/Nodes/${v.id}.md`), yaml, v.id);
    await storage.write(`${folder}/${v.id}.md`, serializeNote({ ...stale, label: "Stale" }));

    const view = await engine.loadGraph(folder);
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0].label).toBe("Fresh"); // Nodes/ wins
    expect((await engine.listModels())[0].variableCount).toBe(1);
  });

  it("removeVariable deletes both the Nodes/ and any legacy flat copy", async () => {
    const { storage, engine } = makeEngine();
    const { folder } = await engine.createModel("M");
    const v = await engine.addVariable(folder, { label: "Gone" });
    // A leftover flat copy alongside the canonical Nodes/ one.
    await storage.write(`${folder}/${v.id}.md`, await storage.read(`${folder}/Nodes/${v.id}.md`));

    await engine.removeVariable(folder, v.id);
    expect(await storage.exists(`${folder}/Nodes/${v.id}.md`)).toBe(false);
    expect(await storage.exists(`${folder}/${v.id}.md`)).toBe(false);
    expect((await engine.loadGraph(folder)).nodes).toHaveLength(0);
  });

  it("prunes a model's subfolders from discovery (no nested-model false positive)", async () => {
    const { storage, engine } = makeEngine("");
    const { folder } = await engine.createModel("Parent");
    await engine.addVariable(folder, { label: "A" }); // creates Nodes/
    // A stray model.json buried under the model dir must NOT register as a model.
    await storage.write(
      `${folder}/Nodes/model.json`,
      JSON.stringify({ id: "junk", name: "Junk" }),
    );
    expect((await engine.listModels()).map((m) => m.name)).toEqual(["Parent"]);
  });
});

describe("ensureSystemNote", () => {
  it("creates a minimal valid System.md when absent", async () => {
    const { storage, engine } = makeEngine();
    const ref = await engine.createModel("Alpha");
    const path = await engine.ensureSystemNote(ref.folder);
    expect(path).toBe(joinPath(ref.folder, "System.md"));
    expect(await storage.exists(path)).toBe(true);
    const text = await storage.read(path);
    expect(text).toContain(`model: ${JSON.stringify(ref.id)}`);
  });

  it("is a no-op when System.md already exists", async () => {
    const { storage, engine } = makeEngine();
    const ref = await engine.createModel("Alpha");
    const path = await engine.ensureSystemNote(ref.folder);
    await storage.write(path, "custom contents");
    await engine.ensureSystemNote(ref.folder);
    expect(await storage.read(path)).toBe("custom contents");
  });
});

describe("deriveParents", () => {
  it("finds the parent model that anchors this model as a subsystem", async () => {
    const { engine } = makeEngine();
    const child = await engine.createModel("Child");
    const parent = await engine.createModel("Parent");
    const v = await engine.addVariable(parent.folder, { label: "Sector" });
    await engine.setSubsystem(parent.folder, v.id, { folder: child.folder, name: child.name });
    const parents = await engine.deriveParents(child.folder);
    expect(parents).toHaveLength(1);
    expect(parents[0].modelFolder).toBe(parent.folder);
    expect(parents[0].anchorVarId).toBe(v.id);
    expect(parents[0].anchorVarLabel).toBe("Sector");
  });

  it("returns empty for a model with no parents", async () => {
    const { engine } = makeEngine();
    const solo = await engine.createModel("Solo");
    expect(await engine.deriveParents(solo.folder)).toEqual([]);
  });
});
