import { describe, expect, it } from "vitest";
import { DetectedLoop, LoopType } from "../src/engine/types";
import { loopMemberNames, loopNoteKey } from "../src/view/loopKeys";
import { loopKey } from "../src/engine/loopKey";

const nameOf = (labels: Record<string, string>) => (id: string) => labels[id] ?? id;

describe("loopKeys", () => {
  it("derives the engine resolved-map key for a reinforcing loop", () => {
    const loop = new DetectedLoop(["a", "b", "c"], LoopType.reinforcing);
    const resolve = nameOf({ a: "Births", b: "Population", c: "Deaths" });
    expect(loopNoteKey(loop, resolve)).toBe("R:Births|Deaths|Population");
  });

  it("uses B for balancing loops", () => {
    const loop = new DetectedLoop(["a", "b"], LoopType.balancing);
    expect(loopNoteKey(loop, nameOf({ a: "X", b: "Y" }))).toBe("B:X|Y");
  });

  it("de-duplicates and sorts member names", () => {
    // A node may appear twice in a routing; the key collapses duplicates.
    const loop = new DetectedLoop(["a", "b", "a"], LoopType.reinforcing);
    expect(loopMemberNames(loop, nameOf({ a: "Zed", b: "Alpha" }))).toEqual(["Alpha", "Zed"]);
  });

  it("keeps an empty label empty (?? id, not || id)", () => {
    const loop = new DetectedLoop(["a", "b"], LoopType.reinforcing);
    // 'a' resolves to "" (empty label), 'b' to "Pop". Empty sorts first.
    expect(loopNoteKey(loop, nameOf({ a: "", b: "Pop" }))).toBe("R:|Pop");
  });

  it("stays in parity with the engine loopKey for the same inputs", () => {
    const loop = new DetectedLoop(["n1", "n2", "n3"], LoopType.balancing);
    const resolve = nameOf({ n1: "Stress", n2: "Coping", n3: "Health" });
    const viaView = loopNoteKey(loop, resolve);
    const viaEngine = loopKey(loop.nodeIds.map(resolve), "B");
    expect(viaView).toBe(viaEngine);
  });
});
