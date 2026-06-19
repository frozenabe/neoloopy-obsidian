/**
 * VaultStorage backed by Obsidian's `Vault` API (the preferred surface over the
 * lower-level `Vault.adapter`). This is the only storage implementation that
 * imports `obsidian`; the engine and the interface stay clean so they unit-test
 * in plain Node against `MemoryStorage`. The `Vault` API is itself
 * cross-platform, but the plugin currently ships `isDesktopOnly: true`: the
 * canvas UI isn't usable on mobile yet (see manifest.json).
 */

import { TFile, TFolder, normalizePath } from "obsidian";
import type { Vault, FileManager } from "obsidian";
import { DirListing, VaultStorage, parentPath } from "./storage";

export class ObsidianStorage implements VaultStorage {
  constructor(
    private readonly vault: Vault,
    private readonly fileManager: FileManager,
  ) {}

  async exists(path: string): Promise<boolean> {
    return this.vault.getAbstractFileByPath(normalizePath(path)) != null;
  }

  async read(path: string): Promise<string> {
    const f = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) throw new Error(`ENOENT: ${path}`);
    // Uncached read: callers read straight after writing and need fresh bytes.
    return this.vault.read(f);
  }

  async write(path: string, data: string): Promise<void> {
    await this.mkdirs(parentPath(path));
    const p = normalizePath(path);
    const f = this.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) {
      await this.vault.modify(f, data);
    } else {
      await this.vault.create(p, data);
    }
  }

  async remove(path: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(normalizePath(path));
    if (f) await this.fileManager.trashFile(f);
  }

  async mkdirs(path: string): Promise<void> {
    // Create each ancestor in turn — Vault.createFolder is not guaranteed to
    // create missing ancestors, so walk segment by segment (matches the prior
    // adapter behaviour and MemoryStorage).
    const segs = normalizePath(path)
      .split("/")
      .filter((s) => s.length > 0);
    let cur = "";
    for (const s of segs) {
      cur = cur === "" ? s : `${cur}/${s}`;
      if (this.vault.getAbstractFileByPath(cur) == null) {
        try {
          await this.vault.createFolder(cur);
        } catch {
          // Lost a race with a concurrent create — fine.
        }
      }
    }
  }

  async rmdir(path: string): Promise<void> {
    const f = this.vault.getAbstractFileByPath(normalizePath(path));
    if (f instanceof TFolder) await this.fileManager.trashFile(f);
  }

  async move(from: string, to: string): Promise<void> {
    const src = this.vault.getAbstractFileByPath(normalizePath(from));
    if (src == null) throw new Error(`ENOENT: ${from}`);
    await this.mkdirs(parentPath(to));
    // renameFile (not the raw adapter) rewrites every link that points into the
    // moved file/folder — including the `[[../<dir>/System|alias]]` subsystem
    // anchors a parent model holds on this one — so the move stays consistent.
    await this.fileManager.renameFile(src, normalizePath(to));
  }

  async list(path: string): Promise<DirListing> {
    const f = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFolder)) return { files: [], folders: [] };
    const files: string[] = [];
    const folders: string[] = [];
    for (const child of f.children) {
      if (child instanceof TFolder) folders.push(child.path);
      else files.push(child.path);
    }
    return { files: files.sort(), folders: folders.sort() };
  }
}
