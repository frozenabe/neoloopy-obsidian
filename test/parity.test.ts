import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseNote, serializeNote } from "@neoloopy/cld-canvas";

const yaml = (s: string): unknown => parseYaml(s);
const fixture = (name: string): string =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

/**
 * Parity with the real Dart `neoloopy` binary: these fixtures were produced by
 * the shipping CLI (`create-model` / `add-variable` / `add-link` / `update-link`
 * / `annotate-variable`). The TS codec must round-trip the actual on-disk bytes
 * exactly — that is what guarantees the native and hybrid engines write a vault
 * the desktop app (and Obsidian users sharing the folder) can read losslessly.
 */
describe("parity with Dart CLI output", () => {
  it("round-trips a rich Dart-produced note byte-identically", () => {
    const src = fixture("dart-population.md");
    const v = parseNote(src, yaml);
    expect(serializeNote(v)).toBe(src);
  });

  it("round-trips the Dart-produced flow note byte-identically", () => {
    const src = fixture("dart-births.md");
    const v = parseNote(src, yaml);
    expect(serializeNote(v)).toBe(src);
  });

  it("captures the rich link attributes the CLI wrote", () => {
    const v = parseNote(fixture("dart-population.md"), yaml);
    const link = v.links.find((l) => l.to === "var_2037230c");
    expect(link).toBeDefined();
    expect(link?.polarity).toBe("+");
    expect(link?.delay).toBe(true);
    expect(link?.indirect).toBe(true);
    expect(link?.nonlinear).toBe(false);
    expect(link?.weight).toBe(2);
    expect(link?.confidence).toBe(0.8);
    expect(link?.basis).toBe("field study");
  });

  it("preserves the content signature the CLI stamped (h is shared)", () => {
    const v = parseNote(fixture("dart-population.md"), yaml);
    // The CLI wrote `h: c2e8211a`; we must read it back untouched.
    expect(v.h).toBe("c2e8211a");
  });
});
