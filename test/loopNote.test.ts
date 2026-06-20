import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  LoopNote,
  parseLoopNote,
  serializeLoopNote,
  canonicalLoopMembers,
  loopMatchesNote,
  loopSlug,
} from "@neoloopy/cld-canvas";

const yaml = (s: string): unknown => parseYaml(s);

/**
 * Byte-parity oracle. Each expected string below was produced by the shipping
 * Dart `LoopNoteCodec.serialize` (core/lib/vault/loop_note.dart) for the exact
 * LoopNote constructed beside it. The TS port must reproduce those bytes so a
 * `Loops/*.md` file written by the plugin and by the app/CLI is identical on one
 * vault. If the Dart serializer changes, regenerate these from the Dart codec.
 */

// type: R · two members · title · valence · loop echo · extra (archetype) · body
const RICH: LoopNote = {
  type: "R",
  members: ["var_00000001", "var_00000002"],
  title: "Growth engine",
  valence: "virtuous",
  loopEcho: "R:Births|Population",
  body: "More population makes more births.\n\nClassic reinforcing growth.",
  extra: { archetype: "limits-to-growth" },
  malformed: false,
};
const RICH_BYTES = `---
type: R
members:
  - var_00000001
  - var_00000002
title: Growth engine
valence: virtuous
loop: R:Births|Population
archetype: limits-to-growth
---

More population makes more births.

Classic reinforcing growth.
`;

// Orphan: no members (loop no longer exists), key preserved in the `loop` echo.
const ORPHAN: LoopNote = {
  type: "B",
  members: [],
  title: "",
  valence: "",
  loopEcho: "B:A|B|C",
  body: "Orphaned annotation whose loop no longer exists.",
  extra: {},
  malformed: false,
};
const ORPHAN_BYTES = `---
type: B
members: []
loop: B:A|B|C
---

Orphaned annotation whose loop no longer exists.
`;

// Minimal: type + members only, no body — frontmatter ends the file.
const MINIMAL: LoopNote = {
  type: "B",
  members: ["var_z", "var_a", "var_m"],
  title: "",
  valence: "",
  loopEcho: "",
  body: "",
  extra: {},
  malformed: false,
};
const MINIMAL_BYTES = `---
type: B
members:
  - var_z
  - var_a
  - var_m
---
`;

// Title `true` must be quoted (YAML keyword); colon in the body stays raw.
const QUOTY: LoopNote = {
  type: "R",
  members: ["var_1"],
  title: "true",
  valence: "",
  loopEcho: "",
  body: 'Title "true" must round-trip; colon: in body is fine.',
  extra: {},
  malformed: false,
};
const QUOTY_BYTES = `---
type: R
members:
  - var_1
title: "true"
---

Title "true" must round-trip; colon: in body is fine.
`;

const CASES: Array<[string, LoopNote, string]> = [
  ["rich", RICH, RICH_BYTES],
  ["orphan", ORPHAN, ORPHAN_BYTES],
  ["minimal", MINIMAL, MINIMAL_BYTES],
  ["quoty", QUOTY, QUOTY_BYTES],
];

describe("LoopNoteCodec — byte-parity with the Dart serializer", () => {
  for (const [name, note, bytes] of CASES) {
    it(`serializes the ${name} note exactly like Dart`, () => {
      expect(serializeLoopNote(note)).toBe(bytes);
    });

    it(`round-trips the ${name} bytes (parse → serialize is stable)`, () => {
      expect(serializeLoopNote(parseLoopNote(bytes, yaml))).toBe(bytes);
    });
  }
});

describe("LoopNoteCodec — parse extracts the structured identity", () => {
  it("reads type, members, title, valence, loop echo, extra and body", () => {
    const n = parseLoopNote(RICH_BYTES, yaml);
    expect(n.type).toBe("R");
    expect(n.members).toEqual(["var_00000001", "var_00000002"]);
    expect(n.title).toBe("Growth engine");
    expect(n.valence).toBe("virtuous");
    expect(n.loopEcho).toBe("R:Births|Population");
    expect(n.extra).toEqual({ archetype: "limits-to-growth" });
    expect(n.body).toBe("More population makes more births.\n\nClassic reinforcing growth.");
    expect(n.malformed).toBe(false);
  });

  it("treats any non-(virtuous|vicious) valence as empty", () => {
    const n = parseLoopNote("---\ntype: R\nmembers: []\nvalence: maybe\n---\n", yaml);
    expect(n.valence).toBe("");
  });

  it("normalizes a B-prefixed type and keeps an empty member list", () => {
    const n = parseLoopNote("---\ntype: balancing\nmembers: []\n---\n", yaml);
    expect(n.type).toBe("B");
    expect(n.members).toEqual([]);
  });

  it("serves the body even with no frontmatter (returns defaults)", () => {
    const n = parseLoopNote("just prose, no fence\n", yaml);
    expect(n.type).toBe("R");
    expect(n.members).toEqual([]);
    expect(n.body).toBe("just prose, no fence");
    expect(n.malformed).toBe(false);
  });
});

describe("canonicalLoopMembers — rotation-invariant identity", () => {
  it("rotates the cycle to start at the lexicographically smallest id", () => {
    expect(canonicalLoopMembers(["var_c", "var_a", "var_b"])).toEqual([
      "var_a",
      "var_b",
      "var_c",
    ]);
  });

  it("is invariant under rotation but sensitive to routing order", () => {
    expect(canonicalLoopMembers(["b", "c", "a"])).toEqual(["a", "b", "c"]);
    expect(canonicalLoopMembers(["c", "b", "a"])).toEqual(["a", "c", "b"]);
    // same node set, different routing → different canonical form
    expect(canonicalLoopMembers(["a", "b", "c"])).not.toEqual(
      canonicalLoopMembers(["a", "c", "b"]),
    );
  });

  it("returns empty for an empty cycle", () => {
    expect(canonicalLoopMembers([])).toEqual([]);
  });
});

describe("loopMatchesNote — anchors a note to a detected loop by identity", () => {
  const note: LoopNote = {
    type: "R",
    members: ["var_a", "var_b", "var_c"],
    title: "",
    valence: "",
    loopEcho: "",
    body: "",
    extra: {},
    malformed: false,
  };

  it("matches a rotation of the same routing and type", () => {
    expect(loopMatchesNote("R", ["var_b", "var_c", "var_a"], note)).toBe(true);
  });

  it("rejects a different type", () => {
    expect(loopMatchesNote("B", ["var_a", "var_b", "var_c"], note)).toBe(false);
  });

  it("rejects a different routing through the same nodes", () => {
    expect(loopMatchesNote("R", ["var_a", "var_c", "var_b"], note)).toBe(false);
  });

  it("rejects a different member set", () => {
    expect(loopMatchesNote("R", ["var_a", "var_b"], note)).toBe(false);
  });
});

describe("loopSlug — filename basis (never the identity)", () => {
  it("prefers the title, lowercased and dash-separated", () => {
    expect(loopSlug("R", "Growth Engine!", ["X", "Y"])).toBe("r-growth-engine");
  });

  it("falls back to joined member labels when there is no title", () => {
    expect(loopSlug("B", "", ["Births", "Population"])).toBe("b-births-population");
  });

  it("strips leading/trailing separators and collapses runs", () => {
    expect(loopSlug("R", "  --A & B--  ", [])).toBe("r-a-b");
  });

  it("degrades to the bare type letter when the basis is empty", () => {
    expect(loopSlug("B", "", [])).toBe("b");
    expect(loopSlug("R", "!!!", [])).toBe("r");
  });
});
