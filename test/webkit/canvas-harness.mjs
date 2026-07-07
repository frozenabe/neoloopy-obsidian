/*
 * Full-view iOS canvas harness (companion to ios-webkit-check.mjs, which checks
 * only the tap-gesture facts). Mounts the SHIPPED CanvasView from main.js in a
 * real WebKit page emulating an iPhone, via an in-browser Obsidian shim + an
 * in-memory vault (test/webkit/harness.html + shim.src.mjs).
 *
 * Rebuilds the bundle from current source, then reproduces the iOS node-vanishing
 * bug WITHOUT shipping: a node is created, then the rename input is blurred to
 * model iOS WebKit dropping focus on a programmatically-focused field. Pre-fix the
 * empty node auto-deletes; post-fix it survives.
 *
 *     npm run test:ios            # automated checks (or: node …/canvas-harness.mjs)
 *     node test/webkit/canvas-harness.mjs --headed [--keep-open]
 *     node test/webkit/canvas-harness.mjs --serve   # open it yourself on real iOS WebKit
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { builtinModules as builtins } from "node:module";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const HEADED = process.argv.includes("--headed");
const KEEP_OPEN = process.argv.includes("--keep-open");
// --serve: just build + serve the harness page (no Playwright, no asserts) so you
// can open it in the iOS Simulator's Safari (localhost) or a real device on the
// same Wi-Fi (LAN IP) — real iOS WebKit, the closest thing to the Obsidian app.
const SERVE = process.argv.includes("--serve");
const DEBUG_BUILD = process.argv.includes("--debug-build");
const PORT_ARG = process.argv.find((arg) => arg.startsWith("--port="));
const FIXED_PORT = PORT_ARG ? Number(PORT_ARG.slice("--port=".length)) : 0;

const log = (...a) => console.log(...a);
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  log(`  ${pass ? "✓ PASS" : "✗ FAIL"}  ${name}${pass || !detail ? "" : `\n          ${detail}`}`);
};

// ---- 1. build the plugin bundle + the shim ---------------------------------
log(`→ building main.js from current source${DEBUG_BUILD ? " (debug, readable)" : ""}…`);
if (DEBUG_BUILD) {
  await esbuild.build({
    entryPoints: [join(root, "src/main.ts")],
    bundle: true,
    external: [
      "obsidian",
      "electron",
      "@codemirror/autocomplete",
      "@codemirror/collab",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      ...builtins,
    ],
    format: "cjs",
    platform: "browser",
    target: "es2020",
    sourcemap: "inline",
    minify: false,
    outfile: join(root, "main.js"),
    logLevel: "info",
  });
} else {
  const build = spawnSync("node", ["esbuild.config.mjs", "production"], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) { log(build.stdout, build.stderr); throw new Error("plugin build failed"); }
}

log("→ bundling browser obsidian shim…");
await esbuild.build({
  entryPoints: [join(here, "shim.src.mjs")],
  bundle: true, format: "iife", platform: "browser", target: "es2020",
  outfile: join(here, ".shim.bundle.js"), logLevel: "error",
});

// ---- 2. static server ------------------------------------------------------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/__nl-log" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const from = req.socket.remoteAddress || "unknown";
      log(`[phone ${from}] ${body}`);
      res.writeHead(204).end();
      return;
    }
    const file = join(root, url === "/" ? "/test/webkit/harness.html" : url);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
const bindHost = SERVE ? "0.0.0.0" : "127.0.0.1";
await new Promise((r) => server.listen(FIXED_PORT, bindHost, r));
const port = server.address().port;
const pagePath = "/test/webkit/harness.html";
const url = `http://127.0.0.1:${port}${pagePath}`;

// ---- 3a. --serve: hand the URL to a real iOS WebKit you drive yourself ------
if (SERVE) {
  const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal);
  log("Serving the live canvas on real iOS WebKit. Leave this running; Ctrl+C to stop.\n");
  log(`  iOS Simulator → Safari:      http://localhost:${port}${pagePath}`);
  if (lan) log(`  Real iPhone/iPad (same Wi-Fi): http://${lan.address}:${port}${pagePath}`);
  log("\n(The page mounts the real canvas with a seeded model; double-tap empty space to add a node.)");
  await new Promise(() => {}); // keep alive
}

// ---- 3b. automated run: load Playwright (opt-in dependency) -----------------
let webkit, devices;
try {
  ({ webkit, devices } = await import("playwright"));
} catch {
  console.error(
    "Playwright is not installed. This is an opt-in dev tool — one-time setup:\n" +
      "  npm i -D playwright && npx playwright install webkit\n" +
      "then re-run `npm run test:ios` (or use --serve, which needs no Playwright).",
  );
  process.exit(2);
}

// ---- 3. WebKit + iPhone emulation ------------------------------------------
const { isMobile, ...iPhone } = devices["iPhone 13"]; // WebKit rejects isMobile
const browser = await webkit.launch({ headless: !HEADED });
const context = await browser.newContext({ ...iPhone });
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

log(`→ WebKit iPhone @ ${url}\n`);
await page.goto(url, { waitUntil: "load" });

// Boot completes (or errors) asynchronously.
await page.waitForFunction(() => window.__nl && (window.__nl.status.ready || window.__nl.status.error), null, { timeout: 15000 });
const boot = await page.evaluate(() => window.__nl.status);
if (!boot.ready) {
  log("BOOT FAILED:\n" + boot.error);
  if (consoleErrors.length) log("console:\n" + consoleErrors.join("\n"));
  await browser.close(); server.close();
  process.exit(1);
}
record("harness boots the real CanvasView in WebKit", true);

const reset = async () => {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__nl && window.__nl.status.ready, null, { timeout: 15000 });
  return page.evaluate(() => window.__nl.nodeCount());
};

// ---- Scenario E: mobile layout lets the camera fit at a usable zoom ---------
// (A fixed-width insight panel crushed the canvas → fit() pinned to MIN_SCALE
//  0.08 → newly created nodes rendered invisibly tiny.)
{
  await reset();
  const cam = await page.evaluate(() => ({ scale: window.__nl.cameraScale(), w: window.__nl.canvasWidth(), panel: window.__nl.panelOpen() }));
  record("insight panel starts closed on mobile (canvas keeps full width)", cam.panel === false, `panelOpen=${cam.panel}, canvasW=${cam.w}`);
  record("camera fits at a usable zoom, not pinned to MIN_SCALE 0.08", cam.scale > 0.1, `scale=${cam.scale}, canvasW=${cam.w}`);
}

// ---- Scenario F: opening a NEW/EMPTY model resets the camera to a usable zoom -
// (Switching from a model viewed at a tiny scale into a fresh empty model used to
//  inherit that scale — fit() does nothing with no nodes — so the first node was
//  created at e.g. 0.08 and rendered invisibly. "Appears then disappears".)
{
  await reset();
  const r1 = await page.evaluate(async () => {
    window.__nl.setCameraScale(0.08);     // simulate a prior pathological view
    await window.__nl.openEmptyModel();   // open a fresh, empty model
    return { scale: window.__nl.cameraScale() };
  });
  record("new/empty model resets camera off a tiny inherited scale", r1.scale > 0.1, `scale=${r1.scale}`);
  // First node: double-tap drops it on the spot + opens the inline editor.
  await page.evaluate(() => { const p = window.__nl.findEmptyPoint(); window.__nl.dispatchDoubleTap(p.x, p.y); });
  await page.waitForFunction(() => window.__nl.nodeCount() === 1, null, { timeout: 3000 }).catch(() => {});
  const r2 = await page.evaluate(() => ({ after: window.__nl.cameraScale(), n: window.__nl.nodeCount(), rename: window.__nl.hasRenameInput() }));
  record("first node in an empty model: created + inline editor at a visible zoom", r2.after > 0.1 && r2.n === 1 && r2.rename, `scale=${r2.after}, count=${r2.n}, rename=${r2.rename}`);
  // After the first node exists, the iOS keyboard fires a resize. A still-pending
  // "fit once" then fits to that single node and clamps to ~MAX_SCALE → a node
  // that fills the screen ("giant empty pill"). The view must stay put instead.
  const afterResize = await page.evaluate(() => { window.__nl.forceResize(); return window.__nl.cameraScale(); });
  record("a resize after the first node does NOT balloon the zoom", afterResize <= 1.5, `scale=${afterResize}`);
}

const settleNoRename = () => page.waitForFunction(() => !window.__nl.hasRenameInput(), null, { timeout: 3000 }).catch(() => {});
const pollCount = async () => { await page.waitForTimeout(150); return page.evaluate(() => window.__nl.nodeCount()); };
const waitCount = (n) => page.waitForFunction((want) => window.__nl.nodeCount() === want, n, { timeout: 3000 }).catch(() => {});

// ---- Scenario A: "Add variable" command → node + inline editor; named survives
{
  const base = await reset();
  await page.evaluate(() => window.__nl.addVariableCommand());
  const created = await page.evaluate(() => ({ n: window.__nl.nodeCount(), rename: window.__nl.hasRenameInput() }));
  record("command creates a node + opens the inline editor", created.n === base + 1 && created.rename, `count ${created.n} (base ${base}), rename ${created.rename}`);
  await page.evaluate(() => { window.__nl.typeRename("Stock"); window.__nl.blurRename(); });
  await settleNoRename();
  const after = await page.evaluate(() => ({ n: window.__nl.nodeCount(), labels: window.__nl.nodeLabels() }));
  record("a NAMED node survives tap-away (command path)", after.n === base + 1 && after.labels.includes("Stock"), `count ${after.n} (base ${base}), labels ${JSON.stringify(after.labels)}`);
}

// ---- Scenario B: double-tap → node on the spot + inline editor; band pinned --
{
  const base = await reset();
  await page.evaluate(() => { const p = window.__nl.findEmptyPoint(); window.__nl.dispatchDoubleTap(p.x, p.y); });
  await waitCount(base + 1);
  const created = await page.evaluate(() => ({ n: window.__nl.nodeCount(), rename: window.__nl.hasRenameInput(), pos: window.__nl.wrapPosition() }));
  record("double-tap creates a node on the spot + inline editor", created.n === base + 1 && created.rename, `count ${created.n} (base ${base}), rename ${created.rename}`);
  record("editing pins the canvas to the keyboard band (wrap fixed)", created.pos === "fixed", `wrap position="${created.pos}"`);
  await page.evaluate(() => { window.__nl.typeRename("Coffee"); window.__nl.blurRename(); });
  await settleNoRename();
  const after = await page.evaluate(() => ({ n: window.__nl.nodeCount(), labels: window.__nl.nodeLabels(), pos: window.__nl.wrapPosition() }));
  record("a NAMED node survives tap-away (double-tap path)", after.n === base + 1 && after.labels.includes("Coffee"), `count ${after.n}, labels ${JSON.stringify(after.labels)}`);
  record("closing the editor releases the band (wrap restored)", after.pos !== "fixed", `wrap position="${after.pos}"`);
}

// ---- Scenario C: tap-away with NO name discards the node (Dart parity) ------
{
  const base = await reset();
  await page.evaluate(() => { const p = window.__nl.findEmptyPoint(); window.__nl.dispatchDoubleTap(p.x, p.y); });
  await waitCount(base + 1);
  await page.evaluate(() => window.__nl.blurRename()); // tap away, name still empty
  await settleNoRename();
  const after = await pollCount();
  record("tap-away with an empty name discards the new node", after === base, `count ${after}, expected ${base}`);
}

// ---- Scenario D: Escape discards an unwanted empty node --------------------
{
  const base = await reset();
  await page.evaluate(() => { const p = window.__nl.findEmptyPoint(); window.__nl.dispatchDoubleTap(p.x, p.y); });
  await waitCount(base + 1);
  await page.evaluate(() => window.__nl.escapeRename());
  await settleNoRename();
  const after = await pollCount();
  record("Escape discards an empty new node", after === base, `count ${after}, expected ${base}`);
}

if (consoleErrors.length) log("\n(page console errors)\n" + consoleErrors.join("\n"));

if (KEEP_OPEN) { log("\n--keep-open: leaving the browser open. Ctrl+C to exit."); await new Promise(() => {}); }
await browser.close();
server.close();

const failed = results.filter((r) => !r.pass).length;
log(`\n${failed ? "✗" : "✓"} ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
