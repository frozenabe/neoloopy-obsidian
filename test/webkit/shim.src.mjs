/*
 * In-BROWSER Obsidian shim for the iOS canvas harness.
 *
 * Unlike test/smoke/view-smoke.cjs (which fakes the DOM and no-ops focus/blur and
 * event listeners — and so can NEVER reproduce an iOS focus bug), this shim runs
 * the SHIPPED main.js bundle inside a real WebKit page:
 *   - DOM helpers (createEl/createDiv/…) build REAL elements,
 *   - registerDomEvent attaches REAL addEventListener handlers,
 *   - input.focus()/blur() are the browser's real, iOS-faithful implementations.
 * The vault is an in-memory store (no Node fs in the browser).
 *
 * esbuild bundles this (it pulls in the real `yaml` parser) into an IIFE that
 * sets window.__OBSIDIAN__ (the `obsidian` module) and window.__makeApp().
 */
import { parse as parseYaml } from "yaml";

// ---- Obsidian's HTMLElement DOM helpers (not present in plain browsers) -----
// Defined on Element.prototype so they exist on both HTML and SVG elements.
function applyOpts(el, o, svg) {
  if (!o) return el;
  if (o.cls) {
    const cls = Array.isArray(o.cls) ? o.cls : String(o.cls).split(/\s+/);
    for (const c of cls) if (c) el.classList.add(c);
  }
  if (o.text != null) el.textContent = String(o.text);
  if (o.attr) for (const k of Object.keys(o.attr)) {
    const v = o.attr[k];
    if (v == null || v === false) el.removeAttribute(k);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  if (!svg) {
    if (o.type != null) el.setAttribute("type", o.type);
    if (o.value != null) el.value = o.value;
    if (o.placeholder != null) el.placeholder = o.placeholder;
    if (o.href != null) el.setAttribute("href", o.href);
    if (o.title != null) el.title = o.title;
  }
  return el;
}
function installDomHelpers() {
  const P = Element.prototype;
  if (P.__nlHelpers) return;
  P.__nlHelpers = true;
  P.createEl = function (tag, o, cb) {
    const el = document.createElement(tag);
    applyOpts(el, o, false);
    (o && o.prepend) ? this.prepend(el) : this.appendChild(el);
    if (cb) cb(el);
    return el;
  };
  P.createDiv = function (o, cb) { return this.createEl("div", o, cb); };
  P.createSpan = function (o, cb) { return this.createEl("span", o, cb); };
  P.createSvg = function (tag, o, cb) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (o && o.cls) el.setAttribute("class", Array.isArray(o.cls) ? o.cls.join(" ") : o.cls);
    applyOpts(el, o ? { attr: o.attr } : null, true);
    this.appendChild(el);
    if (cb) cb(el);
    return el;
  };
  P.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); return this; };
  P.detach = function () { this.remove(); return this; };
  P.addClass = function (...c) { this.classList.add(...c.filter(Boolean)); return this; };
  P.removeClass = function (...c) { this.classList.remove(...c.filter(Boolean)); return this; };
  P.toggleClass = function (c, on) {
    const arr = Array.isArray(c) ? c : [c];
    for (const x of arr) (on === undefined) ? this.classList.toggle(x) : this.classList.toggle(x, !!on);
    return this;
  };
  P.setText = function (t) { this.textContent = t == null ? "" : String(t); return this; };
  P.setAttr = function (k, v) { (v == null || v === false) ? this.removeAttribute(k) : this.setAttribute(k, v === true ? "" : String(v)); return this; };
  P.appendText = function (t) { this.appendChild(document.createTextNode(String(t))); return this; };
}

// ---- obsidian module values ------------------------------------------------
const normalizePath = (p) =>
  String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
const parentPath = (p) => { const n = normalizePath(p); const i = n.lastIndexOf("/"); return i < 0 ? "" : n.slice(0, i); };
const baseName = (p) => { const n = normalizePath(p); const i = n.lastIndexOf("/"); return i < 0 ? n : n.slice(i + 1); };

class Component {
  registerDomEvent(el, type, cb, opts) { el.addEventListener(type, cb, opts); }
  registerEvent(_ref) {}
  registerInterval(id) { return id; }
  addChild(c) { return c; }
  load() {} onload() {} unload() {} onunload() {}
}
class Plugin extends Component {
  constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this._cmds = []; this._views = {}; }
  addCommand(c) { this._cmds.push(c); return c; }
  addRibbonIcon() { return document.createElement("div"); }
  addSettingTab() {}
  registerView(type, factory) { this._views[type] = factory; }
  async loadData() { return null; }
  async saveData() {}
}
class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf && leaf.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
    // Obsidian's real contentEl is containerEl.children[1]; the view builds here.
    this.containerEl.createDiv({ cls: "view-header" });
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
    (document.getElementById("mount") || document.body).appendChild(this.containerEl);
  }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement("div"); } display() {} hide() {} }
class FileSystemAdapter {}
class Notice { constructor(msg) { this.message = msg; /* eslint-disable-next-line no-console */ console.log("[Notice]", msg); } setMessage(m) { this.message = m; } hide() {} }
class TAbstractFile { constructor() { this.path = ""; this.name = ""; this.parent = null; } }
class TFile extends TAbstractFile { constructor() { super(); this.extension = "md"; this.stat = { ctime: 0, mtime: 0, size: 0 }; } }
class TFolder extends TAbstractFile { constructor() { super(); this.children = []; } isRoot() { return this.path === ""; } }
class WorkspaceLeaf { constructor(app) { this.app = app; } updateHeader() {} setViewState() { return Promise.resolve(); } getViewState() { return {}; } }
class Menu {
  constructor() { this.items = []; }
  addItem(cb) { const it = { setTitle: () => it, setIcon: () => it, setChecked: () => it, setDisabled: () => it, onClick: () => it, setSection: () => it }; cb && cb(it); this.items.push(it); return this; }
  addSeparator() { return this; }
  showAtMouseEvent() {} showAtPosition() {} hide() {}
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = document.createElement("div"); this.titleEl = document.createElement("div"); this.modalEl = document.createElement("div"); }
  // Real Obsidian nests titleEl + contentEl inside modalEl; mirror that so a
  // modal's controls (e.g. the prompt's input) actually land in the document.
  open() { this.modalEl.append(this.titleEl, this.contentEl); document.body.appendChild(this.modalEl); this.onOpen && this.onOpen(); }
  close() { this.onClose && this.onClose(); this.modalEl.remove(); }
}
class DropdownComponent {
  constructor(containerEl) { this.selectEl = document.createElement("select"); if (containerEl) containerEl.appendChild(this.selectEl); }
  addOption() { return this; } addOptions() { return this; }
  setValue(v) { this.value = v; return this; } getValue() { return this.value; }
  onChange() { return this; } setDisabled() { return this; }
}
class ButtonComponent {
  constructor(containerEl) { this.buttonEl = document.createElement("button"); if (containerEl) containerEl.appendChild(this.buttonEl); }
  setIcon() { return this; } setTooltip() { return this; } setButtonText() { return this; }
  onClick() { return this; } setDisabled() { return this; } setCta() { return this; } setWarning() { return this; }
}
class Setting {
  constructor(containerEl) { this.settingEl = document.createElement("div"); if (containerEl) containerEl.appendChild(this.settingEl); }
  setName() { return this; } setDesc() { return this; } setHeading() { return this; }
  addText(cb) { cb && cb({ setPlaceholder: () => ({ setValue: () => ({ onChange: () => ({}) }) }), setValue: () => ({ onChange: () => ({}) }), inputEl: document.createElement("input") }); return this; }
  addToggle(cb) { cb && cb({ setValue: () => ({ onChange: () => ({}) }) }); return this; }
  addDropdown(cb) { cb && cb(new DropdownComponent(this.settingEl)); return this; }
  addButton(cb) { cb && cb(new ButtonComponent(this.settingEl)); return this; }
}
function debounce(fn) { const g = (...a) => (fn ? fn(...a) : undefined); g.cancel = () => {}; g.run = () => {}; return g; }
const setIcon = (el, name) => { if (el) el.setAttribute("data-icon", name); };
async function requestUrl() { return { status: 200, json: {}, text: "", arrayBuffer: new ArrayBuffer(0) }; }
const Platform = { isDesktopApp: false, isMobileApp: true, isMobile: true, isPhone: true, isTablet: false, isIosApp: true, isAndroidApp: false };

const obsidian = {
  Plugin, Component, ItemView, PluginSettingTab, FileSystemAdapter, Notice, Menu, Modal,
  TAbstractFile, TFile, TFolder, WorkspaceLeaf, DropdownComponent, ButtonComponent, Setting,
  Platform, parseYaml, normalizePath, debounce, setIcon, requestUrl,
};

// ---- in-memory vault -------------------------------------------------------
function makeApp() {
  const files = new Map(); // path -> string
  const folders = new Set([""]);
  const listeners = []; // {type, cb}
  const mk = (Cls, p) => { const f = new Cls(); f.path = normalizePath(p); f.name = baseName(p); return f; };
  const addAncestors = (p) => { let cur = parentPath(p); while (cur && !folders.has(cur)) { folders.add(cur); cur = parentPath(cur); } };
  const childrenOf = (p) => {
    const out = [];
    for (const fp of folders) if (fp !== "" && fp !== p && parentPath(fp) === p) out.push(mkFolder(fp));
    for (const fp of files.keys()) if (parentPath(fp) === p) out.push(mk(TFile, fp));
    return out;
  };
  function mkFolder(p) { const f = mk(TFolder, p); f.children = childrenOf(normalizePath(p)); return f; }

  const getAbstractFileByPath = (path) => {
    const p = normalizePath(path);
    if (files.has(p)) return mk(TFile, p);
    if (folders.has(p)) return mkFolder(p);
    return null;
  };
  const fire = (type, ...a) => { for (const l of listeners) if (l.type === type) l.cb(...a); };

  const adapter = {
    async exists(p) { p = normalizePath(p); return files.has(p) || folders.has(p); },
    async read(p) { p = normalizePath(p); if (!files.has(p)) throw new Error("ENOENT " + p); return files.get(p); },
    async write(p, d) { p = normalizePath(p); addAncestors(p); files.set(p, d); },
    async remove(p) { files.delete(normalizePath(p)); },
    async mkdir(p) { p = normalizePath(p); folders.add(p); addAncestors(p); },
    async rmdir(p) { p = normalizePath(p); for (const k of [...files.keys()]) if (k === p || k.startsWith(p + "/")) files.delete(k); for (const k of [...folders]) if (k === p || k.startsWith(p + "/")) folders.delete(k); },
    async list(p) { p = normalizePath(p); const out = { files: [], folders: [] }; for (const c of childrenOf(p)) (c instanceof TFolder ? out.folders : out.files).push(c.path); return out; },
  };

  const vault = {
    adapter,
    getAbstractFileByPath,
    getRoot: () => mkFolder(""),
    getFiles: () => [...files.keys()].map((p) => mk(TFile, p)),
    getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map((p) => mk(TFile, p)),
    async read(file) { const p = normalizePath(file.path); if (!files.has(p)) throw new Error("ENOENT " + p); return files.get(p); },
    async cachedRead(file) { return this.read(file); },
    async create(p, data) { p = normalizePath(p); addAncestors(p); files.set(p, data); const f = mk(TFile, p); fire("create", f); return f; },
    async modify(file, data) { files.set(normalizePath(file.path), data); fire("modify", file); },
    async delete(file) { return this._trash(file); },
    async trash(file) { return this._trash(file); },
    _trash(file) {
      const p = normalizePath(file.path);
      if (files.has(p)) { files.delete(p); fire("delete", file); return; }
      for (const k of [...files.keys()]) if (k === p || k.startsWith(p + "/")) files.delete(k);
      for (const k of [...folders]) if (k === p || k.startsWith(p + "/")) folders.delete(k);
      fire("delete", file);
    },
    async createFolder(p) { p = normalizePath(p); folders.add(p); addAncestors(p); return mkFolder(p); },
    on(type, cb) { const ref = { type, cb }; listeners.push(ref); return ref; },
    offref(ref) { const i = listeners.indexOf(ref); if (i >= 0) listeners.splice(i, 1); },
  };

  const fileManager = {
    async trashFile(file) { return vault._trash(file); },
    async renameFile(file, newPath) {
      const from = normalizePath(file.path), to = normalizePath(newPath);
      if (files.has(from)) { files.set(to, files.get(from)); files.delete(from); addAncestors(to); fire("rename", mk(TFile, to), from); return; }
      // folder rename: move every descendant
      const move = (k) => to + k.slice(from.length);
      for (const k of [...files.keys()]) if (k === from || k.startsWith(from + "/")) { files.set(move(k), files.get(k)); files.delete(k); }
      for (const k of [...folders]) if (k === from || k.startsWith(from + "/")) { folders.delete(k); folders.add(move(k)); }
      folders.add(to); addAncestors(to); fire("rename", mkFolder(to), from);
    },
    generateMarkdownLink: (file) => `[[${file.path}]]`,
  };

  let active = null;
  const workspace = {
    on: () => ({}),
    getActiveViewOfType: (Ctor) => (active && active instanceof Ctor ? active : null),
    getLeavesOfType: () => (active ? [active.leaf] : []),
    getLeaf: () => new WorkspaceLeaf(app),
    revealLeaf: () => {},
    setActiveLeaf: () => {},
    async openLinkText() {},
    getActiveFile: () => null,
    __setActive: (v) => { active = v; },
  };

  const app = { vault, fileManager, workspace, metadataCache: { on: () => ({}), getFileCache: () => null }, keymap: {}, scope: {} };
  // expose store for assertions/debugging
  app.__store = { files, folders };
  return app;
}

installDomHelpers();
// eslint-disable-next-line no-undef
window.__OBSIDIAN__ = obsidian;
// eslint-disable-next-line no-undef
window.__makeApp = makeApp;
