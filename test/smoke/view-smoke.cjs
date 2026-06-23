/*
 * Headless execution of the CANVAS RENDER path from the shipped bundle.
 *
 * The engine smoke test (smoke.cjs) stops at data; this one drives the actual
 * `CanvasView` from `main.js` through a faithful DOM + recording-2D-context shim:
 * it opens the view, lets it auto-load the seeded model, and runs the real
 * `paint()` pipeline. It then asserts the model genuinely rendered by inspecting
 * what was drawn — node labels and the R1/B1 loop badges must appear in the
 * captured `fillText` calls. This executes the GUI rendering code end-to-end
 * without launching Obsidian; it cannot confirm pixels look right (that needs a
 * human), but it proves the canvas code runs and draws the model + loops.
 *
 *     node test/smoke/view-smoke.cjs
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const Module = require("module");
const { parse: parseYaml } = require("yaml");

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  if (!cond) failures++;
};

// ---- recording 2D context ------------------------------------------------
function makeCtx(rec) {
  const store = {};
  return new Proxy(store, {
    get(t, prop) {
      if (prop === "measureText") return (s) => ({ width: String(s ?? "").length * 7 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient")
        return () => ({ addColorStop() {} });
      if (prop in t && typeof t[prop] !== "function") return t[prop];
      return (...args) => {
        rec.calls.push(prop);
        if (prop === "fillText" || prop === "strokeText") rec.texts.push(String(args[0]));
      };
    },
    set(t, prop, val) { t[prop] = val; return true; },
  });
}

// ---- minimal DOM ---------------------------------------------------------
class FakeStyle { setProperty(k, v) { this[k] = v; } }
class FakeClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, on) { on === undefined ? (this.s.has(c) ? this.s.delete(c) : this.s.add(c)) : on ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
let ctxRec = null;
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this._w = 1200; this._h = 800;
    this.value = ""; this.tabIndex = 0; this._text = "";
    this.width = 0; this.height = 0;
  }
  get clientWidth() { return this._w; }
  get clientHeight() { return this._h; }
  _mk(tag, opts) {
    const el = new FakeEl(tag);
    if (opts && opts.cls) el.classList.add(...String(opts.cls).split(/\s+/));
    if (opts && opts.text) el._text = String(opts.text);
    if (opts && opts.type) el.type = opts.type;
    this.children.push(el);
    return el;
  }
  createDiv(opts) { return this._mk("div", opts); }
  createSpan(opts) { return this._mk("span", opts); }
  createEl(tag, opts) { return this._mk(tag, opts); }
  createSvg(tag, opts) {
    const el = new FakeEl(tag);
    if (opts && opts.cls) el.classList.add(...String(opts.cls).split(/\s+/));
    if (opts && opts.attr) for (const k of Object.keys(opts.attr)) el.setAttribute(k, opts.attr[k]);
    this.children.push(el);
    return el;
  }
  empty() { this.children = []; }
  addClass(...c) { this.classList.add(...c); }
  removeClass(...c) { this.classList.remove(...c); }
  toggleClass(c, on) { this.classList.toggle(c, on); }
  setText(t) { this._text = String(t ?? ""); }
  appendChild(el) { this.children.push(el); }
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  setAttribute(k, v) { this[k] = v; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this._w, height: this._h, right: this._w, bottom: this._h }; }
  getContext() { return ctxRec; }
  focus() {} select() {} setPointerCapture() {} releasePointerCapture() {}
  querySelector() { return null; }
}

// ---- obsidian shim -------------------------------------------------------
const normalizePath = (p) => String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
function makeAdapter(root) {
  const abs = (p) => path.join(root, normalizePath(p));
  return {
    async exists(p) { return fs.existsSync(abs(p)); },
    async read(p) { return fs.readFileSync(abs(p), "utf8"); },
    async write(p, d) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), d); },
    async remove(p) { fs.rmSync(abs(p), { force: true }); },
    async mkdir(p) { fs.mkdirSync(abs(p), { recursive: true }); },
    async rmdir(p, r) { fs.rmSync(abs(p), { recursive: !!r, force: true }); },
    async list(p) {
      const rel = normalizePath(p);
      const out = { files: [], folders: [] };
      for (const e of fs.readdirSync(abs(p), { withFileTypes: true })) {
        const v = rel ? `${rel}/${e.name}` : e.name;
        (e.isDirectory() ? out.folders : out.files).push(v);
      }
      return out;
    },
  };
}

class Component { registerDomEvent() {} registerEvent() {} registerInterval() {} addChild() {} load() {} onload() {} onunload() {} }
class Plugin extends Component {
  constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; }
  addCommand(c) { (this._cmds = this._cmds || []).push(c); return c; }
  addRibbonIcon() { return {}; }
  addSettingTab() {}
  registerView(type, factory) { (this._views = this._views || {})[type] = factory; }
  async loadData() { return null; }
  async saveData() {}
}
class ItemView extends Component {
  constructor(leaf) { super(); this.leaf = leaf; this.app = leaf && leaf.app; this.contentEl = new FakeEl("div"); this.containerEl = new FakeEl("div"); }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class FileSystemAdapter {}
class Notice {}
class TAbstractFile { constructor() { this.path = ""; this.name = ""; } }
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile { constructor() { super(); this.children = []; } }
class WorkspaceLeaf { updateHeader() {} }
class Menu { addItem() { return this; } addSeparator() { return this; } showAtMouseEvent() {} showAtPosition() {} }
class Modal {
  constructor(app) { this.app = app; this.contentEl = new FakeEl("div"); this.titleEl = new FakeEl("div"); this.modalEl = new FakeEl("div"); }
  open() { this.onOpen && this.onOpen(); } close() { this.onClose && this.onClose(); }
}
class DropdownComponent {
  constructor() { this.selectEl = new FakeEl("select"); }
  addOption() { return this; } addOptions() { return this; }
  setValue(v) { this.value = v; return this; } getValue() { return this.value; }
  onChange() { return this; } setDisabled() { return this; }
}
class ButtonComponent {
  constructor() { this.buttonEl = new FakeEl("button"); }
  setIcon() { return this; } setTooltip() { return this; } setButtonText() { return this; }
  onClick() { return this; } setDisabled() { return this; } setCta() { return this; }
}
class Setting {
  setName() { return this; } setDesc() { return this; } setHeading() { return this; }
  addText(cb) { cb && cb({ setPlaceholder: () => ({ setValue: () => ({ onChange: () => {} }) }), setValue: () => ({ onChange: () => {} }) }); return this; }
  addToggle(cb) { cb && cb({ setValue: () => ({ onChange: () => {} }) }); return this; }
  addDropdown(cb) { cb && cb(new DropdownComponent()); return this; }
  addButton(cb) { cb && cb(new ButtonComponent()); return this; }
}
const debounce = (fn) => { const g = (...a) => fn && fn(...a); g.cancel = () => {}; g.run = () => {}; return g; };

const obsidianShim = {
  Plugin, Component, ItemView, PluginSettingTab, FileSystemAdapter, Notice, Menu, Modal,
  TAbstractFile, TFile, TFolder, WorkspaceLeaf, DropdownComponent, ButtonComponent, Setting,
  Platform: { isDesktopApp: true, isMobile: false }, parseYaml, normalizePath, debounce,
  setIcon: () => {},
  async requestUrl() { return { status: 200, json: {}, text: "" }; },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === "obsidian" ? obsidianShim : origLoad.call(this, request, parent, isMain);
};

// ---- globals -------------------------------------------------------------
globalThis.window = { devicePixelRatio: 2, setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
globalThis.document = {
  body: { classList: new FakeClassList() },
  // The view creates an offscreen <canvas> for label measurement in onOpen.
  createElement: (tag) => new FakeEl(tag),
};
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };

// ---- harness -------------------------------------------------------------
async function main() {
  const pluginRoot = path.resolve(__dirname, "..", "..");
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nl-view-"));
  const adapter = makeAdapter(vault);
  function absV(p) { return path.join(vault, normalizePath(p)); }
  function mkFile(p) { const f = new TFile(); f.path = normalizePath(p); f.name = path.basename(f.path); return f; }
  function mkFolder(p) {
    const folder = new TFolder();
    folder.path = normalizePath(p);
    folder.name = path.basename(folder.path);
    try {
      for (const e of fs.readdirSync(absV(p), { withFileTypes: true })) {
        const cp = folder.path ? `${folder.path}/${e.name}` : e.name;
        folder.children.push(e.isDirectory() ? mkFolder(cp) : mkFile(cp));
      }
    } catch { /* ignore */ }
    return folder;
  }
  const vaultApi = {
    on: () => ({}),
    adapter,
    getAbstractFileByPath(p) {
      const abs = absV(p);
      if (!fs.existsSync(abs)) return null;
      return fs.statSync(abs).isDirectory() ? mkFolder(p) : mkFile(p);
    },
    async read(file) { return fs.readFileSync(absV(file.path), "utf8"); },
    async create(p, data) {
      const abs = absV(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      return mkFile(p);
    },
    async modify(file, data) { fs.writeFileSync(absV(file.path), data); },
    async delete(file, _force) { fs.rmSync(absV(file.path), { recursive: true, force: true }); },
    async createFolder(p) {
      fs.mkdirSync(absV(p), { recursive: true });
      return mkFolder(p);
    },
  };
  const app = {
    vault: vaultApi,
    workspace: { on: () => ({}), onLayoutReady: (cb) => cb(), getActiveViewOfType: () => null, getLeavesOfType: () => [], getLeaf: () => ({ setViewState: async () => {} }), revealLeaf: () => {}, openLinkText: async () => {} },
  };

  const rec = { calls: [], texts: [] };
  ctxRec = makeCtx(rec);

  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-vmain-"));
  const cjs = path.join(bundleDir, "main.cjs");
  const fd = fs.openSync(cjs, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, fs.readFileSync(path.join(pluginRoot, "main.js")));
  } finally {
    fs.closeSync(fd);
  }
  const PluginClass = require(cjs).default || require(cjs);
  fs.rmSync(bundleDir, { recursive: true, force: true });

  const plugin = new PluginClass(app, { id: "neoloopy", version: "0.1.0" });
  await plugin.onload();

  // Seed the same demo model the test vault uses (R1 + B1), via the engine.
  const ref = await plugin.engine.createModel("Coffee & Burnout");
  await plugin.engine.buildModel(ref.folder, {
    variables: [
      { label: "Coffee intake", type: "stock" },
      { label: "Alertness", type: "auxiliary" },
      { label: "Productivity", type: "auxiliary" },
      { label: "Fatigue", type: "stock" },
    ],
    links: [
      { from: "Coffee intake", to: "Alertness", polarity: "+" },
      { from: "Alertness", to: "Productivity", polarity: "+" },
      { from: "Productivity", to: "Coffee intake", polarity: "+" },
      { from: "Coffee intake", to: "Fatigue", polarity: "+" },
      { from: "Fatigue", to: "Alertness", polarity: "-" },
    ],
  });

  // Open the real CanvasView from the bundle and let it render the model.
  // A real WorkspaceLeaf carries updateHeader() (openModel calls it to refresh
  // the tab title), so the mock leaf must provide it too.
  const factory = plugin._views["neoloopy-canvas"];
  check("canvas view factory registered", typeof factory === "function");
  const view = factory({ app, updateHeader() {} });
  let threw = null;
  try {
    await view.onOpen();
  } catch (e) { threw = e; }
  check("view.onOpen() rendered without throwing", !threw, threw && threw.stack);

  check("paint issued drawing calls", rec.calls.length > 50, String(rec.calls.length));
  check("drew node strokes/fills", rec.calls.includes("stroke") && rec.calls.includes("fill"));
  const drewLabel = rec.texts.some((t) => t.includes("Coffee") || t.includes("Alertness") || t.includes("Productivity") || t.includes("Fatigue"));
  check("rendered the model's variable labels", drewLabel, JSON.stringify([...new Set(rec.texts)]).slice(0, 200));
  check("rendered the R1 loop badge", rec.texts.includes("R1"), JSON.stringify(rec.texts.filter((t) => /^[RB]\d/.test(t))));
  check("rendered the B1 loop badge", rec.texts.includes("B1"));
  check("view reports the open folder", view.currentFolder() === ref.folder, String(view.currentFolder()));

  // ---- selection chrome (menus / badge note / trash / loop highlight) ----
  const vis = (el) => !!el && el.classList.contains("is-visible");

  const chrome = view.chrome;

  const nodeId = view.graph.nodes[0].id;
  view.select(nodeId, null, null);
  view.render();
  check("node selection shows the ⋯ toggle (collapsed)", vis(chrome.nodeMenuToggle));
  check("node menu stays collapsed until the toggle is tapped", !vis(chrome.nodeMenu));
  check("node selection shows the trash button", vis(chrome.trashBtn));
  // Opening the toggle reveals the kind/color panel.
  chrome.toggleNodeMenu();
  check("opening the node toggle reveals the node menu", vis(chrome.nodeMenu));

  const edgeId = view.scene.edges[0].id;
  view.select(null, edgeId, null);
  view.render();
  check("edge selection shows the ⋯ toggle (collapsed)", vis(chrome.edgeMenuToggle));
  check("edge menu stays collapsed until the toggle is tapped", !vis(chrome.edgeMenu));
  check("edge selection shows the trash button", vis(chrome.trashBtn));
  check("node chrome hides when an edge is selected (mutual exclusion)", !vis(chrome.nodeMenuToggle) && !vis(chrome.nodeMenu));
  chrome.toggleEdgeMenu();
  check("opening the edge toggle reveals the edge menu", vis(chrome.edgeMenu));

  const loopKey = view.graph.loops[0].key;
  view.select(null, null, loopKey);
  view.render();
  check("loop selection shows the badge note icon", vis(chrome.badgeNoteBtn));
  check(
    "loop selection highlights the loop's edges",
    !!view.loopHi && view.loopHi.edgeIds.size > 0,
    JSON.stringify(view.loopHi && [...view.loopHi.edgeIds]),
  );
  check("loop selection shows no trash button (loops aren't deletable)", !vis(chrome.trashBtn));

  view.select(null, null, null);
  view.render();
  check(
    "clearing selection hides all chrome",
    !vis(chrome.nodeMenuToggle) && !vis(chrome.nodeMenu) && !vis(chrome.edgeMenuToggle) &&
      !vis(chrome.edgeMenu) && !vis(chrome.badgeNoteBtn) && !vis(chrome.trashBtn),
  );

  // ---- insight panel ------------------------------------------------------
  const findByClass = (el, cls, acc = []) => {
    if (!el || !el.children) return acc;
    for (const c of el.children) {
      if (c.classList && c.classList.contains(cls)) acc.push(c);
      findByClass(c, cls, acc);
    }
    return acc;
  };
  const panel = findByClass(view.contentEl, "neoloopy-insight-panel")[0];
  check("insight panel exists", !!panel);
  check("insight panel open by default", !!panel && panel.classList.contains("is-open"));
  check(
    "panel lists the detected loops",
    findByClass(panel, "neoloopy-ip-loop").length === view.graph.loops.length,
    String(findByClass(panel, "neoloopy-ip-loop").length),
  );
  check("panel shows the structure section", findByClass(panel, "neoloopy-ip-label").some((e) => e._text === "Structure"));
  // What-if simulation is intentionally NOT in the plugin — quant is preview-only
  // in Obsidian (definitions yes, the simulator no). Guard against it returning.
  check("panel has no what-if section (simulator stays out of Obsidian)", findByClass(panel, "neoloopy-ip-whatif-controls").length === 0);

  // System card: always present when a model is open; the icon opens System.md.
  check("panel shows the System card", findByClass(panel, "neoloopy-ip-system").length === 1);
  check("System card has an open button", findByClass(panel, "neoloopy-ip-system-open").length === 1);

  // Parents: link a NEW model down into the open model, reopen so parents
  // recompute, and assert a parent row appears (exercises deriveParents → cache
  // → render → host.openModel wiring end-to-end through the bundle).
  const parentRef = await plugin.engine.createModel("Umbrella");
  const pv = await plugin.engine.addVariable(parentRef.folder, { label: "Coffee sector" });
  await plugin.engine.setSubsystem(parentRef.folder, pv.id, { folder: ref.folder, name: ref.name });
  await view.openModel(ref.folder);
  const parentRows = findByClass(panel, "neoloopy-ip-parent");
  check("panel shows one parent row", parentRows.length === 1, String(parentRows.length));
  check(
    "parent row names the parent model",
    findByClass(panel, "neoloopy-ip-parent-name").some((e) => e._text === "Umbrella"),
  );

  view.toggleInsightPanel();
  check("toggling closes the panel", !panel.classList.contains("is-open"));
  check("closed panel renders nothing", findByClass(panel, "neoloopy-ip-loop").length === 0);
  view.toggleInsightPanel();
  check("toggling reopens the panel", panel.classList.contains("is-open"));

  // ---- iOS edit affordance: a new node's rename box opens IN the gesture -----
  // iOS WebKit only raises the soft keyboard when focus() runs synchronously
  // inside the pointer gesture, so createNodeAt must open + focus the rename
  // input BEFORE its first await (the vault write), not after. Assert the input
  // exists synchronously, before the returned promise resolves.
  const renameCount = () => findByClass(view.wrapper, "neoloopy-rename-input").length;
  const beforeCreate = renameCount();
  const createP = view.createNodeAt({ x: 100, y: 100 });
  check(
    "new-node rename input opens synchronously (iOS keyboard in-gesture)",
    renameCount() === beforeCreate + 1,
    `before=${beforeCreate} after=${renameCount()}`,
  );
  await createP;
  check("new-node rename input survives the write settling", renameCount() >= 1, String(renameCount()));

  try { await view.onClose(); check("view.onClose() ran without throwing", true); }
  catch (e) { check("view.onClose() ran without throwing", false, e.message); }

  fs.rmSync(vault, { recursive: true, force: true });
  console.log(failures === 0 ? "\nVIEW SMOKE PASS" : `\nVIEW SMOKE FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("view smoke harness error:", e); process.exit(2); });
