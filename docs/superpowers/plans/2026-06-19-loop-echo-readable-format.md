# Loop-note `loop:` echo — readable, non-link format — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the loop-note `loop:` frontmatter echo human-readable and non-linkifying in Obsidian (`R · Births | Population`), without changing the internal loop key, exports, API, identity, or filenames — in both the TS plugin and the Dart app, byte-parity preserved.

**Architecture:** The `R:Births|Population` string today does two jobs: an internal *loop key* (lookups, exports, API, migration) and a displayed *frontmatter echo*. We decouple them: add a dedicated `loopEchoLabel()` formatter in each repo, used ONLY at the `loop:` write sites; leave `loopKey()`/`loopNoteKey()` and all their consumers untouched. The echo is never read for logic, so this is a display-only change plus two generated-echo test assertions.

**Tech Stack:** TypeScript (Vitest, esbuild) for `neoloopy-obsidian`; Dart (`dart test`, package `loopy_core`) for `loopy`.

**Spec:** `docs/superpowers/specs/2026-06-19-loop-echo-readable-format-design.md`

## Global Constraints

- **Echo format (both repos, identical):** `<R|B> · <sorted-unique labels joined by " | ">`. Letter is `R` if `type` upper-cases to start with `R`, else `B`. Labels are deduped (Set) and sorted ascending. When the deduped list is empty, render just the letter (`R`/`B`) — no separator. The separator after the letter is ` · ` (space, U+00B7 MIDDLE DOT, space); members are joined by ` | ` (space, pipe, space).
- **Do NOT modify** `loopKey()` (TS `src/engine/loopKey.ts`) or `loopNoteKey()` (TS `src/view/loopKeys.ts`, Dart `core/lib/cli/formats.dart`), nor any of their call sites. They stay `R:...|...` and remain the identity/lookup/export/API key.
- **Two repos move in lockstep.** `loopEchoLabel` must be defined identically in TS and Dart so notes written by either app round-trip losslessly. (See memory `obsidian-dart-logic-parity`.)
- **The middot must be the literal U+00B7 character `·`** in source — not a `·` escape, not a different dot.
- **Verified parity facts:** `scalar()` (TS `noteCodec.ts:151`, Dart `note_codec.dart:168`) is byte-identical and does NOT quote on internal spaces, so the echo serializes unquoted: `loop: R · Births | Population`. Dart additionally writes an `h:` line whose `signature()` hashes `loopEcho`, so a Dart-rewritten note's `h:` changes once — harmless; no `h:` assertions exist in tests.

---

### Task 1: TS — `loopEchoLabel` formatter

**Files:**
- Create: `test/loopEchoLabel.test.ts`
- Modify: `src/engine/loopKey.ts` (append a function; do not touch `loopKey`)

**Interfaces:**
- Produces: `loopEchoLabel(labels: string[], type: string): string` exported from `src/engine/loopKey.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/loopEchoLabel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loopEchoLabel } from "../src/engine/loopKey";

describe("loopEchoLabel — human-readable, non-link loop echo", () => {
  it("renders an R loop as 'R · <sorted | labels>'", () => {
    expect(loopEchoLabel(["Population", "Births"], "reinforcing")).toBe(
      "R · Births | Population",
    );
  });

  it("renders a B loop and dedupes a closed cycle", () => {
    expect(loopEchoLabel(["A", "B", "C", "A"], "B")).toBe("B · A | B | C");
  });

  it("never starts with a 'scheme:' token (else Obsidian linkifies it)", () => {
    expect(loopEchoLabel(["Births", "Population"], "R")).not.toMatch(
      /^[A-Za-z][A-Za-z0-9+.-]*:/,
    );
  });

  it("degrades to the bare type letter when there are no members", () => {
    expect(loopEchoLabel([], "R")).toBe("R");
    expect(loopEchoLabel([], "balancing")).toBe("B");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/loopEchoLabel.test.ts`
Expected: FAIL — `loopEchoLabel` is not exported from `../src/engine/loopKey`.

- [ ] **Step 3: Implement the formatter**

Append to `src/engine/loopKey.ts` (after the existing `loopKey` function; leave `loopKey` exactly as-is):

```ts
/**
 * Human-readable, non-link echo for a loop note's `loop:` frontmatter field:
 * `<R|B> · <sorted unique labels joined by " | ">`. Same membership rule as
 * `loopKey` (dedupe + sort) but rendered for humans — it deliberately avoids a
 * leading `scheme:` so Obsidian's property view does not show it as a (dead)
 * external link. Display only; NEVER an identity/lookup/export/API key (that is
 * `loopKey`). Mirrors Dart `fmt.loopEchoLabel`.
 */
export function loopEchoLabel(labels: string[], type: string): string {
  const letter = type.toUpperCase().startsWith("R") ? "R" : "B";
  const uniq = [...new Set(labels.map((l) => String(l)))].sort();
  return uniq.length === 0 ? letter : `${letter} · ${uniq.join(" | ")}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/loopEchoLabel.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/loopKey.ts test/loopEchoLabel.test.ts
git commit -m "feat(ts): add loopEchoLabel — human-readable non-link loop echo"
```

---

### Task 2: TS — use `loopEchoLabel` at the `loop:` write sites

**Files:**
- Modify: `src/engine/nativeEngine.ts` (import line `:58`; echo writes `:823`, `:900`)
- Modify: `test/nativeEngine.test.ts:417` (the generated orphan-echo assertion)

**Interfaces:**
- Consumes: `loopEchoLabel` from `./loopKey` (Task 1).

- [ ] **Step 1: Update the failing assertion first (red)**

In `test/nativeEngine.test.ts:417`, change:

```ts
    expect(orphan.loopEcho).toBe("R:ghost|gone");
```

to:

```ts
    expect(orphan.loopEcho).toBe("R · ghost | gone");
```

(Leave line 421 `getLoopNotes(...)` → `{ "R:A|B": "reinforcing" }` UNCHANGED — that map is keyed by `loopKey`, not the echo.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/nativeEngine.test.ts -t "migrates legacy"`
Expected: FAIL — orphan echo is still `"R:ghost|gone"` (code not wired yet).

- [ ] **Step 3: Import `loopEchoLabel`**

In `src/engine/nativeEngine.ts:58`, change:

```ts
import { loopKey } from "./loopKey";
```

to:

```ts
import { loopEchoLabel, loopKey } from "./loopKey";
```

- [ ] **Step 4: Wire the upsert write site**

In `src/engine/nativeEngine.ts:900`, change:

```ts
      loopEcho: loopKey(memberLabels, type),
```

to:

```ts
      loopEcho: loopEchoLabel(memberLabels, type),
```

- [ ] **Step 5: Wire the legacy-migration write site**

In `src/engine/nativeEngine.ts:823`, change:

```ts
        loopEcho: key,
```

to:

```ts
        loopEcho: loopEchoLabel(labels, type),
```

(`labels` and `type` are already in scope: `type` at `:809`, `labels` at `:812`–`:816`. `key` stays the legacy lookup key everywhere else in this block.)

- [ ] **Step 6: Run the full TS suite + typecheck**

Run: `npm test`
Expected: PASS — only `test/nativeEngine.test.ts:417` needed updating; the codec byte-parity oracle (`test/loopNote.test.ts`) stays green because it uses hard-coded echo values.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/engine/nativeEngine.ts test/nativeEngine.test.ts
git commit -m "feat(ts): write loop: echo as readable non-link label"
```

---

### Task 3: Dart — `loopEchoLabel` formatter

**Files:**
- Create: `core/test/loop_echo_label_test.dart`
- Modify: `core/lib/cli/formats.dart` (append a function after `loopNoteKey`; do not touch `loopNoteKey`)

**Interfaces:**
- Produces: `String loopEchoLabel(List labels, String type)` in `core/lib/cli/formats.dart`.

- [ ] **Step 1: Write the failing test**

Create `core/test/loop_echo_label_test.dart`:

```dart
import 'package:loopy_core/cli/formats.dart';
import 'package:test/test.dart';

void main() {
  group('loopEchoLabel — human-readable, non-link loop echo', () {
    test('renders an R loop as "R · <sorted | labels>"', () {
      expect(loopEchoLabel(['Population', 'Births'], 'reinforcing'),
          'R · Births | Population');
    });

    test('renders a B loop and dedupes a closed cycle', () {
      expect(loopEchoLabel(['A', 'B', 'C', 'A'], 'B'), 'B · A | B | C');
    });

    test('never starts with a scheme: token', () {
      expect(loopEchoLabel(['Births', 'Population'], 'R'),
          isNot(matches(RegExp(r'^[A-Za-z][A-Za-z0-9+.-]*:'))));
    });

    test('degrades to the bare type letter with no members', () {
      expect(loopEchoLabel(const [], 'R'), 'R');
      expect(loopEchoLabel(const [], 'balancing'), 'B');
    });
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/abrahamkim/Develop/loopy/core && dart test test/loop_echo_label_test.dart`
Expected: FAIL — `loopEchoLabel` is undefined.

- [ ] **Step 3: Implement the formatter**

Append to `core/lib/cli/formats.dart` (immediately after `loopNoteKey`, around `:42`; leave `loopNoteKey` exactly as-is):

```dart
/// Human-readable, non-link echo for a loop note's `loop:` frontmatter field:
/// `<R|B> · <sorted unique variable names joined by " | ">`. Same membership
/// rule as [loopNoteKey] (dedupe + sort) but rendered for humans — it avoids a
/// leading `scheme:` so Obsidian's property view does not render it as a (dead)
/// external link. Display only; NEVER an identity/lookup/export/API key. Mirrors
/// TS `loopEchoLabel`.
String loopEchoLabel(List labels, String type) {
  final letter = type.toUpperCase().startsWith('R') ? 'R' : 'B';
  final uniq = {for (final l in labels) '$l'}.toList()..sort();
  return uniq.isEmpty ? letter : '$letter · ${uniq.join(' | ')}';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/abrahamkim/Develop/loopy/core && dart test test/loop_echo_label_test.dart`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (in the loopy repo)**

```bash
cd /Users/abrahamkim/Develop/loopy
git add core/lib/cli/formats.dart core/test/loop_echo_label_test.dart
git commit -m "feat(core): add loopEchoLabel — human-readable non-link loop echo"
```

---

### Task 4: Dart — use `loopEchoLabel` at the `loop:` write sites

**Files:**
- Modify: `core/lib/cli/vault_engine.dart` (echo writes `:1232`, `:1434`, `:1524`)
- Modify: `core/test/loop_note_engine_test.dart:315` (the generated orphan-echo assertion)

**Interfaces:**
- Consumes: `fmt.loopEchoLabel` — `formats.dart` is already imported as `fmt` in `vault_engine.dart` (Task 3).

- [ ] **Step 1: Update the failing assertion first (red)**

In `core/test/loop_note_engine_test.dart:315`, change:

```dart
    expect(ghost, contains('loop: R:X|Y'));
```

to:

```dart
    expect(ghost, contains('loop: R · X | Y'));
```

(Leave line 304 `notes['B:A|B']` UNCHANGED — that map is keyed by `loopNoteKey`, not the echo.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/abrahamkim/Develop/loopy/core && dart test test/loop_note_engine_test.dart -N "orphan"`
Expected: FAIL — the orphan file still contains `loop: R:X|Y`.
(If `-N` matches nothing, run the whole file: `dart test test/loop_note_engine_test.dart` and expect the orphan-stub test to fail.)

- [ ] **Step 3: Wire the upsert write site**

In `core/lib/cli/vault_engine.dart:1434`, change:

```dart
      loopEcho: fmt.loopNoteKey(memberLabels, type),
```

to:

```dart
      loopEcho: fmt.loopEchoLabel(memberLabels, type),
```

- [ ] **Step 4: Wire the rebind write site**

In `core/lib/cli/vault_engine.dart:1524`, change:

```dart
        loopEcho: fmt.loopNoteKey(labels, lt),
```

to:

```dart
        loopEcho: fmt.loopEchoLabel(labels, lt),
```

- [ ] **Step 5: Wire the legacy-migration write site**

In `core/lib/cli/vault_engine.dart:1232`, change:

```dart
        loopEcho: key,
```

to:

```dart
        loopEcho: fmt.loopEchoLabel(labels, type),
```

(`labels` and `type` are already in scope: `type` at `:1215`, `labels` at `:1222`–`:1226`. `key` stays the legacy lookup key elsewhere in this block.)

- [ ] **Step 6: Run the full Dart core suite**

Run: `cd /Users/abrahamkim/Develop/loopy/core && dart test`
Expected: PASS — only `test/loop_note_engine_test.dart:315` needed updating. The codec test (`loop_note_codec_test.dart`) stays green: its `loop: "R:Executive Authority|Polarization"` is a PARSE input fixture (proves old-format notes still parse), and it asserts fields, not exact serialized bytes or the echo value.

- [ ] **Step 7: Commit (in the loopy repo)**

```bash
cd /Users/abrahamkim/Develop/loopy
git add core/lib/cli/vault_engine.dart core/test/loop_note_engine_test.dart
git commit -m "feat(core): write loop: echo as readable non-link label"
```

---

### Task 5: Build the plugin and verify in Obsidian

**Files:** none (build + manual verification)

This is the real-world confirmation that the property no longer renders as a link. Per memory `desktop-test-loop`, deployment is: build → copy 3 files into the vault plugin folder → user reloads with Cmd+R (suspect a stale build first if behavior looks unchanged).

- [ ] **Step 1: Build the plugin**

Run (in `neoloopy-obsidian`): `npm run build`
Expected: typecheck passes and `main.js` is (re)written at the repo root.

- [ ] **Step 2: Deploy the 3 artifacts to the vault**

Copy `main.js`, `manifest.json`, and `styles.css` into the vault's `.obsidian/plugins/neoloopy/` folder. (Resolve the active vault path with the neoloopy `vault-path` tool if unknown.)

```bash
DEST="<vault>/.obsidian/plugins/neoloopy"
cp main.js manifest.json styles.css "$DEST"/
```

- [ ] **Step 3: Reload and verify (user action)**

Ask the user to press Cmd+R in Obsidian, then:
1. Open an existing loop note that was just (re)written, or annotate a loop so a `Loops/*.md` file is written. Confirm its `loop:` frontmatter reads `R · … | …` and renders as **plain text**, not a clickable external link.
2. Confirm an un-touched legacy loop note still shows the old `R:…|…` link (expected under lazy migration) and normalizes to the new format once re-annotated.

Expected: newly written loop notes display the `loop:` property as plain text; no dead external link.

- [ ] **Step 4: Confirm no stray changes / final state**

Run (both repos): `git status`
Expected: clean working trees; all changes are in the five committed tasks plus the spec/plan docs.

---

## Self-Review

**Spec coverage:**
- "Add `loopEchoLabel` in both repos, used only at echo write sites" → Tasks 1–4. ✓
- "Echo format `<R|B> · <sorted | labels>`, empty → letter" → Global Constraints + Task 1/3 tests. ✓
- "Leave `loopKey`/`loopNoteKey` + consumers untouched" → Global Constraints; assertions on `R:A|B` API/lookup keys left unchanged in Tasks 2 & 4. ✓
- "Parity: scalar unquoted, identical formatter, Dart `h:` re-signs once" → Global Constraints + Task 4 Step 6 note. ✓
- "Lazy migration, no migration code" → no migration task; Task 5 Step 3 verifies old notes persist until re-touched. ✓
- "Update literal-echo assertions; keep codec round-trip fixtures" → Task 2 Step 1 (TS:417), Task 4 Step 1 (Dart:315); codec tests explicitly kept. ✓
- "Manual Obsidian verification" → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full before/after; every command has expected output. ✓

**Type consistency:** `loopEchoLabel(labels, type)` signature identical across Task 1 (TS) and Task 3 (Dart) and matches call sites in Tasks 2 & 4 (`memberLabels`/`labels` + `type`/`lt`). ✓
