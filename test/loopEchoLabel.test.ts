import { describe, it, expect } from "vitest";
import { loopEchoLabel } from "@neoloopy/cld-canvas";

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
