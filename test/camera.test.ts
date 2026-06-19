import { describe, it, expect } from "vitest";
import { Camera } from "../src/view/camera";

describe("Camera.centerOn", () => {
  it("places the world point at the viewport center", () => {
    const cam = new Camera();
    cam.scale = 2;
    cam.centerOn(100, 50, 800, 600);
    const s = cam.toScreen(100, 50);
    expect(s.x).toBeCloseTo(400);
    expect(s.y).toBeCloseTo(300);
  });
  it("does not change scale", () => {
    const cam = new Camera();
    cam.scale = 0.75;
    cam.centerOn(10, 10, 400, 400);
    expect(cam.scale).toBe(0.75);
  });
});
