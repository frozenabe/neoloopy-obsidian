import { Scene } from "@neoloopy/cld-canvas";

/** Authored edges reachable by keyboard navigation in the current scene. */
export function keyboardSelectableEdges(scene: Scene, anchor: string | null): Scene["edges"] {
  const authored = scene.edges.filter((edge) => edge.renderOnly !== true);
  return anchor
    ? authored.filter((edge) => edge.source === anchor || edge.target === anchor)
    : authored;
}

/** Badge identities reachable by keyboard navigation in the current view. */
export function keyboardSelectableLoopKeys(scene: Scene): string[] {
  return scene.loops.map((loop) => loop.key);
}
