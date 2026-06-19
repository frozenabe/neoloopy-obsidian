# Loop-note `loop:` echo — readable, non-link format

**Date:** 2026-06-19
**Status:** Approved (design)
**Scope:** Both repos in lockstep — `neoloopy-obsidian` (TS) and `loopy` (Dart, `/Users/abrahamkim/Develop/loopy`).

## Problem

Loop notes store a frontmatter property `loop:` whose value looks like `R:Births|Population`
(`R`=reinforcing / `B`=balancing, then member variable names). Obsidian's property view
linkifies any text value that parses as `scheme:rest` — a leading token matching
`[A-Za-z][A-Za-z0-9+.-]*` immediately followed by `:`. `R:Births|Population` hits that rule,
so Obsidian renders it as a clickable (dead) external link. This confuses users: the property
looks like a hyperlink but goes nowhere and carries no link semantics.

## Root cause

The trigger is solely the leading `R:` / `B:` reading as a URI scheme. The `|` separator is
irrelevant. A value is safe from linkification as long as it does **not** begin with
`<word>:` (a colon preceded by a space, or no leading-scheme colon, is fine).

## Key finding — the string does two jobs

The `R:...|...` string is produced by `loopKey()` (TS `src/engine/loopKey.ts`) and
`loopNoteKey()` (TS `src/engine/exporters.ts`, Dart `core/lib/cli/formats.dart`). The same
format currently serves two distinct roles:

1. **Internal loop key** — a machine identifier used for in-memory lookup/upsert maps,
   legacy-vault migration matching, export output (JSON / Markdown / Cypher), and CLI/agent
   API parameters (e.g. `setLoopNote(key, …)`, `annotateLoop`). Every consumer recomputes the
   key on both sides of a comparison, so it only needs to be *internally consistent*.
2. **Frontmatter `loop:` echo** — the human-readable string the user sees in Obsidian. This
   is the only thing that is broken, and it is **never read for logic** in either repo (parsed
   into `loopEcho`, regenerated fresh from members+labels on every write, and — in Dart only —
   folded into a change-tracking signature hash at `loop_note.dart:74`).

Verified non-impact of changing only the echo:
- **Filenames** are derived from `loopSlug()` (title/labels), not the key — unaffected.
- **File lookup/matching** uses `loopMatchesNote()` on `type` + canonical `members` IDs — unaffected.
- **Identity** is `type` + `canonicalLoopMembers` — unaffected.

## Goal / non-goals

**Goal:** The `loop:` property no longer renders as a link in Obsidian; it stays a concise,
human-readable echo. TS and Dart stay logic-synced and byte-parity-identical.

**Non-goals:** No change to the internal loop key format. No change to exports, the CLI/agent
API, identity/matching, filenames, or legacy migration. No new migration tooling (lazy refresh
only).

## Decision — decouple the echo from the key

Introduce a dedicated echo formatter in each repo, used **only** at the `loop:` write sites.
Leave `loopKey()` / `loopNoteKey()` and every other consumer untouched.

### Echo format

```
<R|B> · <sorted-unique labels joined by " | ">
```

- Letter: `R` if type starts with `R` (else `B`).
- Separator after letter: ` · ` (space, U+00B7 MIDDLE DOT, space).
- Members: labels deduplicated (via Set) and sorted ascending, joined by ` | ` (space, pipe, space).
- **Edge case:** when the deduped label list is empty, render just the letter (`R` / `B`) — no trailing separator.

Examples:
- `R · Births | Population`
- `B · A | B | C`
- empty members → `R`

This is identical in structure to `loopKey()` (same dedupe + sort), differing only in
rendering — so behavior tracks the existing key generator.

## Changes

### TS — `neoloopy-obsidian`
- `src/engine/loopKey.ts` — add `loopEchoLabel(labels: string[], type: string): string`. Do **not** modify `loopKey()`.
- `src/engine/nativeEngine.ts:900` — echo write: `loopEcho: loopEchoLabel(memberLabels, type)`.
- `src/engine/nativeEngine.ts:823` — legacy-migration echo: derive via `loopEchoLabel` (from the same labels used for the key).
- Tests — update literal-echo assertions/fixtures: `test/loopNote.test.ts` (`:28`, `:55`, `:136`), `test/nativeEngine.test.ts:417`.

### Dart — `loopy`
- `core/lib/cli/formats.dart` — add `loopEchoLabel(List labels, String type)` next to `loopNoteKey`. Do **not** modify `loopNoteKey()`.
- `core/lib/cli/vault_engine.dart:1434` — echo write uses `loopEchoLabel`.
- `core/lib/cli/vault_engine.dart:1524` — rebind echo refresh uses `loopEchoLabel`.
- `core/lib/cli/vault_engine.dart:1232` — legacy-migration echo uses `loopEchoLabel`.
- `core/lib/vault/loop_note.dart:74` — no code change; awareness only (echo is in the signature hash, so a rewritten note re-signs once).
- Tests — update literal-echo assertions: `core/test/loop_note_codec_test.dart:40`, `core/test/loop_note_engine_test.dart:315`.

## Parity requirements

- The two serializers must remain byte-identical. The new value always contains spaces, so
  `scalar()` will quote it: `loop: "R · Births | Population"`. Verify TS `scalar()`
  (`src/engine/loopNote.ts`) and Dart `NoteCodec.scalar()` treat the middot (U+00B7) and the
  spaced pipe identically (both should quote on whitespace and emit the codepoint verbatim, no
  escaping). Confirm against the existing parity-oracle test before landing.
- `loopEchoLabel` must be defined identically (same dedupe/sort/letter/edge-case rules) in both
  repos so any note written by either app round-trips losslessly.

## Migration — lazy, on next write

No migration code. Existing notes keep their old `R:…|…` echo until the loop is next written
(annotate / retitle / set valence / rebind / re-detect upsert), at which point the echo is
regenerated in the new format automatically. Trade-off accepted: untouched notes continue to
show the old link-like value until edited.

## Testing

- Unit: `loopEchoLabel` in both repos — basic R/B, dedupe, sort, multi-member, and the empty
  edge case.
- Codec: update existing round-trip fixtures/assertions to the new echo value; confirm
  parse→serialize→parse preserves `type` + `members` and the new echo verbatim.
- Parity: the cross-impl byte-parity test must pass with the new quoted value.
- Regression: assert `loopKey()` / `loopNoteKey()` output is unchanged (exports + API contract
  intact).
- Manual (Obsidian): a loop note written with the new echo displays as plain text, not a link.

## Risks

- **Parity drift** if `loopEchoLabel` or `scalar()` middot handling differs between repos →
  mitigated by the parity-oracle test and identical formatter definitions.
- **Mixed formats during transition** (old notes link-y, new notes plain) — accepted per the
  lazy-migration choice.
