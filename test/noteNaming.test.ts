import { describe, expect, it } from "vitest";
import { noteSlug, noteUnslug } from "@neoloopy/cld-canvas";

describe("noteSlug", () => {
  it("keeps a simple single-word label as-is (case preserved)", () => {
    expect(noteSlug("Births")).toBe("Births");
  });

  it("turns spaces into underscores", () => {
    expect(noteSlug("Birth Rate")).toBe("Birth_Rate");
  });

  it("collapses runs of whitespace and trims the edges", () => {
    expect(noteSlug("  Multiple   Spaces  ")).toBe("Multiple_Spaces");
    expect(noteSlug("Tabbed\tName")).toBe("Tabbed_Name");
  });

  it("strips filesystem- and wikilink-reserved characters", () => {
    expect(noteSlug('Slash/Colon:Star*?"<>|')).toBe("SlashColonStar");
    expect(noteSlug("Link [with] #hash ^caret")).toBe("Link_with_hash_caret");
  });

  it("preserves unicode and hyphens", () => {
    expect(noteSlug("café-au-lait")).toBe("café-au-lait");
  });

  it("returns empty for a label that is blank or all-reserved", () => {
    expect(noteSlug("   ")).toBe("");
    expect(noteSlug("")).toBe("");
    expect(noteSlug("/:*?")).toBe("");
  });
});

describe("noteUnslug", () => {
  it("turns underscores back into spaces (inverse of the common case)", () => {
    expect(noteUnslug("Birth_Rate")).toBe("Birth Rate");
  });

  it("leaves a single word untouched", () => {
    expect(noteUnslug("Births")).toBe("Births");
  });

  it("trims and collapses", () => {
    expect(noteUnslug("_Padded_")).toBe("Padded");
  });
});
