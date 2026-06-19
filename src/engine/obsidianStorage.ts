/**
 * VaultStorage backed by Obsidian's `Vault` API (the preferred surface over the
 * lower-level `Vault.adapter`). This is the only storage implementation that
 * imports `obsidian`; the engine and the interface stay clean so they unit-test
 * in plain Node against `MemoryStorage`. The `Vault` API is cross-platform
 * (desktop + mobile), so `isDesktopOnly: false` stays valid.
 */

import { TFile, TFolder, normalizePath } from "obsidian";
import type { Vault } from "obsidian";
import { DirListing, VaultStorage, parentPath } from "./storage";

export class ObsidianStorage implements VaultStorage {
  constructor(private readonly vault: Vault) {}

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
    if (f) await this.vault.delete(f);
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
    if (f instanceof TFolder) await this.vault.delete(f, true);
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
