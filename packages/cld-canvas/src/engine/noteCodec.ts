/**
 * Reads & writes a single variable note: YAML frontmatter + Markdown body.
 * TypeScript port of `core/lib/vault/note_codec.dart`.
 *
 * Round-trip invariant: parsing then serializing preserves the structured fields
 * AND any unknown frontmatter keys (format rule §3 — never clobber another
 * tool's / the user's data). The serializer is hand-rolled to match the Dart
 * output byte-for-byte (field order, scalar quoting, x/y one-decimal format,
 * block-list link indentation), so notes written by the plugin and the app share
 * an identical content signature and round-trip losslessly on one vault.
 *
 * Parsing is delegated to an injected YAML parser (Obsidian's `parseYaml` at
 * runtime; the `yaml` package in tests) so this module stays pure and testable.
 *
 * Known limitation: a JS number cannot distinguish int from float, so a
 * whole-number float inside a *preserved unknown* key (e.g. a quant block's
 * `100.0`) may re-serialize as `100`. Structured qualitative fields handle this
 * exactly; preserved blocks keep the value, not necessarily the `.0` suffix.
 */

import {
  VariableFile,
  VaultLink,
  varTypeFrom,
  linkFromMap,
  linkToMap,
  toUtcIso,
} from "./types";

export type YamlParse = (s: string) => unknown;

const FENCE = "---";

/** Frontmatter keys this codec owns; everything else is carried in `extra`. */
const KNOWN = new Set([
  "id",
  "type",
  "label",
  "group",
  "claLayer",
  "shared",
  "x",
  "y",
  "links",
  "tags",
  "status",
  "created",
  "modified",
  "rev",
  "source",
  "reviewed",
  "reviewedBy",
  "h",
  "subsystem",
]);

/** Returns [frontmatterText|null, body]. Tolerates notes with no frontmatter. */
export function splitFrontmatter(source: string): [string | null, string] {
  const s = source.replace(/\r\n/g, "\n");
  const t = s.startsWith(`${FENCE}\n`) ? s : s.replace(/^\s+/, "");
  if (!t.startsWith(`${FENCE}\n`)) return [null, source.trim()];
  const end = t.indexOf(`\n${FENCE}`, FENCE.length);
  if (end < 0) return [null, source.trim()];
  const fm = t.substring(FENCE.length + 1, end + 1);
  let rest = t.substring(end + 1 + FENCE.length + 1);
  if (rest.startsWith("\n")) rest = rest.substring(1);
  return [fm, rest.trim()];
}

function nonEmpty(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s.length === 0 ? undefined : s;
}

function tagsFrom(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((e) => String(e).trim()).filter((s) => s.length > 0);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return [];
}

/**
 * Read a top-level scalar straight from the frontmatter *text*. Timestamps must
 * survive byte-for-byte (Dart writes microsecond precision, `2026-..Z`), but
 * YAML parsers vary: the `yaml` package keeps them as strings while js-yaml may
 * coerce `!!timestamp` to a `Date` and silently truncate to milliseconds. Going
 * back to the raw bytes makes timestamp round-trip parser-independent.
 */
function rawScalar(frontmatter: string | null, key: string): string | undefined {
  if (frontmatter === null) return undefined;
  let s: string | undefined;
  for (const line of frontmatter.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim() !== key) continue;
    s = line.slice(colon + 1).trim();
    break;
  }
  if (s === undefined) return undefined;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.length === 0 ? undefined : s;
}

/** Prefer the exact on-disk timestamp bytes; fall back to normalizing the parsed value. */
function tsField(frontmatter: string | null, key: string, parsed: unknown): string | undefined {
  return rawScalar(frontmatter, key) ?? toUtcIso(parsed);
}

export function parseNote(source: string, yaml: YamlParse, fallbackId?: string): VariableFile {
  const [frontmatter, body] = splitFrontmatter(source);
  const parsed = frontmatter === null ? {} : yaml(frontmatter);
  const m: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  const links: VaultLink[] = [];
  const rawLinks = m["links"];
  if (Array.isArray(rawLinks)) {
    for (const e of rawLinks) {
      if (e && typeof e === "object") links.push(linkFromMap(e as Record<string, unknown>));
    }
  }

  const numOr0 = (v: unknown): number => (typeof v === "number" ? v : 0);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (!KNOWN.has(k)) extra[k] = v;

  return {
    id: String(m["id"] ?? fallbackId ?? ""),
    type: varTypeFrom(typeof m["type"] === "string" ? (m["type"]) : undefined),
    label: String(m["label"] ?? ""),
    group: nonEmpty(m["group"]),
    claLayer: nonEmpty(m["claLayer"]),
    shared: nonEmpty(m["shared"]),
    x: numOr0(m["x"]),
    y: numOr0(m["y"]),
    links,
    tags: tagsFrom(m["tags"]),
    status: nonEmpty(m["status"]),
    created: tsField(frontmatter, "created", m["created"]),
    modified: tsField(frontmatter, "modified", m["modified"]),
    rev: typeof m["rev"] === "number" ? Math.trunc(m["rev"]) : 0,
    source: nonEmpty(m["source"]),
    reviewed: tsField(frontmatter, "reviewed", m["reviewed"]),
    reviewedBy: nonEmpty(m["reviewedBy"]),
    h: nonEmpty(m["h"]),
    subsystem: nonEmpty(m["subsystem"]),
    body,
    extra,
  };
}

/** Emit a YAML scalar, quoting when needed so it parses back identically. */
export function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  const needsQuote =
    s.length === 0 ||
    /^[\s\-+?:,[\]{}#&*!|>%@`"']/.test(s) ||
    /\s$/.test(s) ||
    s.includes(": ") ||
    s.includes(" #") ||
    s.includes("\n") ||
    /^(true|false|null|yes|no|on|off)$/i.test(s) ||
    /^[-+]?\d/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Match Dart's `'$d'` for a double-typed value: whole numbers keep a `.0`. */
function dartDouble(d: number): string {
  return Number.isInteger(d) ? `${d}.0` : String(d);
}

/** x/y formatting: integer-valued -> one decimal, else minimal. */
function numToYaml(d: number): string {
  return Number.isInteger(d) ? d.toFixed(1) : String(d);
}

/** Serialize a link entry value with the correct numeric type (Dart parity). */
function linkScalar(key: string, val: string | number | boolean): string {
  if (typeof val === "boolean") return String(val);
  if (typeof val === "number") return key === "weight" ? String(Math.trunc(val)) : dartDouble(val);
  return scalar(val);
}

/** Emit `key`/`value` as YAML into `lines` at the given indent level. */
export function emitExtra(lines: string[], key: string, value: unknown, indent: number): void {
  const pad = "  ".repeat(indent);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    lines.push(`${pad}${key}:`);
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      emitExtra(lines, k, val, indent + 1);
    }
  } else if (Array.isArray(value)) {
    lines.push(`${pad}${key}:`);
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        let first = true;
        for (const [k, val] of Object.entries(item as Record<string, unknown>)) {
          lines.push(`${pad}  ${first ? "- " : "  "}${k}: ${scalar(val)}`);
          first = false;
        }
      } else {
        lines.push(`${pad}  - ${scalar(item)}`);
      }
    }
  } else {
    lines.push(`${pad}${key}: ${scalar(value)}`);
  }
}

function emitFlowExtra(lines: string[], value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    emitExtra(lines, "flow", value, 0);
    return;
  }
  const m = value as Record<string, unknown>;
  lines.push("flow:");
  if (m["from"] !== undefined) lines.push(`  from: ${scalar(m["from"])}`);
  if (m["to"] !== undefined) lines.push(`  to: ${scalar(m["to"])}`);
  for (const [k, v] of Object.entries(m)) {
    if (k === "from" || k === "to") continue;
    emitExtra(lines, k, v, 1);
  }
}

function emitSfdExtra(lines: string[], value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    emitExtra(lines, "sfd", value, 0);
    return;
  }
  const m = value as Record<string, unknown>;
  lines.push("sfd:");
  if (m["x"] !== undefined) {
    const x = m["x"];
    lines.push(`  x: ${typeof x === "number" ? numToYaml(x) : scalar(x)}`);
  }
  if (m["y"] !== undefined) {
    const y = m["y"];
    lines.push(`  y: ${typeof y === "number" ? numToYaml(y) : scalar(y)}`);
  }
  for (const [k, v] of Object.entries(m)) {
    if (k === "x" || k === "y") continue;
    emitExtra(lines, k, v, 1);
  }
}

export function serializeNote(v: VariableFile): string {
  const lines: string[] = [FENCE];
  lines.push(`id: ${scalar(v.id)}`);
  lines.push(`type: ${v.type}`);
  lines.push(`label: ${scalar(v.label)}`);
  if (v.group && v.group.length > 0) lines.push(`group: ${scalar(v.group)}`);
  if (v.claLayer && v.claLayer.length > 0) lines.push(`claLayer: ${scalar(v.claLayer)}`);
  if (v.shared && v.shared.length > 0) lines.push(`shared: ${scalar(v.shared)}`);
  if (v.tags.length > 0) {
    lines.push("tags:");
    for (const t of v.tags) lines.push(`  - ${scalar(t)}`);
  }
  if (v.status && v.status.length > 0) lines.push(`status: ${scalar(v.status)}`);
  if (v.created) lines.push(`created: ${v.created}`);
  if (v.modified) lines.push(`modified: ${v.modified}`);
  if (v.rev > 0) lines.push(`rev: ${v.rev}`);
  if (v.source && v.source.length > 0) lines.push(`source: ${scalar(v.source)}`);
  if (v.reviewed) lines.push(`reviewed: ${v.reviewed}`);
  if (v.reviewedBy && v.reviewedBy.length > 0) lines.push(`reviewedBy: ${scalar(v.reviewedBy)}`);
  if (v.h && v.h.length > 0) lines.push(`h: ${scalar(v.h)}`);
  if (v.subsystem && v.subsystem.length > 0) lines.push(`subsystem: ${scalar(v.subsystem)}`);
  lines.push(`x: ${numToYaml(v.x)}`);
  lines.push(`y: ${numToYaml(v.y)}`);
  if (v.links.length > 0) {
    lines.push("links:");
    for (const l of v.links) {
      let first = true;
      for (const [key, val] of linkToMap(l)) {
        lines.push(`${first ? "  - " : "    "}${key}: ${linkScalar(key, val)}`);
        first = false;
      }
    }
  }
  for (const [k, val] of Object.entries(v.extra)) {
    if (k === "flow") emitFlowExtra(lines, val);
    else if (k === "sfd") emitSfdExtra(lines, val);
    else emitExtra(lines, k, val, 0);
  }
  lines.push(FENCE);

  let out = lines.join("\n") + "\n";
  if (v.body.trim().length > 0) out += "\n" + v.body.trim() + "\n";
  return out;
}
