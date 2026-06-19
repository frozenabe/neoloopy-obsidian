/*
 * End-to-end smoke test of the SHIPPED bundle (`main.js`), not the TS source.
 *
 * It loads the real esbuild output under a faithful `obsidian` shim (a real-FS
 * DataAdapter rooted at a temp vault), runs the plugin's `onload()`, then drives
 * the plugin's OWN engine to build a model, detect loops, and export. Finally it
 * proves cross-tool compatibility with the shipping Dart app BOTH directions:
 *   - the plugin writes a vault → the real `neoloopy` binary reads it & finds the
 *     same loop;
 *   - the `neoloopy` binary writes a model into the same vault → the plugin's
 *     engine reads it back.
 *
 * This is the closest mechanical proxy for "loaded in Obsidian against a live
 * vault" achievable without driving the Electron GUI. Run:
 *     node test/smoke/smoke.cjs
 * (requires a built main.js and the `neoloopy` binary on PATH).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const Module = require("module");
const { parse: parseYaml } = require("yaml");

// ---- assertions ----------------------------------------------------------
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- obsidian shim -------------------------------------------------------
function normalizePath(p) {
  return String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

function makeAdapter(root) {
  const abs = (p) => path.join(root, normalizePath(p));
  return {
    async exists(p) { return fs.existsSync(abs(p)); },
    async read(p) { return fs.readFileSync(abs(p), "utf8"); },
    async write(p, data) {
      fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
      fs.writeFileSync(abs(p), data);
    },
    async remove(p) { fs.rmSync(abs(p), { force: true }); },
    async mkdir(p) { fs.mkdirSync(abs(p), { recursive: true }); },
    async rmdir(p, recursive) { fs.rmSync(abs(p), { recursive: !!recursive, force: true }); },
    async list(p) {
      const rel = normalizePath(p);
      const entries = fs.readdirSync(abs(p), { withFileTypes: true });
      const files = [];
      const folders = [];
      for (const e of entries) {
        const vrel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) folders.push(vrel);
        else files.push(vrel);
      }
      return { files, folders };
    },
  };
}

class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  addCommand(c) { (this._cmds = this._cmds || []).push(c); return c; }
  addRibbonIcon() { return {}; }
  addSettingTab() {}
  registerView(type, factory) { (this._views = this._views || {})[type] = factory; }
  registerEvent() {}
  registerDomEvent() {}
  registerInterval() {}
  addChild() {}
  async loadData() { return null; }
  async saveData() {}
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class ItemView { constructor(leaf) { this.leaf = leaf; } }
class FileSystemAdapter {}
class Notice { constructor(msg) { this.message = msg; } }
class Menu {}
class TAbstractFile { constructor() { this.path = ""; this.name = ""; } }
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile { constructor() { super(); this.children = []; } }
class WorkspaceLeaf {}
class Modal { constructor(app) { this.app = app; } open() {} close() {} }
class ButtonComponent { constructor() { return new Proxy(this, { get: () => () => this }); } }
class DropdownComponent { constructor() { return new Proxy(this, { get: () => () => this }); } }
class Setting { constructor() { return new Proxy(this, { get: () => () => this }); } }

const obsidianShim = {
  Plugin, PluginSettingTab, ItemView, FileSystemAdapter, Notice, Menu, Modal,
  TAbstractFile, TFile, TFolder, WorkspaceLeaf, ButtonComponent, DropdownComponent, Setting,
  Platform: { isDesktopApp: true, isMobile: false },
  parseYaml,
  normalizePath,
  setIcon: () => {},
  debounce: (fn) => fn,
  async requestUrl() { return { status: 200, json: {}, text: "" }; },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianShim;
  return origLoad.call(this, request, parent, isMain);
};

// ---- harness -------------------------------------------------------------
async function main() {
  const here = __dirname;
  const pluginRoot = path.resolve(here, "..", "..");
  const mainJs = path.join(pluginRoot, "main.js");
  if (!fs.existsSync(mainJs)) throw new Error("main.js not found — run `npm run build` first.");

  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nl-smoke-"));
  const adapter = makeAdapter(vault);
  // Vault API methods used by ObsidianStorage (Vault API migration).
  function absVault(p) { return path.join(vault, normalizePath(p)); }
  function makeFile(p) { const f = new TFile(); f.path = normalizePath(p); f.name = path.basename(f.path); return f; }
  function makeFolder(p) {
    const folder = new TFolder();
    folder.path = normalizePath(p);
    folder.name = path.basename(folder.path);
    try {
      const entries = fs.readdirSync(absVault(p), { withFileTypes: true });
      for (const e of entries) {
        const cp = folder.path ? `${folder.path}/${e.name}` : e.name;
        folder.children.push(e.isDirectory() ? makeFolder(cp) : makeFile(cp));
      }
    } catch { /* dir may not exist */ }
    return folder;
  }
  const vaultApi = {
    adapter,
    getAbstractFileByPath(p) {
      const abs = absVault(p);
      if (!fs.existsSync(abs)) return null;
      return fs.statSync(abs).isDirectory() ? makeFolder(p) : makeFile(p);
    },
    async read(file) { return fs.readFileSync(absVault(file.path), "utf8"); },
    async create(p, data) {
      const abs = absVault(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      return makeFile(p);
    },
    async modify(file, data) { fs.writeFileSync(absVault(file.path), data); },
    async delete(file, _force) {
      const abs = absVault(file.path);
      fs.rmSync(abs, { recursive: true, force: true });
    },
    async createFolder(p) {
      fs.mkdirSync(absVault(p), { recursive: true });
      return makeFolder(p);
    },
  };
  const app = {
    vault: vaultApi,
    workspace: {
      getActiveViewOfType: () => null,
      getLeavesOfType: () => [],
      getLeaf: () => ({ setViewState: async () => {} }),
      revealLeaf: () => {},
    },
  };

  console.log(`bundle: ${mainJs}`);
  console.log(`vault:  ${vault}`);

  // package.json has "type":"module", so Node would treat main.js as ESM. Obsidian
  // always loads it as CommonJS; replicate that by requiring a .cjs copy of the bytes.
  const cjsCopy = path.join(os.tmpdir(), `nl-main-${process.pid}.cjs`);
  fs.writeFileSync(cjsCopy, fs.readFileSync(mainJs));
  const mod = require(cjsCopy);
  fs.rmSync(cjsCopy, { force: true });
  const PluginClass = mod.default || mod;
  check("bundle exports a plugin class", typeof PluginClass === "function");

  const plugin = new PluginClass(app, { id: "neoloopy", version: "0.1.0" });
  await plugin.onload();
  check("onload() ran without throwing", true);
  check("engine constructed", !!plugin.engine);
  check("registered the canvas view", !!(plugin._views && plugin._views["neoloopy-canvas"]));
  check("registered commands", !!(plugin._cmds && plugin._cmds.length >= 6), plugin._cmds && String(plugin._cmds.length));

  // --- drive the plugin's own engine: build a reinforcing 2-loop ---
  const eng = plugin.engine;
  const ref = await eng.createModel("Smoke Coffee");
  check("createModel returned a folder", !!ref.folder, JSON.stringify(ref));
  await eng.buildModel(ref.folder, {
    variables: [
      { label: "Coffee consumed", type: "stock" },
      { label: "Alertness", type: "auxiliary" },
    ],
    links: [
      { from: "Coffee consumed", to: "Alertness", polarity: "+" },
      { from: "Alertness", to: "Coffee consumed", polarity: "+" },
    ],
  });
  const graph = await eng.loadGraph(ref.folder);
  check("model has 2 variables", graph.nodes.length === 2, String(graph.nodes.length));
  check("detected exactly 1 loop", graph.loops.length === 1, String(graph.loops.length));
  const loop = graph.loops[0];
  // LoopType.reinforcing === 0; the badge label should be "R1".
  const label = loop && graph.labels.get(loop.key);
  check("loop is reinforcing (R1)", loop && loop.type === 0 && label === "R1", `type=${loop && loop.type} label=${label}`);

  const json = await eng.export(ref.folder, "json");
  check("export json is parseable", (() => { try { JSON.parse(json.content); return true; } catch { return false; } })());
  const mermaid = await eng.export(ref.folder, "mermaid");
  check("export mermaid mentions both vars", mermaid.content.includes("Coffee consumed") && mermaid.content.includes("Alertness"));

  // --- cross-tool: the REAL Dart binary reads what the plugin wrote ---
  // Plugin models live under <vault>/neoloopy/, which is the Dart vault root.
  const dartVault = path.join(vault, "neoloopy");
  const nl = (args) => execFileSync("neoloopy", ["--vault", dartVault, ...args], { encoding: "utf8" });
  let binOk = true;
  try { execFileSync("neoloopy", ["--help"], { stdio: "ignore" }); } catch { binOk = false; }
  if (!binOk) {
    console.log("  skip cross-tool checks — `neoloopy` binary not on PATH");
  } else {
    const models = JSON.parse(nl(["list-models"]));
    const list = Array.isArray(models) ? models : models.models || [];
    const mine = list.find((m) => m.id === ref.id);
    check("Dart binary lists the plugin-written model", !!mine, JSON.stringify(list));
    const loopsOut = JSON.parse(nl(["loops", ref.id]));
    const dloops = Array.isArray(loopsOut) ? loopsOut : loopsOut.loops || [];
    check("Dart binary detects the same 1 loop", dloops.length === 1, JSON.stringify(loopsOut).slice(0, 200));

    // --- loop notes: plugin writes model.json, the Dart app reads it back ---
    const noteKey = "R:Alertness|Coffee consumed"; // <R|B>:sorted variable names
    await eng.setLoopNote(ref.folder, noteKey, "SMOKE-LOOP-NOTE-XYZ");
    const back = await eng.getLoopNotes(ref.folder);
    check("plugin engine round-trips a loop note", back[noteKey] === "SMOKE-LOOP-NOTE-XYZ", JSON.stringify(back));
    const ln = nl(["loop-notes", ref.id]);
    check("Dart binary surfaces the plugin-written loop note", ln.includes("SMOKE-LOOP-NOTE-XYZ"), ln.slice(0, 300));

    // --- reverse: Dart writes a model, the plugin's engine reads it ---
    const created = JSON.parse(nl(["create-model", "Dart Made"]));
    nl(["add-variable", created.id, "Births", "--kind", "flow"]);
    nl(["add-variable", created.id, "Population", "--kind", "stock"]);
    const models2 = await eng.listModels();
    const dartModel = models2.find((m) => m.id === created.id);
    check("plugin engine lists the Dart-written model", !!dartModel, JSON.stringify(models2.map((m) => m.id)));
    if (dartModel) {
      const g2 = await eng.loadGraph(dartModel.folder);
      const labels = g2.nodes.map((n) => n.label).sort();
      check("plugin engine reads Dart-written variables", labels.join(",") === "Births,Population", labels.join(","));
    }
  }

  fs.rmSync(vault, { recursive: true, force: true });
  console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("smoke harness error:", e); process.exit(2); });
