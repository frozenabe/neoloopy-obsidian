/**
 * NativeEngine — the default, fully-open-source TypeScript implementation of the
 * qualitative neoloopy surface, working directly on vault files through a
 * `VaultStorage`. It reuses the Phase-2 engine modules (codec, loop graph,
 * layout, exporters, signature) so reads/writes are byte-compatible with the
 * Dart CLI/app and the Python bridge. No `obsidian` import — unit-testable in
 * plain Node against `MemoryStorage`.
 *
 * Vault conventions mirrored from `core/lib/vault/desktop_vault_storage.dart`
 * and `core/lib/cli/vault_engine.dart`:
 *   - variable note file = `Nodes/<id>.md`, id = `var_` + 8 hex. Legacy vaults
 *     wrote `<id>.md` flat at the model root; those are still read (a `Nodes/`
 *     copy wins on a duplicate id) and swept into `Nodes/` when next written.
 *   - loop notes live in the model's `Loops/<slug>.md` files (see below).
 *   - model folder name = slug(name) (`-2`, `-3` … on collision), `model.json`
 *     manifest pretty-printed (2-space indent)
 *   - `System.md` / `Futures.md` / `CLA.md` are not variables
 *   - discovery: any folder with a `model.json` is a model and is NOT recursed
 *     into, so a model's own `Nodes/`/`Loops/` subfolders are never mistaken for
 *     nested models; grouped/nested model folders elsewhere are still found.
 */

import {
  BuildSpec,
  ExportFormat,
  GraphView,
  LinkInit,
  LinkPatch,
  ModelRef,
  NeoloopyEngine,
  NewVariable,
  QuantPatch,
  VariablePatch,
} from "./engine";
import {
  ModelManifest,
  VariableFile,
  VaultLink,
  Viewport,
  emptyVariable,
  manifestFromJson,
  manifestToJson,
  normalizeBasis,
  normalizeConfidence,
} from "./types";
import { LoopGraph, labelLoopsByKey } from "./loopGraph";
import { YamlParse, parseNote, serializeNote } from "./noteCodec";
import { noteSlug, noteUnslug } from "./noteNaming";
import {
  LoopNote,
  canonicalLoopMembers,
  loopMatchesNote,
  loopSlug,
  parseLoopNote,
  serializeLoopNote,
} from "./loopNote";
import { contentSignature, stampMeta, WRITE_SOURCE_PLUGIN } from "./specHash";
import { loopKey } from "./loopKey";
import { autoLayout } from "./layout";
import {
  ExportEdge,
  ExportLoop,
  ExportNode,
  Rendered,
  render,
} from "./exporters";
import { DetectedLoop, LoopType } from "./types";
import {
  VaultStorage,
  baseName,
  joinPath,
  parentPath,
} from "./storage";
import { ParentAnchor, deriveParentAnchors } from "./subsystemLinks";

/** Non-variable notes that share a model folder. */
const SPECIAL_NOTES = new Set(["System.md", "Futures.md", "CLA.md"]);

const MAX_SCAN_DEPTH = 12;

export interface NativeEngineOptions {
  /** Vault-relative base folder for newly created models (may be ""). */
  modelsRoot: string;
}

export class NativeEngine implements NeoloopyEngine {
  constructor(
    private readonly storage: VaultStorage,
    private readonly yaml: YamlParse,
    private readonly opts: NativeEngineOptions,
  ) {}

  // ---- discovery / listing -------------------------------------------------

  async listModels(): Promise<ModelRef[]> {
    const folders = await this.findModelFolders();
    const refs: ModelRef[] = [];
    for (const folder of folders) {
      try {
        const manifest = await this.readManifest(folder);
        const notes = await this.listNoteFiles(folder);
        refs.push({
          id: manifest.id,
          name: manifest.name,
          folder,
          group: manifest.folder ?? null,
          modified: manifest.modified,
          variableCount: notes.length,
          quant: manifestIsQuant(manifest),
        });
      } catch {
        // Unreadable/partial model folder — skip rather than fail the whole list.
      }
    }
    refs.sort((a, b) => a.name.localeCompare(b.name));
    return refs;
  }

  async loadGraph(folder: string): Promise<GraphView> {
    const manifest = await this.readManifest(folder);
    const nodes = await this.loadNotes(folder);
    const graph = new LoopGraph(nodes);
    const loops = graph.detectLoops();
    const labels = labelLoopsByKey(loops, (id) => graph.node(id)?.label ?? id);
    const quant =
      manifestIsQuant(manifest) || nodes.some((n) => "quant" in n.extra);
    return { folder, manifest, nodes, loops, labels, quant };
  }

  // ---- model lifecycle -----------------------------------------------------

  async createModel(name: string): Promise<ModelRef> {
    const modelId = genModelId();
    const leaf = slug(name) || modelId;
    let folder = joinPath(this.opts.modelsRoot, leaf);
    let n = 2;
    while (await this.storage.exists(folder)) {
      folder = joinPath(this.opts.modelsRoot, `${leaf}-${n}`);
      n++;
    }
    await this.storage.mkdirs(folder);
    const now = new Date().toISOString();
    const manifest: ModelManifest = {
      id: modelId,
      name,
      schemaVersion: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      created: now,
      modified: now,
      order: 0,
      extra: {},
    };
    await this.writeManifest(folder, manifest);
    return { id: modelId, name, folder, group: null, modified: now, variableCount: 0, quant: false };
  }

  async renameModel(folder: string, name: string): Promise<ModelRef> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new Error("Model title cannot be empty.");
    }
    const manifest = await this.readManifest(folder);

    // Keep the folder name in sync with the title, using the same slug rule and
    // `-2/-3…` collision suffixing as createModel. Renaming the leaf within the
    // model's current parent dir preserves any folder organization. Skip the move
    // when the slug is unchanged (e.g. punctuation-only edits) so we don't churn
    // paths — and so we never collide the folder with itself.
    const dest = await this.destForRename(folder, trimmed);

    // Write the new title into model.json first (at the current path), then move
    // the folder so links settle around the final location.
    const updated: ModelManifest = {
      ...manifest,
      name: trimmed,
      modified: new Date().toISOString(),
    };
    await this.writeManifest(folder, updated);
    if (dest !== folder) {
      await this.storage.move(folder, dest);
    }

    const notes = await this.listNoteFiles(dest);
    return {
      id: updated.id,
      name: updated.name,
      folder: dest,
      group: updated.folder ?? null,
      modified: updated.modified,
      variableCount: notes.length,
      quant: manifestIsQuant(updated),
    };
  }

  async retitleModel(folder: string, name: string): Promise<ModelRef> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new Error("Model title cannot be empty.");
    }
    // The inverse of renameModel: the folder is already where the user put it
    // (e.g. they renamed it in Obsidian's file explorer), so the title follows
    // the folder. Write the new name into model.json in place — never re-slug or
    // move the directory, or we'd fight the rename the user just made.
    const manifest = await this.readManifest(folder);
    const updated: ModelManifest = {
      ...manifest,
      name: trimmed,
      modified: new Date().toISOString(),
    };
    await this.writeManifest(folder, updated);

    const notes = await this.listNoteFiles(folder);
    return {
      id: updated.id,
      name: updated.name,
      folder,
      group: updated.folder ?? null,
      modified: updated.modified,
      variableCount: notes.length,
      quant: manifestIsQuant(updated),
    };
  }

  /**
   * Sync a node's label to its filename after the user renamed the file in the
   * vault (`Nodes/<stem>.md`). The node-level inverse of {@link retitleModel}:
   * the file is already where the user put it, so the label follows it (the
   * de-slugged stem, underscores → spaces). {@link writeNote} may then
   * re-normalize the on-disk name (spaces → underscores) so it converges. The
   * stable `var_…` id and every link to it are untouched, so links never break.
   */
  async relabelNodeFromFilename(folder: string, fileStem: string): Promise<void> {
    let prev: VariableFile;
    try {
      const raw = await this.storage.read(this.notePath(folder, fileStem));
      prev = parseNote(raw, this.yaml, fileStem);
    } catch {
      return; // file vanished or unreadable between rename and handler — nothing to sync
    }
    const label = noteUnslug(fileStem);
    if (label.length === 0 || label === prev.label) return;
    await this.writeNote(folder, prev, { ...prev, label });
    await this.touchManifest(folder);
  }

  /** Target folder for renaming `folder`'s model to `name`: the new slug under
   *  the same parent, suffixed on collision; unchanged when the slug matches. */
  private async destForRename(folder: string, name: string): Promise<string> {
    const current = baseName(folder);
    const desired = slug(name) || current;
    if (desired === current) return folder;
    const parent = parentPath(folder);
    let leaf = desired;
    let n = 2;
    while (await this.storage.exists(joinPath(parent, leaf))) {
      leaf = `${desired}-${n}`;
      n++;
    }
    return joinPath(parent, leaf);
  }

  async deleteModel(folder: string): Promise<void> {
    await this.storage.rmdir(folder);
  }

  /** Resolve a folder to its model id (read from `model.json`). */
  async modelId(folder: string): Promise<string> {
    return (await this.readManifest(folder)).id;
  }

  // ---- variables -----------------------------------------------------------

  async addVariable(folder: string, init: NewVariable): Promise<VariableFile> {
    const vf: VariableFile = {
      ...emptyVariable(genVarId(), init.label),
      type: init.type ?? "auxiliary",
      group: init.group,
      shared: init.shared,
      claLayer: init.claLayer,
      x: init.x ?? 0,
      y: init.y ?? 0,
    };
    const out = await this.writeNote(folder, undefined, vf);
    await this.touchManifest(folder);
    return out;
  }

  async updateVariable(
    folder: string,
    id: string,
    patch: VariablePatch,
  ): Promise<VariableFile> {
    const prev = await this.readNote(folder, id);
    const next: VariableFile = { ...prev };
    if (patch.label !== undefined) next.label = patch.label;
    if (patch.type !== undefined) next.type = patch.type;
    if (patch.group !== undefined) next.group = patch.group ?? undefined;
    if (patch.shared !== undefined) next.shared = patch.shared ?? undefined;
    if (patch.claLayer !== undefined) next.claLayer = patch.claLayer ?? undefined;
    if (patch.status !== undefined) next.status = patch.status ?? undefined;
    if (patch.tags !== undefined) next.tags = [...patch.tags];
    if (patch.body !== undefined) next.body = patch.body;
    const out = await this.writeNote(folder, prev, next);
    await this.touchManifest(folder);
    return out;
  }

  async setEquation(
    folder: string,
    id: string,
    patch: QuantPatch,
  ): Promise<VariableFile> {
    const prev = await this.readNote(folder, id);
    const prevQuant =
      prev.extra["quant"] && typeof prev.extra["quant"] === "object"
        ? (prev.extra["quant"] as Record<string, unknown>)
        : {};
    const quant: Record<string, unknown> = { ...prevQuant };
    // A provided field with a value sets it; an empty/blank value clears it;
    // `undefined` leaves it as-is.
    for (const key of ["equation", "initial", "units"] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      const trimmed = v.trim();
      if (trimmed.length === 0) delete quant[key];
      else quant[key] = trimmed;
    }
    const extra = { ...prev.extra };
    if (Object.keys(quant).length === 0) delete extra["quant"];
    else extra["quant"] = quant;
    const out = await this.writeNote(folder, prev, { ...prev, extra });
    await this.touchManifest(folder);
    return out;
  }

  async setSubsystem(
    folder: string,
    varId: string,
    child: { folder: string; name: string } | null,
  ): Promise<void> {
    const prev = await this.readNote(folder, varId);
    // Match the app/CLI exactly: a relative wikilink to the child's System note,
    // keyed on the child folder basename, aliased to the child's display name.
    const dir = child ? child.folder.split("/").filter(Boolean).pop() ?? child.folder : "";
    const link = child ? `[[../${dir}/System|${child.name}]]` : undefined;
    await this.writeNote(folder, prev, { ...prev, subsystem: link });
    await this.touchManifest(folder);
  }

  async moveVariable(
    folder: string,
    id: string,
    x: number,
    y: number,
  ): Promise<void> {
    const prev = await this.readNote(folder, id);
    // stampMeta treats an x/y-only change as cosmetic → rev/modified preserved.
    await this.writeNote(folder, prev, { ...prev, x, y });
  }

  async removeVariable(folder: string, id: string): Promise<void> {
    // The note is named by its label now, so resolve its real path by id; also
    // clear any stale id-named copies (a legacy flat note or an old Nodes/<id>.md).
    const resolved = (await this.noteFilesById(folder)).get(id);
    if (resolved) await this.storage.remove(resolved);
    for (const p of [this.notePath(folder, id), this.legacyNotePath(folder, id)]) {
      if (p !== resolved) await this.storage.remove(p);
    }
    // Drop inbound links so loop detection and the manifest stay consistent.
    const notes = await this.loadNotes(folder);
    for (const n of notes) {
      if (n.links.some((l) => l.to === id)) {
        await this.writeNote(folder, n, {
          ...n,
          links: n.links.filter((l) => l.to !== id),
        });
      }
    }
    await this.touchManifest(folder);
  }

  // ---- links ---------------------------------------------------------------

  async addLink(
    folder: string,
    from: string,
    to: string,
    init: LinkInit = {},
  ): Promise<void> {
    const prev = await this.readNote(folder, from);
    const links = prev.links.filter((l) => l.to !== to);
    links.push(makeLink(to, init));
    await this.writeNote(folder, prev, { ...prev, links });
    await this.touchManifest(folder);
  }

  async updateLink(
    folder: string,
    from: string,
    to: string,
    patch: LinkPatch,
  ): Promise<void> {
    const prev = await this.readNote(folder, from);
    const links = prev.links.map((l) =>
      l.to === to ? applyLinkPatch(l, patch) : l,
    );
    await this.writeNote(folder, prev, { ...prev, links });
    await this.touchManifest(folder);
  }

  async removeLink(folder: string, from: string, to: string): Promise<void> {
    const prev = await this.readNote(folder, from);
    await this.writeNote(folder, prev, {
      ...prev,
      links: prev.links.filter((l) => l.to !== to),
    });
    await this.touchManifest(folder);
  }

  // ---- bulk build / layout / viewport --------------------------------------

  async buildModel(folder: string, spec: BuildSpec): Promise<void> {
    const idByRef = new Map<string, string>();
    const created: VariableFile[] = [];
    for (const v of spec.variables) {
      const id = v.id && v.id.trim() ? v.id.trim() : genVarId();
      created.push({
        ...emptyVariable(id, v.label),
        type: v.type ?? "auxiliary",
        group: v.group,
        shared: v.shared,
      });
      idByRef.set(v.label, id);
      idByRef.set(id, id);
    }
    const resolve = (ref: string): string => idByRef.get(ref) ?? ref;
    const byId = new Map(created.map((v) => [v.id, v]));
    for (const lk of spec.links) {
      const src = byId.get(resolve(lk.from));
      if (!src) continue; // link from an unknown source — skip
      src.links = src.links.filter((l) => l.to !== resolve(lk.to));
      src.links.push(makeLink(resolve(lk.to), lk));
    }
    if (spec.layout !== false) applyLayout(created);
    for (const v of created) await this.writeNote(folder, undefined, v);
    await this.touchManifest(folder);
  }

  async relayout(folder: string): Promise<void> {
    const notes = await this.loadNotes(folder);
    const pos = layoutPositions(notes);
    for (const n of notes) {
      const p = pos.get(n.id);
      if (p) await this.writeNote(folder, n, { ...n, x: p[0], y: p[1] });
    }
  }

  async setViewport(folder: string, viewport: Viewport): Promise<void> {
    const manifest = await this.readManifest(folder);
    // Viewport is cosmetic — write the manifest without touching `modified`.
    await this.writeManifest(folder, { ...manifest, viewport });
  }

  // ---- loop notes (Loops/*.md — Obsidian-native, shared with the Dart app) --
  //
  // Each feedback loop's annotation is one `Loops/<slug>.md` file whose identity
  // is the loop's (type, canonical-ordered member ids) in frontmatter — never the
  // filename or the labels. The legacy `model.json` maps (loopNotes/loopTitles/
  // loopValence/loopArchetypes) are auto-migrated to files on first touch. This
  // mirrors `core/lib/cli/vault_engine.dart` so the plugin and the app/CLI agree
  // on one vault. Resolved maps stay keyed by the legacy `<R|B>:<sorted labels>`
  // key (see `loopKey`) so existing UI consumers are unchanged.

  async getLoopNotes(folder: string): Promise<Record<string, string>> {
    await this.migrateLoopNotesIfNeeded(folder);
    const files = await this.listLoopNoteFiles(folder);
    if (files.length === 0) {
      // Pre-migration fallback: no Loops/ files → serve the manifest map.
      const manifest = await this.readManifest(folder);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(readLoopNotes(manifest))) {
        if (v.trim().length > 0) out[k] = v;
      }
      return out;
    }
    const graph = new LoopGraph(await this.loadNotes(folder));
    const nameOf = (id: string): string => graph.node(id)?.label ?? id;
    const out: Record<string, string> = {};
    const matched = new Set<string>();
    for (const l of graph.detectLoops()) {
      const type = l.type === LoopType.reinforcing ? "R" : "B";
      let note: LoopNote | undefined;
      for (const f of files) {
        if (matched.has(f)) continue;
        const parsed = parseLoopNote((await this.readLoopNoteFile(folder, f)) ?? "", this.yaml);
        if (loopMatchesNote(type, l.nodeIds, parsed)) {
          matched.add(f);
          note = parsed;
          break;
        }
      }
      if (!note) continue;
      if (note.body.trim().length > 0) {
        out[loopKey(l.nodeIds.map(nameOf), type)] = note.body;
      }
    }
    return out;
  }

  async setLoopNote(folder: string, key: string, text: string): Promise<void> {
    await this.upsertLoopFileByKey(folder, key, { note: text });
  }

  /**
   * The vault-relative path of the canonical `Loops/*.md` file for `key`,
   * creating an empty-but-anchored note if none exists yet. Returns null when no
   * live loop carries that key (e.g. the graph changed). Used by the canvas to
   * open the real markdown file for editing.
   */
  async loopNotePath(folder: string, key: string): Promise<string | null> {
    await this.migrateLoopNotesIfNeeded(folder);
    const graph = new LoopGraph(await this.loadNotes(folder));
    const nameOf = (id: string): string => graph.node(id)?.label ?? id;
    for (const l of graph.detectLoops()) {
      const type = l.type === LoopType.reinforcing ? "R" : "B";
      const memberLabels = l.nodeIds.map(nameOf);
      if (loopKey(memberLabels, type) !== key) continue;
      for (const f of await this.listLoopNoteFiles(folder)) {
        const parsed = parseLoopNote((await this.readLoopNoteFile(folder, f)) ?? "", this.yaml);
        if (loopMatchesNote(type, l.nodeIds, parsed)) {
          return joinPath(this.loopsDir(folder), f);
        }
      }
      const file = await this.writeLoopFile(folder, l.nodeIds, type, memberLabels, {});
      return joinPath(this.loopsDir(folder), file);
    }
    return null;
  }

  async ensureSystemNote(folder: string): Promise<string> {
    const path = joinPath(folder, "System.md");
    if (!(await this.storage.exists(path))) {
      const manifest = await this.readManifest(folder);
      // Minimal valid System note — frontmatter only. Mirrors the required half
      // of core/lib/vault/system_note.dart (model id); `h`/summary/body are
      // optional and stamped by the app on its next write.
      await this.storage.write(path, `---\nmodel: ${JSON.stringify(manifest.id)}\n---\n`);
    }
    return path;
  }

  async deriveParents(folder: string): Promise<ParentAnchor[]> {
    const models = await this.listModels();
    const current = models.find((m) => m.folder === folder);
    if (!current) return [];
    return deriveParentAnchors(
      { folder: current.folder, name: current.name },
      models.filter((m) => m.folder !== folder).map((m) => ({ folder: m.folder, name: m.name })),
      (f) => this.loadNotes(f),
    );
  }

  // ---- export --------------------------------------------------------------

  async export(folder: string, format: ExportFormat): Promise<Rendered> {
    const view = await this.loadGraph(folder);
    const { nodes, edges, loops } = toExportGraph(view);
    return render(format, view.manifest.id, view.manifest.name, nodes, edges, loops);
  }

  // ---- internals -----------------------------------------------------------

  /** The model's `Nodes/` subfolder, where variable notes now live. */
  private nodesDir(folder: string): string {
    return joinPath(folder, "Nodes");
  }

  /** A variable note's path for a filename stem: `<folder>/Nodes/<stem>.md`. */
  private notePath(folder: string, stem: string): string {
    return joinPath(this.nodesDir(folder), `${stem}.md`);
  }

  /** Pre-`Nodes/` location of a variable note, flat at the model root. */
  private legacyNotePath(folder: string, stem: string): string {
    return joinPath(folder, `${stem}.md`);
  }

  private async readNote(folder: string, id: string): Promise<VariableFile> {
    // The filename tracks the label, so resolve by frontmatter id. Fall back to
    // the canonical id-named path for an id that isn't on disk yet.
    const path = (await this.noteFilesById(folder)).get(id) ?? this.notePath(folder, id);
    return parseNote(await this.storage.read(path), this.yaml, id);
  }

  private async writeNote(
    folder: string,
    prev: VariableFile | undefined,
    next: VariableFile,
  ): Promise<VariableFile> {
    const stamped = stampMeta(prev, next, WRITE_SOURCE_PLUGIN);

    // The file is named after the label (so the vault reads like the diagram);
    // a label-less node falls back to its stable id. Dedupe against the names
    // already taken by *other* notes, suffixing `-2/-3…` like model folders.
    const byId = await this.noteFilesById(folder);
    const currentPath = byId.get(stamped.id);
    const desired = noteSlug(stamped.label) || stamped.id;
    const taken = new Set<string>();
    for (const [otherId, p] of byId) {
      if (otherId !== stamped.id) taken.add(baseName(p).replace(/\.md$/, ""));
    }
    let stem = desired;
    let n = 2;
    while (taken.has(stem)) stem = `${desired}-${n++}`;
    const target = this.notePath(folder, stem);

    await this.storage.write(target, serializeNote(stamped));
    // Migrate on write: drop the node's previous file if its name changed (an
    // id-named or differently-labelled copy), plus any legacy flat copy.
    if (currentPath && currentPath !== target) {
      await this.storage.remove(currentPath);
    }
    const legacy = this.legacyNotePath(folder, stamped.id);
    if (legacy !== target && legacy !== currentPath && (await this.storage.exists(legacy))) {
      await this.storage.remove(legacy);
    }
    return stamped;
  }

  private async readManifest(folder: string): Promise<ModelManifest> {
    const raw = await this.storage.read(joinPath(folder, "model.json"));
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j["id"] === undefined || j["id"] === null) j["id"] = baseName(folder);
    return manifestFromJson(j);
  }

  private async writeManifest(
    folder: string,
    manifest: ModelManifest,
  ): Promise<void> {
    await this.storage.write(
      joinPath(folder, "model.json"),
      JSON.stringify(manifestToJson(manifest), null, 2),
    );
  }

  /** Bump `model.json` modified after a content change. */
  private async touchManifest(folder: string): Promise<void> {
    try {
      const manifest = await this.readManifest(folder);
      await this.writeManifest(folder, {
        ...manifest,
        modified: new Date().toISOString(),
      });
    } catch {
      // No manifest yet (mid-build) — ignore.
    }
  }

  /**
   * Variable-note id → vault path, gathered from the model's `Nodes/` subfolder
   * and any legacy flat notes at the model root. A `Nodes/` note wins on a
   * duplicate id (mirrors the Dart reader). `model.json` and the special notes
   * (System/Futures/CLA) are excluded.
   */
  private async noteFilesById(folder: string): Promise<Map<string, string>> {
    const byId = new Map<string, string>();
    const collect = async (files: string[], excludeSpecial: boolean): Promise<void> => {
      for (const f of files) {
        const b = baseName(f);
        if (!b.endsWith(".md")) continue;
        if (excludeSpecial && SPECIAL_NOTES.has(b)) continue;
        // The filename no longer is the id — read it from the frontmatter
        // (falling back to the filename stem for a note that lacks one).
        const id = parseNote(await this.storage.read(f), this.yaml, b.replace(/\.md$/, "")).id;
        byId.set(id, f);
      }
    };
    // Legacy flat notes first, then let canonical `Nodes/` notes override.
    await collect((await this.storage.list(folder)).files, true);
    try {
      await collect((await this.storage.list(this.nodesDir(folder))).files, false);
    } catch {
      // No `Nodes/` subfolder — flat-only (legacy) layout.
    }
    return byId;
  }

  private async listNoteFiles(folder: string): Promise<string[]> {
    return [...(await this.noteFilesById(folder)).values()];
  }

  private async loadNotes(folder: string): Promise<VariableFile[]> {
    const byId = new Map<string, VariableFile>();
    const collect = async (
      files: string[],
      excludeSpecial: boolean,
      canonical: boolean,
    ): Promise<void> => {
      for (const f of files) {
        const b = baseName(f);
        if (!b.endsWith(".md")) continue;
        if (excludeSpecial && SPECIAL_NOTES.has(b)) continue;
        const file = parseNote(await this.storage.read(f), this.yaml, b.replace(/\.md$/, ""));
        // Canonical `Nodes/` notes override a legacy flat note with the same id.
        if (canonical || !byId.has(file.id)) byId.set(file.id, file);
      }
    };
    await collect((await this.storage.list(folder)).files, true, false);
    try {
      await collect((await this.storage.list(this.nodesDir(folder))).files, false, true);
    } catch {
      // No `Nodes/` subfolder — flat-only (legacy) layout.
    }
    return [...byId.values()];
  }

  // ---- loop-note file storage (the model's `Loops/` subfolder) -------------

  private loopsDir(folder: string): string {
    return joinPath(folder, "Loops");
  }

  /** Sorted `.md` basenames in `Loops/`; tolerant of a missing folder. */
  private async listLoopNoteFiles(folder: string): Promise<string[]> {
    let listing;
    try {
      listing = await this.storage.list(this.loopsDir(folder));
    } catch {
      return [];
    }
    return listing.files
      .map(baseName)
      .filter((b) => b.endsWith(".md"))
      .sort();
  }

  private async readLoopNoteFile(folder: string, filename: string): Promise<string | null> {
    try {
      return await this.storage.read(joinPath(this.loopsDir(folder), filename));
    } catch {
      return null;
    }
  }

  private async writeLoopNoteFile(
    folder: string,
    filename: string,
    content: string,
  ): Promise<void> {
    await this.storage.write(joinPath(this.loopsDir(folder), filename), content);
  }

  private async uniqueLoopFilename(folder: string, slug: string): Promise<string> {
    const taken = new Set(await this.listLoopNoteFiles(folder));
    let name = `${slug}.md`;
    let n = 2;
    while (taken.has(name)) {
      name = `${slug}-${n}.md`;
      n++;
    }
    return name;
  }

  /**
   * One-way, idempotent migration of legacy loop annotations from the
   * `model.json` maps into `Loops/*.md` files. Guard: if any `Loops/` file
   * exists the model is treated as migrated and this returns immediately. Each
   * legacy key is matched to a live loop by its `loopKey`; a matched key keeps
   * the loop's canonical member ids, an unmatched key becomes a pre-flagged
   * orphan (`members: []`, original key kept in `loop:`) so nothing is lost.
   * After writing, the four legacy keys are stripped from the manifest.
   */
  private async migrateLoopNotesIfNeeded(folder: string): Promise<void> {
    if ((await this.listLoopNoteFiles(folder)).length > 0) return;
    const manifest = await this.readManifest(folder);
    const fields = ["loopNotes", "loopTitles", "loopValence", "loopArchetypes"];
    const mapOf = (f: string): Record<string, string> => {
      const m = manifest.extra[f];
      const out: Record<string, string> = {};
      if (m && typeof m === "object" && !Array.isArray(m)) {
        for (const [k, v] of Object.entries(m as Record<string, unknown>)) out[k] = String(v);
      }
      return out;
    };
    const hasLegacy = fields.some((f) => Object.keys(mapOf(f)).length > 0);
    if (!hasLegacy) return;

    const notes = mapOf("loopNotes");
    const titles = mapOf("loopTitles");
    const valence = mapOf("loopValence");
    const archetypes = mapOf("loopArchetypes");
    const allKeys = new Set<string>([
      ...Object.keys(notes),
      ...Object.keys(titles),
      ...Object.keys(valence),
      ...Object.keys(archetypes),
    ]);

    const graph = new LoopGraph(await this.loadNotes(folder));
    const nameOf = (id: string): string => graph.node(id)?.label ?? id;
    const liveByKey = new Map<string, DetectedLoop>();
    for (const l of graph.detectLoops()) {
      const type = l.type === LoopType.reinforcing ? "R" : "B";
      liveByKey.set(loopKey(l.nodeIds.map(nameOf), type), l);
    }

    for (const key of allKeys) {
      const type = key.startsWith("B") ? "B" : "R";
      const live = liveByKey.get(key);
      const members = live ? canonicalLoopMembers(live.nodeIds) : [];
      const labels = live
        ? live.nodeIds.map(nameOf)
        : key.includes(":")
          ? key.substring(key.indexOf(":") + 1).split("|")
          : [];
      const arch = archetypes[key] ?? "";
      const note: LoopNote = {
        type,
        members,
        title: titles[key] ?? "",
        valence: valence[key] ?? "",
        loopEcho: key,
        body: notes[key] ?? "",
        extra: arch.length > 0 ? { archetype: arch } : {},
        malformed: false,
      };
      const filename = await this.uniqueLoopFilename(folder, loopSlug(type, note.title, labels));
      await this.writeLoopNoteFile(folder, filename, serializeLoopNote(note));
    }

    const extra = { ...manifest.extra };
    for (const f of fields) delete extra[f];
    await this.writeManifest(folder, {
      ...manifest,
      extra,
      modified: new Date().toISOString(),
    });
  }

  /** Find the live loop whose `loopKey` == `key`, then upsert its file. No-op
   * (and no file) when the graph carries no such loop. */
  private async upsertLoopFileByKey(
    folder: string,
    key: string,
    fields: LoopFields,
  ): Promise<void> {
    await this.migrateLoopNotesIfNeeded(folder);
    const graph = new LoopGraph(await this.loadNotes(folder));
    const nameOf = (id: string): string => graph.node(id)?.label ?? id;
    for (const l of graph.detectLoops()) {
      const type = l.type === LoopType.reinforcing ? "R" : "B";
      const memberLabels = l.nodeIds.map(nameOf);
      if (loopKey(memberLabels, type) !== key) continue;
      await this.writeLoopFile(folder, l.nodeIds, type, memberLabels, fields);
      return;
    }
  }

  /** Find-or-create the identity-matched `Loops/` file and apply `fields`
   * (undefined leaves a field unchanged; `archetype: ""` clears it). Returns the
   * filename written. Title/valence/extra of an existing file are preserved. */
  private async writeLoopFile(
    folder: string,
    nodeIds: string[],
    type: string,
    memberLabels: string[],
    fields: LoopFields,
  ): Promise<string> {
    const members = canonicalLoopMembers(nodeIds);
    let filename: string | undefined;
    let existing: LoopNote = {
      type,
      members,
      title: "",
      valence: "",
      loopEcho: "",
      body: "",
      extra: {},
      malformed: false,
    };
    for (const f of await this.listLoopNoteFiles(folder)) {
      const parsed = parseLoopNote((await this.readLoopNoteFile(folder, f)) ?? "", this.yaml);
      if (loopMatchesNote(type, nodeIds, parsed)) {
        filename = f;
        existing = parsed;
        break;
      }
    }
    const extra = { ...existing.extra };
    if (fields.archetype !== undefined) {
      if (fields.archetype.trim().length === 0) delete extra["archetype"];
      else extra["archetype"] = fields.archetype.trim();
    }
    const next: LoopNote = {
      type,
      members,
      title: fields.title ?? existing.title,
      valence: fields.valence ?? existing.valence,
      loopEcho: loopKey(memberLabels, type),
      body: fields.note ?? existing.body,
      extra,
      malformed: false,
    };
    if (filename === undefined) {
      filename = await this.uniqueLoopFilename(folder, loopSlug(type, next.title, memberLabels));
    }
    await this.writeLoopNoteFile(folder, filename, serializeLoopNote(next));
    return filename;
  }

  /** Recursively find folders containing a `model.json` (dot-folders pruned). */
  private async findModelFolders(): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_SCAN_DEPTH) return;
      let listing;
      try {
        listing = await this.storage.list(dir);
      } catch {
        return;
      }
      if (listing.files.some((f) => baseName(f) === "model.json")) {
        out.push(dir);
        return; // Prune: a model's `Nodes/`/`Loops/` subfolders aren't models.
      }
      for (const sub of listing.folders) {
        if (baseName(sub).startsWith(".")) continue;
        await visit(sub, depth + 1);
      }
    };
    // Discover models across the WHOLE vault, not just `modelsRoot`. The latter
    // only governs where *new* models are created (createModel); existing
    // vaults — and the Dart app/CLI — write models at the vault top level too.
    await visit("", 0);
    return out;
  }
}

// ---- pure helpers ----------------------------------------------------------

function makeLink(to: string, init: LinkInit): VaultLink {
  return {
    to,
    polarity: init.polarity === "-" ? "-" : "+",
    delay: init.delay === true,
    indirect: init.indirect === true,
    nonlinear: init.nonlinear === true,
    weight: init.weight,
    curvature: init.curvature,
    confidence: normalizeConfidence(init.confidence),
    basis: normalizeBasis(init.basis),
  };
}

function applyLinkPatch(l: VaultLink, patch: LinkPatch): VaultLink {
  return {
    ...l,
    polarity: patch.polarity ?? l.polarity,
    delay: patch.delay ?? l.delay,
    indirect: patch.indirect ?? l.indirect,
    nonlinear: patch.nonlinear ?? l.nonlinear,
    weight: patch.weight !== undefined ? patch.weight : l.weight,
    curvature:
      patch.curvature === undefined
        ? l.curvature
        : patch.curvature === null
          ? undefined
          : patch.curvature,
    confidence:
      patch.confidence !== undefined
        ? normalizeConfidence(patch.confidence)
        : l.confidence,
    basis: patch.basis !== undefined ? normalizeBasis(patch.basis) : l.basis,
  };
}

function layoutPositions(notes: VariableFile[]): Map<string, [number, number]> {
  return autoLayout(
    notes.map((v) => ({ id: v.id, name: v.label, kind: v.type })),
    notes.flatMap((v) => v.links.map((l) => ({ source: v.id, target: l.to }))),
  );
}

function applyLayout(notes: VariableFile[]): void {
  const pos = layoutPositions(notes);
  for (const v of notes) {
    const p = pos.get(v.id);
    if (p) {
      v.x = p[0];
      v.y = p[1];
    }
  }
}

function toExportGraph(view: GraphView): {
  nodes: ExportNode[];
  edges: ExportEdge[];
  loops: ExportLoop[];
} {
  const nodes: ExportNode[] = view.nodes.map((n) => ({
    id: n.id,
    name: n.label,
    kind: n.type,
    x: n.x,
    y: n.y,
    group: n.group,
  }));
  const edges: ExportEdge[] = [];
  for (const n of view.nodes) {
    for (const l of n.links) {
      edges.push({
        id: `${n.id}__${l.to}`,
        source: n.id,
        target: l.to,
        polarity: l.polarity === "-" ? -1 : 1,
        delay: l.delay,
        curvature: l.curvature,
        dashed: l.indirect,
        weight: l.weight,
      });
    }
  }
  const nameById = new Map(view.nodes.map((n) => [n.id, n.label]));
  const loops: ExportLoop[] = view.loops.map((lp) => ({
    loop: lp.nodeIds.map((id) => nameById.get(id) ?? id),
    type: lp.type === LoopType.reinforcing ? "R (reinforcing)" : "B (balancing)",
    label: view.labels.get(lp.key),
  }));
  return { nodes, edges, loops };
}

/** Fields applied to a `Loops/*.md` file; `undefined` leaves a field unchanged. */
interface LoopFields {
  note?: string;
  title?: string;
  valence?: string;
  archetype?: string;
}

/** Re-exported from `./loopKey` so existing importers keep their path. */
export { loopKey } from "./loopKey";

/** Read the `loopNotes` string map out of a manifest's `extra` (defensive). */
function readLoopNotes(m: ModelManifest): Record<string, string> {
  const raw = m.extra["loopNotes"];
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

function manifestIsQuant(m: ModelManifest): boolean {
  const e = m.extra;
  return (
    e["quantitative"] === true ||
    e["quant"] === true ||
    e["mode"] === "quantitative" ||
    e["kind"] === "quantitative"
  );
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  // Web Crypto is exposed as the global `crypto` in both Obsidian (Electron)
  // and Node (this pure engine's vitest tests). Referenced bare — not via
  // `window`/`globalThis` — so it resolves under Node too; `typeof`-guarded so
  // it falls back to Math.random anywhere it is unavailable.
  const c: Crypto | undefined =
    typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  let s = "";
  for (const b of arr) s += b.toString(16).padStart(2, "0");
  return s;
}

function genVarId(): string {
  return `var_${randomHex(4)}`;
}

function genModelId(): string {
  const n = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const hex = n.toString(16);
  return `mdl_${hex.slice(-6)}`;
}

/** Re-export so callers don't need a second import for the signature helper. */
export { contentSignature };
