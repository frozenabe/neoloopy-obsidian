/**
 * One feedback-loop note (`Loops/<slug>.md`): an Obsidian-native markdown file
 * whose identity is the loop's (type, ordered member variable-ids) — held in
 * frontmatter, NEVER derived from the filename or from variable labels. The body
 * owns the narrative; `loop` is a human-readable echo only.
 *
 * TypeScript port of `core/lib/vault/loop_note.dart`. The serializer matches the
 * Dart output byte-for-byte (field order, `members: []` empty form, raw
 * `valence`, scalar quoting via the shared note codec) so a `Loops/*.md` file
 * written by the plugin and by the app/CLI round-trips losslessly on one vault.
 */

import { emitExtra, scalar, splitFrontmatter, YamlParse } from "./noteCodec";

const FENCE = "---";
const KNOWN = new Set(["type", "members", "title", "valence", "loop"]);

export interface LoopNote {
  /** 'R' (reinforcing) or 'B' (balancing). */
  type: string;
  /** Canonical-ordered member variable ids (the stable identity). */
  members: string[];
  /** Free-text alias shown beside the R/B badge (was `loopTitles`). */
  title: string;
  /** 'virtuous' | 'vicious' | '' (was `loopValence`). */
  valence: string;
  /** Human-readable label echo (`R:Label|Label`). Non-authoritative. */
  loopEcho: string;
  body: string;
  /** Unknown frontmatter keys, preserved verbatim (carries app-only `archetype`). */
  extra: Record<string, unknown>;
  /** True when frontmatter was present but unparseable (body still served). */
  malformed: boolean;
}

export function emptyLoopNote(partial: Partial<LoopNote> = {}): LoopNote {
  return {
    type: "R",
    members: [],
    title: "",
    valence: "",
    loopEcho: "",
    body: "",
    extra: {},
    malformed: false,
    ...partial,
  };
}

export function parseLoopNote(source: string, yaml: YamlParse): LoopNote {
  const [fm, body] = splitFrontmatter(source);
  if (fm === null) return emptyLoopNote({ body });
  let node: unknown;
  let malformed = false;
  try {
    node = yaml(fm);
  } catch {
    malformed = true;
  }
  const isMap = node !== null && typeof node === "object" && !Array.isArray(node);
  if (node !== null && node !== undefined && !isMap) malformed = true;
  const m: Record<string, unknown> = isMap ? (node as Record<string, unknown>) : {};

  const type = String(m["type"] ?? "R").toUpperCase().startsWith("B") ? "B" : "R";
  const members: string[] = [];
  if (Array.isArray(m["members"])) {
    for (const e of m["members"] as unknown[]) {
      const s = String(e).trim();
      if (s.length > 0) members.push(s);
    }
  }
  const valenceRaw = String(m["valence"] ?? "").trim().toLowerCase();
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (!KNOWN.has(k)) extra[k] = v;

  return {
    type,
    members,
    title: String(m["title"] ?? "").trim(),
    valence: valenceRaw === "virtuous" || valenceRaw === "vicious" ? valenceRaw : "",
    loopEcho: String(m["loop"] ?? "").trim(),
    body,
    extra,
    malformed,
  };
}

export function serializeLoopNote(n: LoopNote): string {
  const lines: string[] = [FENCE];
  lines.push(`type: ${n.type}`);
  if (n.members.length === 0) {
    lines.push("members: []");
  } else {
    lines.push("members:");
    for (const id of n.members) lines.push(`  - ${scalar(id)}`);
  }
  if (n.title.length > 0) lines.push(`title: ${scalar(n.title)}`);
  if (n.valence.length > 0) lines.push(`valence: ${n.valence}`);
  if (n.loopEcho.length > 0) lines.push(`loop: ${scalar(n.loopEcho)}`);
  for (const [k, v] of Object.entries(n.extra)) emitExtra(lines, k, v, 0);
  lines.push(FENCE);

  let out = lines.join("\n") + "\n";
  if (n.body.trim().length > 0) out += "\n" + n.body.trim() + "\n";
  return out;
}

/**
 * Rotate a cycle's ids so it starts at its lexicographically smallest id. Loop
 * identity is rotation-invariant but routing-sensitive (order matters), so two
 * different routings through the same node set stay distinct.
 */
export function canonicalLoopMembers(nodeIds: string[]): string[] {
  if (nodeIds.length === 0) return [];
  let min = 0;
  for (let i = 1; i < nodeIds.length; i++) {
    if (nodeIds[i] < nodeIds[min]) min = i;
  }
  return [...nodeIds.slice(min), ...nodeIds.slice(0, min)];
}

export function loopMatchesNote(type: string, nodeIds: string[], note: LoopNote): boolean {
  if (note.type !== type) return false;
  const a = canonicalLoopMembers(nodeIds);
  const b = canonicalLoopMembers(note.members);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const SLUG_STRIP = /[^a-z0-9]+/g;
export function loopSlug(type: string, title: string, memberLabels: string[]): string {
  const basis = title.trim().length > 0 ? title : memberLabels.join("-");
  const body = basis
    .toLowerCase()
    .replace(SLUG_STRIP, "-")
    .replace(/^-+|-+$/g, "");
  const t = type.toUpperCase().startsWith("B") ? "b" : "r";
  return body.length === 0 ? t : `${t}-${body}`;
}
