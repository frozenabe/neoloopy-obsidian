/**
 * Storage seam for the engine — a small filesystem-like interface plus an
 * in-memory implementation for tests. The Obsidian-backed implementation lives
 * in `obsidianStorage.ts` (kept separate so this module and the engine never
 * import the `obsidian` package and stay unit-testable in plain Node).
 *
 * All paths are vault-relative, "/"-separated.
 */

export interface DirListing {
  files: string[];
  folders: string[];
}

export interface VaultStorage {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Create `path` and any missing ancestor folders. */
  mkdirs(path: string): Promise<void>;
  /** Remove a folder and everything under it. */
  rmdir(path: string): Promise<void>;
  /**
   * Move/rename a file or folder (and everything under it) from one
   * vault-relative path to another, creating the destination's parent as needed.
   * The Obsidian implementation routes through `fileManager.renameFile` so every
   * wikilink/backlink pointing into the moved tree (subsystem anchors included)
   * is rewritten to the new location.
   */
  move(from: string, to: string): Promise<void>;
  /** Immediate children of `path` (vault-relative paths). */
  list(path: string): Promise<DirListing>;
}

/** Join + normalize vault-relative path segments. */
export function joinPath(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split("/"))
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.substring(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.substring(i + 1);
}

/** In-memory storage for tests. */
export class MemoryStorage implements VaultStorage {
  private files = new Map<string, string>();
  private folders = new Set<string>([""]);

  async exists(path: string): Promise<boolean> {
    const p = joinPath(path);
    return this.files.has(p) || this.folders.has(p);
  }

  async read(path: string): Promise<string> {
    const p = joinPath(path);
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  }

  async write(path: string, data: string): Promise<void> {
    const p = joinPath(path);
    await this.mkdirs(parentPath(p));
    this.files.set(p, data);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(joinPath(path));
  }

  async mkdirs(path: string): Promise<void> {
    const p = joinPath(path);
    if (p === "") return;
    const segs = p.split("/");
    let cur = "";
    for (const s of segs) {
      cur = cur === "" ? s : `${cur}/${s}`;
      this.folders.add(cur);
    }
  }

  async rmdir(path: string): Promise<void> {
    const p = joinPath(path);
    const prefix = p + "/";
    for (const f of [...this.files.keys()]) {
      if (f === p || f.startsWith(prefix)) this.files.delete(f);
    }
    for (const d of [...this.folders]) {
      if (d === p || d.startsWith(prefix)) this.folders.delete(d);
    }
  }

  async move(from: string, to: string): Promise<void> {
    const src = joinPath(from);
    const dst = joinPath(to);
    if (src === dst) return;
    await this.mkdirs(parentPath(dst));
    const prefix = src + "/";
    const rename = (p: string): string => (p === src ? dst : dst + "/" + p.substring(prefix.length));
    for (const f of [...this.files.keys()]) {
      if (f === src || f.startsWith(prefix)) {
        this.files.set(rename(f), this.files.get(f)!);
        this.files.delete(f);
      }
    }
    for (const d of [...this.folders]) {
      if (d === src || d.startsWith(prefix)) {
        this.folders.delete(d);
        this.folders.add(rename(d));
      }
    }
  }

  async list(path: string): Promise<DirListing> {
    const p = joinPath(path);
    const prefix = p === "" ? "" : p + "/";
    const files: string[] = [];
    const folders: string[] = [];
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.substring(prefix.length);
        if (rest.length > 0 && !rest.includes("/")) files.push(f);
      }
    }
    for (const d of this.folders) {
      if (d === "") continue;
      if (d.startsWith(prefix)) {
        const rest = d.substring(prefix.length);
        if (rest.length > 0 && !rest.includes("/")) folders.push(d);
      }
    }
    return { files: files.sort(), folders: folders.sort() };
  }
}
