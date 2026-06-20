/**
 * Content signature + metadata stamping — TypeScript port of
 * `core/lib/vault/meta_stamp.dart`.
 *
 * `fnv1a32` is the dependency-free 32-bit FNV-1a the Dart and Python codecs use,
 * so all three produce identical 8-hex signatures (mirror: Dart `fnv1a32`,
 * Python `_fnv1a32`). The signature covers a note's CONTENT fields only — it
 * excludes x/y, cosmetic link attributes, and the derived
 * created/modified/rev/source/h — so cosmetic moves and field reordering are not
 * treated as content changes, and the plugin's writes are not falsely flagged as
 * external edits by the app.
 *
 * The 64-bit quant spec hash (`quant_spec_hash`) is intentionally NOT ported:
 * the qualitative plugin never computes quant staleness.
 */

import { VariableFile, VaultLink, varTypeName } from "./types";

/** Provenance value stored in a note's `source` key for plugin writes. */
export const WRITE_SOURCE_PLUGIN = "plugin";

const encoder = new TextEncoder();

/** FNV-1a 32-bit hash of `s` (UTF-8), as 8 lowercase hex chars. */
export function fnv1a32(s: string): string {
  let hash = 0x811c9dc5;
  for (const b of encoder.encode(s)) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Canonical, deterministic string over a note's content fields only. Links
 * sorted by target, tags sorted; `shared` and per-link `confidence`/`basis` are
 * appended only when set, so a note without them hashes byte-identically to
 * before those fields existed.
 */
export function canonicalContent(v: VariableFile): string {
  const tags = [...v.tags].sort();
  const links = [...v.links].sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  const linkPart = (l: VaultLink): string => {
    const base = `${l.to}|${l.polarity}|${l.delay ? 1 : 0}|${l.indirect ? 1 : 0}|${l.nonlinear ? 1 : 0}`;
    const conf = l.confidence !== undefined ? `|c${l.confidence.toFixed(3)}` : "";
    const basis = l.basis !== undefined && l.basis.length > 0 ? `|b${l.basis}` : "";
    return `${base}${conf}${basis}`;
  };

  const parts: string[] = [
    v.label,
    varTypeName(v.type),
    v.group ?? "",
    v.claLayer ?? "",
    v.subsystem ?? "",
    v.status ?? "",
    tags.join(","),
    ...links.map(linkPart),
    v.body.trim(),
  ];
  if ((v.shared ?? "").length > 0) parts.push(v.shared as string);
  return parts.join("\n");
}

/** 8-hex content signature stored as the note's `h` key. */
export function contentSignature(v: VariableFile): string {
  return fnv1a32(canonicalContent(v));
}

/**
 * Stamp recency metadata onto `next` before writing it.
 * - `prev` is the note's prior on-disk state (undefined = creation).
 * - A content change (signature differs, or creation) bumps modified/rev/source.
 *   A cosmetic change (x/y only) preserves them.
 * - `h` is always refreshed to the current content signature.
 */
export function stampMeta(
  prev: VariableFile | undefined,
  next: VariableFile,
  source: string,
  now?: Date,
): VariableFile {
  const ts = (now ?? new Date()).toISOString();
  const sig = contentSignature(next);
  const created = prev?.created ?? next.created ?? ts;
  const contentChanged = prev === undefined || contentSignature(prev) !== sig;
  if (contentChanged) {
    return { ...next, created, modified: ts, rev: (prev?.rev ?? 0) + 1, source, h: sig };
  }
  return {
    ...next,
    created,
    modified: prev.modified ?? ts,
    rev: prev.rev === 0 ? 1 : prev.rev,
    source: prev.source ?? source,
    h: sig,
  };
}
