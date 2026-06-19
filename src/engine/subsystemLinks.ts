/**
 * Subsystem-link resolution + parent-anchor derivation — the TypeScript mirror
 * of `core/lib/vault/subsystem_link.dart`. A node's `subsystem` field holds a
 * relative wikilink `[[../<dir>/System|<alias>]]` pointing DOWN into a child
 * model; deriving parents is the inverse — scanning other models for nodes that
 * point at us. Pure: IO is injected via `readNodes` so it stays unit-testable.
 */

import { VariableFile } from "./types";

/** One parent-model node that anchors a given child model as its subsystem. */
export interface ParentAnchor {
  modelFolder: string;
  modelName: string;
  anchorVarId: string;
  anchorVarLabel: string;
}

/** The minimal model identity the link rules need. */
export interface ModelKey {
  folder: string;
  name: string;
}

/** Parse `[[../<dir>/System|<alias>]]` into its folder-basename hint + alias. */
export function parseSubsystemLink(raw: string): { dir: string | null; alias: string | null } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { dir: null, alias: null };
  let body = trimmed;
  if (body.startsWith("[[") && body.endsWith("]]")) body = body.slice(2, -2);
  const bar = body.indexOf("|");
  const alias = bar >= 0 ? body.slice(bar + 1).trim() : null;
  const target = (bar >= 0 ? body.slice(0, bar) : body).trim();
  const dir =
    target
      .split("/")
      .filter((s) => s && s !== ".." && s.toLowerCase() !== "system")
      .pop() ?? null;
  return { dir, alias };
}

/** Does a stored subsystem link resolve to `model`? Folder basename, then name. */
export function linkPointsToModel(raw: string, model: ModelKey): boolean {
  const { dir, alias } = parseSubsystemLink(raw);
  if (dir == null && alias == null) return false;
  const base = model.folder.split("/").filter(Boolean).pop() ?? model.folder;
  return (
    (dir != null && base.toLowerCase() === dir.toLowerCase()) ||
    (alias != null && model.name.toLowerCase() === alias.toLowerCase())
  );
}

/** Scan `others` for nodes whose `subsystem` link points back at `current`. */
export async function deriveParentAnchors(
  current: ModelKey,
  others: ModelKey[],
  readNodes: (folder: string) => Promise<VariableFile[]>,
): Promise<ParentAnchor[]> {
  const out: ParentAnchor[] = [];
  for (const m of others) {
    if (m.folder === current.folder) continue;
    const nodes = await readNodes(m.folder);
    for (const n of nodes) {
      if (!n.subsystem) continue;
      if (linkPointsToModel(n.subsystem, current)) {
        out.push({
          modelFolder: m.folder,
          modelName: m.name,
          anchorVarId: n.id,
          anchorVarLabel: n.label || n.id,
        });
      }
    }
  }
  return out;
}
