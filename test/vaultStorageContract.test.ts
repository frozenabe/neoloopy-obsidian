import { describe, it, expect } from "vitest";
import { normalizePath, TFile, TFolder } from "obsidian";
import type { Vault, TAbstractFile, FileManager } from "obsidian";
import { MemoryStorage, type VaultStorage } from "../src/engine/storage";
import { ObsidianStorage } from "../src/engine/obsidianStorage";

// A hand-written in-memory fake of the slice of Obsidian's Vault API that
// ObsidianStorage uses. Backed by the same Map/Set model as MemoryStorage, but
// exposed through the Vault surface (getAbstractFileByPath / read / create /
// modify / delete / createFolder) returning stub TFile/TFolder instances.
class FakeVault {
  private files = new Map<string, string>();
  private folders = new Set<string>([""]);

  getAbstractFileByPath(path: string): TAbstractFile | null {
    const p = normalizePath(path);
    if (this.files.has(p)) return this.makeFile(p);
    if (this.folders.has(p)) return this.makeFolder(p);
    return null;
  }

  async read(file: TFile): Promise<string> {
    const v = this.files.get(file.path);
    if (v === undefined) throw new Error(`ENOENT: ${file.path}`);
    return v;
  }

  async create(path: string, data: string): Promise<TFile> {
    const p = normalizePath(path);
    this.files.set(p, data);
    return this.makeFile(p);
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.files.set(file.path, data);
  }

  async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
    const p = file.path;
    if (this.files.has(p)) {
      this.files.delete(p);
      return;
    }
    const prefix = p + "/";
    for (const f of [...this.files.keys()]) {
      if (f === p || f.startsWith(prefix)) this.files.delete(f);
    }
    for (const d of [...this.folders]) {
      if (d === p || d.startsWith(prefix)) this.folders.delete(d);
    }
  }

  // ObsidianStorage routes deletions through FileManager.trashFile; the fake
  // honours the user's trash preference by simply removing the entry.
  async trashFile(file: TAbstractFile): Promise<void> {
    await this.delete(file);
  }

  async createFolder(path: string): Promise<TFolder> {
    const p = normalizePath(path);
    if (this.folders.has(p) || this.files.has(p)) throw new Error(`EEXIST: ${p}`);
    this.folders.add(p);
    return this.makeFolder(p);
  }

  private makeFile(p: string): TFile {
    const f = new TFile();
    f.path = p;
    f.name = baseName(p);
    return f;
  }

  private makeFolder(p: string): TFolder {
    const folder = new TFolder();
    folder.path = p;
    folder.name = baseName(p);
    const prefix = p === "" ? "" : p + "/";
    for (const fp of this.files.keys()) {
      if (isImmediateChild(prefix, fp)) folder.children.push(this.makeFile(fp));
    }
    for (const dp of this.folders) {
      if (dp === "") continue;
      if (isImmediateChild(prefix, dp)) folder.children.push(this.makeFolder(dp));
    }
    return folder;
  }
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.substring(i + 1);
}

function isImmediateChild(prefix: string, path: string): boolean {
  if (!path.startsWith(prefix)) return false;
  const rest = path.substring(prefix.length);
  return rest.length > 0 && !rest.includes("/");
}

const backends: Array<[string, () => VaultStorage]> = [
  ["MemoryStorage", () => new MemoryStorage()],
  [
    "ObsidianStorage",
    () => {
      const fv = new FakeVault();
      return new ObsidianStorage(
        fv as unknown as Vault,
        fv as unknown as FileManager,
      );
    },
  ],
];

describe.each(backends)("VaultStorage contract: %s", (_name, make) => {
  it("write creates parents, read returns the content, exists is true", async () => {
    const s = make();
    await s.write("models/m/a.md", "alpha");
    expect(await s.read("models/m/a.md")).toBe("alpha");
    expect(await s.exists("models/m/a.md")).toBe(true);
    expect(await s.exists("models/m")).toBe(true);
    expect(await s.exists("models")).toBe(true);
  });

  it("write overwrites an existing file", async () => {
    const s = make();
    await s.write("a.md", "one");
    await s.write("a.md", "two");
    expect(await s.read("a.md")).toBe("two");
  });

  it("read of a missing file rejects", async () => {
    const s = make();
    await expect(s.read("nope.md")).rejects.toThrow();
  });

  it("exists is false for a missing path", async () => {
    const s = make();
    expect(await s.exists("ghost.md")).toBe(false);
  });

  it("list splits immediate children into sorted files and folders", async () => {
    const s = make();
    await s.write("d/file2.md", "2");
    await s.write("d/file1.md", "1");
    await s.write("d/zsub/inner.md", "3");
    await s.write("d/asub/inner.md", "4");
    const listing = await s.list("d");
    expect(listing.files).toEqual(["d/file1.md", "d/file2.md"]);
    expect(listing.folders).toEqual(["d/asub", "d/zsub"]);
  });

  it("list of a missing folder returns empty", async () => {
    const s = make();
    expect(await s.list("missing")).toEqual({ files: [], folders: [] });
  });

  it("remove deletes a file and is a no-op when absent", async () => {
    const s = make();
    await s.write("x.md", "data");
    await s.remove("x.md");
    expect(await s.exists("x.md")).toBe(false);
    await s.remove("x.md"); // must not throw
  });

  it("mkdirs creates nested folders", async () => {
    const s = make();
    await s.mkdirs("a/b/c");
    expect(await s.exists("a")).toBe(true);
    expect(await s.exists("a/b")).toBe(true);
    expect(await s.exists("a/b/c")).toBe(true);
  });

  it("rmdir removes a folder and its entire subtree, sparing siblings", async () => {
    const s = make();
    await s.write("root/keep.md", "k");
    await s.write("root/sub/a.md", "a");
    await s.write("root/sub/b.md", "b");
    await s.rmdir("root/sub");
    expect(await s.exists("root/sub")).toBe(false);
    expect(await s.exists("root/sub/a.md")).toBe(false);
    expect(await s.exists("root/keep.md")).toBe(true);
  });
});
