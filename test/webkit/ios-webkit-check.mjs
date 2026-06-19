/*
 * Engine-level iOS verification on REAL WebKit (the WKWebView engine family that
 * Obsidian mobile runs on iOS), driven via Playwright with iPhone touch
 * emulation. The Node smoke tests prove the logic in a stub DOM; this proves the
 * two iOS-specific facts the canvas fix depends on, on the actual engine:
 *
 *   1. a touch double-tap does NOT fire a native `dblclick` (so the desktop
 *      app's create/rename trigger is genuinely dead on iOS) — the root cause;
 *   2. the pointer-stream detector built on the SHIPPED `isDoubleTap` DOES fire
 *      on that same touch double-tap — the fix;
 *   3. pointer events arrive with pointerType "touch", and a focus() called
 *      synchronously inside the pointerup handler takes (activeElement === input)
 *      — the prerequisite for iOS raising the soft keyboard in-gesture.
 *
 * Opt-in dev tool — Playwright is intentionally NOT a committed dependency (it
 * would pull a browser download into CI's `npm ci`). One-time local setup:
 *
 *     npm i -D playwright && npx playwright install webkit
 *     node test/webkit/ios-webkit-check.mjs
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { webkit, devices } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  if (!cond) failures++;
};

// Bundle the REAL tapGesture module (isDoubleTap + thresholds) to a browser IIFE
// exposing window.NL — so the page exercises shipped logic, not a copy.
const bundled = await build({
  stdin: {
    contents: `import * as NL from "${here}../../src/view/tapGesture.ts"; window.NL = NL;`,
    resolveDir: here,
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  write: false,
  logLevel: "silent",
});
const nlScript = bundled.outputFiles[0].text;

// The page mirrors PointerInteraction's pointer wiring: `touch-action: none`,
// pointerdown/move/up + a native dblclick listener, and the exact onPointerUp
// double-tap detection from the fix, fed by the real window.NL.isDoubleTap.
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%}#c{width:100vw;height:100vh;touch-action:none;display:block}</style>
<canvas id="c"></canvas>
<script>${nlScript}</script>
<script>
  const canvas = document.getElementById('c');
  const R = { nativeDblclick: 0, syntheticDoubleTap: 0, pointerups: 0, lastPointerType: null, focusInGesture: null };
  let lastTap = null, moved = false; const pointers = new Set();
  canvas.addEventListener('pointerdown', (e) => { pointers.add(e.pointerId); moved = false; });
  canvas.addEventListener('pointermove', () => { moved = true; });
  canvas.addEventListener('pointerup', (e) => {
    pointers.delete(e.pointerId);
    R.pointerups++; R.lastPointerType = e.pointerType;
    if (e.pointerType !== 'mouse' && pointers.size === 0) {
      if (moved) { lastTap = null; }
      else {
        const curr = { time: e.timeStamp, point: { x: e.clientX, y: e.clientY } };
        if (window.NL.isDoubleTap(lastTap, curr)) {
          lastTap = null; R.syntheticDoubleTap++;
          // Focus an input synchronously inside the gesture (the createNodeAt fix).
          const input = document.createElement('input');
          document.body.appendChild(input);
          input.focus();
          R.focusInGesture = (document.activeElement === input);
        } else { lastTap = curr; }
      }
    }
  });
  canvas.addEventListener('dblclick', () => { R.nativeDblclick++; });
  window.__R = R;
  window.__reset = () => { R.nativeDblclick = 0; R.syntheticDoubleTap = 0; R.pointerups = 0; R.focusInGesture = null; lastTap = null; };
</script>`;

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices["iPhone 13"] });
const page = await context.newPage();
await page.setContent(html);

const result = async () => page.evaluate(() => window.__R);
const reset = async () => page.evaluate(() => window.__reset());

// --- Case 1: a FAST touch double-tap at one spot ---------------------------
await page.touchscreen.tap(120, 250);
await page.touchscreen.tap(120, 250);
let R = await result();
check("touch taps deliver pointer events as pointerType 'touch'", R.lastPointerType === "touch", R.lastPointerType);
check("two touch taps registered (pointerup x2)", R.pointerups === 2, String(R.pointerups));
check("ROOT CAUSE: a touch double-tap fires NO native dblclick on WebKit", R.nativeDblclick === 0, String(R.nativeDblclick));
check("FIX: the pointer-stream detector fires on the touch double-tap", R.syntheticDoubleTap === 1, String(R.syntheticDoubleTap));
check("FIX: focus() inside the gesture takes (activeElement === input)", R.focusInGesture === true, String(R.focusInGesture));

// --- Case 2: two SLOW taps (gap > the 300ms window) must NOT double-tap -----
await reset();
await page.evaluate(() => document.getElementById("c").focus());
await page.touchscreen.tap(200, 400);
await page.waitForTimeout(450);
await page.touchscreen.tap(200, 400);
R = await result();
check("a slow tap pair does not register a double-tap", R.syntheticDoubleTap === 0, String(R.syntheticDoubleTap));

// --- Case 3: two fast taps far apart must NOT double-tap --------------------
await reset();
await page.touchscreen.tap(60, 120);
await page.touchscreen.tap(300, 600);
R = await result();
check("two distant fast taps do not register a double-tap", R.syntheticDoubleTap === 0, String(R.syntheticDoubleTap));

await browser.close();
console.log(failures === 0 ? "\nWEBKIT iOS CHECK PASS" : `\nWEBKIT iOS CHECK FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
