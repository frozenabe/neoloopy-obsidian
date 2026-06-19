import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseNote, serializeNote } from "../src/engine/noteCodec";
import { fnv1a32, contentSignature, stampMeta } from "../src/engine/specHash";
import { VariableFile, emptyVariable } from "../src/engine/types";

const yaml = (s: string): unknown => parseYaml(s);

// A note in the serializer's exact canonical form.
const CANON = `---
id: var_a
type: stock
label: Population
status: reviewed
created: 2026-06-17T12:00:00.000Z
modified: 2026-06-17T12:30:00.000Z
rev: 3
source: app
h: abcd1234
x: 280.0
y: 300.0
links:
  - to: var_b
    polarity: "+"
    delay: false
    indirect: false
    nonlinear: false
  - to: var_c
    polarity: "-"
    delay: true
    indirect: false
    nonlinear: false
    confidence: 0.8
    basis: field study
---

Population stock body.
`;

describe("noteCodec round-trip", () => {
  it("parses then serializes back byte-identically", () => {
    const v = parseNote(CANON, yaml);
    expect(serializeNote(v)).toBe(CANON);
  });

  it("is idempotent for constructed variables with evidence + cosmetic carries", () => {
    const v: VariableFile = {
      ...emptyVariable("v1", "Trust"),
      type: "auxiliary",
      x: 12.5,
      y: -3,
      links: [
        {
          to: "v2",
          polarity: "+",
          delay: false,
          indirect: true,
          nonlinear: true,
          weight: 2,
          curvature: 0.18,
          confidence: 1,
          basis: "survey",
        },
      ],
      body: "Some prose.",
    };
    const once = serializeNote(v);
    const twice = serializeNote(parseNote(once, yaml));
    expect(twice).toBe(once);
  });

  it("preserves unknown frontmatter keys (e.g. a quant block)", () => {
    const v = emptyVariable("v1", "Stock A");
    v.type = "stock";
    v.extra = {
      quant: { equation: "births - deaths", units: "people", initial: 100 },
      foo: "bar",
    };
    const round = parseNote(serializeNote(v), yaml);
    expect(round.extra["foo"]).toBe("bar");
    expect((round.extra["quant"] as Record<string, unknown>)["equation"]).toBe("births - deaths");
    expect((round.extra["quant"] as Record<string, unknown>)["units"]).toBe("people");
  });

  it("quotes polarity and keeps booleans unquoted", () => {
    const v = emptyVariable("v1", "A");
    v.links = [{ to: "v2", polarity: "-", delay: true, indirect: false, nonlinear: false }];
    const out = serializeNote(v);
    expect(out).toContain('polarity: "-"');
    expect(out).toContain("delay: true");
    expect(out).toContain("indirect: false");
  });
});

describe("fnv1a32 — known answers (parity with Dart/Python)", () => {
  it("matches standard FNV-1a-32 test vectors", () => {
    expect(fnv1a32("")).toBe("811c9dc5");
    expect(fnv1a32("a")).toBe("e40c292c");
    expect(fnv1a32("foobar")).toBe("bf9cf968");
  });
});

describe("content signature", () => {
  it("ignores x/y (cosmetic) — same content, different position => same h", () => {
    const a = { ...emptyVariable("v1", "Trust"), x: 0, y: 0 };
    const b = { ...emptyVariable("v1", "Trust"), x: 999, y: -42 };
    expect(contentSignature(a)).toBe(contentSignature(b));
  });

  it("changes when a content field changes", () => {
    const a = emptyVariable("v1", "Trust");
    const b = { ...emptyVariable("v1", "Trust"), label: "Distrust" };
    expect(contentSignature(a)).not.toBe(contentSignature(b));
  });
});

describe("stampMeta", () => {
  it("bumps rev + modified on content change", () => {
    const prev: VariableFile = { ...emptyVariable("v1", "A"), rev: 2, modified: "2020-01-01T00:00:00.000Z" };
    const next = { ...prev, label: "B" };
    const stamped = stampMeta(prev, next, "plugin", new Date("2026-01-01T00:00:00.000Z"));
    expect(stamped.rev).toBe(3);
    expect(stamped.modified).toBe("2026-01-01T00:00:00.000Z");
    expect(stamped.source).toBe("plugin");
    expect(stamped.h).toBe(contentSignature(next));
  });

  it("preserves rev/modified on a cosmetic-only change", () => {
    const prev: VariableFile = {
      ...emptyVariable("v1", "A"),
      rev: 5,
      modified: "2020-01-01T00:00:00.000Z",
      source: "app",
    };
    const next = { ...prev, x: 123 };
    const stamped = stampMeta(prev, next, "plugin");
    expect(stamped.rev).toBe(5);
    expect(stamped.modified).toBe("2020-01-01T00:00:00.000Z");
    expect(stamped.source).toBe("app");
  });
});
