/**
 * Minimal runtime stub of the `obsidian` package for vitest. The real package
 * (node_modules/obsidian) ships types only — no runtime JS — so importing its
 * values (normalizePath / TFile / TFolder) from a test would fail to resolve.
 * vitest.config.ts aliases "obsidian" to this file. Production builds use the
 * real Obsidian runtime (esbuild marks "obsidian" external).
 */

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export class TAbstractFile {
  path = "";
  name = "";
}

export class TFile extends TAbstractFile {}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

/** Runtime-only values imported by canvas interaction classes under Vitest. */
export class App {}

export class Modal {
  constructor(public app: App) {}
  open(): void {}
  close(): void {}
}

export function setIcon(): void {}
