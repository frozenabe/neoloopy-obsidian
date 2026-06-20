# iOS verification on real WebKit — test touch behaviour without shipping

iOS Obsidian runs on WebKit (WKWebView). These opt-in dev tools drive the canvas
on the **actual engine** via Playwright + iPhone emulation, so you can verify
touch/focus behaviour locally instead of building → copying to a vault →
reloading on a device.

Two harnesses, increasing fidelity:

- **`ios-webkit-check.mjs`** — bundles just `tapGesture.ts` and proves the
  tap-gesture facts on WebKit: a touch double-tap fires **no** native `dblclick`,
  the shipped `isDoubleTap` detector fires instead, and `focus()` inside a
  pointerup gesture takes. Fast, narrow.
- **`canvas-harness.mjs`** (+ `harness.html`, `shim.src.mjs`) — mounts the
  **shipped `CanvasView` from `main.js`** in WebKit/iPhone via an in-browser
  Obsidian shim + in-memory vault, and runs end-to-end create→blur→persist
  scenarios. This is what caught the node-vanishing bug.

```bash
node test/webkit/ios-webkit-check.mjs        # tap-gesture facts
npm run test:ios                             # full-view harness (canvas-harness.mjs)
node test/webkit/canvas-harness.mjs --headed             # watch it in a window
node test/webkit/canvas-harness.mjs --headed --keep-open # leave it open to poke
node test/webkit/canvas-harness.mjs --serve  # serve it for REAL iOS WebKit ↓
```

## Experience it on real iOS WebKit (Simulator or device)

`--serve` builds + serves the live canvas and prints two URLs (no Playwright
needed). This is the closest thing to the Obsidian iOS app — same WebKit engine,
real soft keyboard and focus behaviour:

- **iOS Simulator** (`xcrun simctl boot "iPhone 15"` / Xcode → open Simulator):
  open Safari in it and visit the printed `http://localhost:<port>/…` URL (the
  Simulator shares the Mac's network).
- **Real iPhone/iPad on the same Wi-Fi:** open Safari and visit the printed LAN
  `http://<your-mac-ip>:<port>/…` URL.

Note: the Simulator can run Mobile **Safari**, but it cannot run the App Store
**Obsidian app** (App Store binaries don't run on the Simulator). To experience
the plugin inside the actual Obsidian iOS app you need a real device — see the
repo chat / set `isDesktopOnly:false` and sync the build into the vault's
`.obsidian/plugins/neoloopy/` folder.

One-time setup (Playwright is intentionally **not** a committed dependency — it
would pull a browser download into CI's `npm ci`):

```bash
npm i -D playwright && npx playwright install webkit
```

## How `canvas-harness.mjs` works

1. rebuilds `main.js` from current source (`node esbuild.config.mjs production`),
2. bundles `shim.src.mjs` → `.shim.bundle.js` (an in-browser `obsidian` module +
   the `createEl`/`registerDomEvent`/… DOM helpers + an in-memory vault),
3. serves the repo and opens `harness.html` in WebKit/iPhone,
4. drives the real `CanvasView` via `window.__nl` and asserts behaviour.

`harness.html` exposes `window.__nl`: `nodeCount()`, `addVariableCommand()`,
`dispatchDoubleTap(x,y)`, `findEmptyPoint()`, `hasRenameInput()`, `blurRename()`,
`view`, `app`, …

Why a real browser and not the Node `view-smoke.cjs`: that smoke test fakes the
DOM and **no-ops `focus`/`blur` and event listeners**, so it can never reproduce
a focus bug. This harness uses the browser's real DOM, real `addEventListener`,
and real `input.focus()/blur()`.

## Fidelity caveat (important)

Desktop WebKit reproduces WebKit's DOM/focus semantics but **does not** auto-drop
focus from a programmatically-focused input the way **iOS** Safari does. That
specific iOS quirk — the thing that was deleting freshly-created nodes — is
therefore **modelled explicitly**: the scenarios call `blurRename()` to simulate
iOS dropping focus, and assert the node survives. For full end-to-end fidelity of
the soft-keyboard behaviour itself, use the iOS Simulator's Mobile Safari; for
fast regression coverage of the interaction logic, this harness is enough.

## Adding scenarios

Add a block in `canvas-harness.mjs` using `reset()` (fresh page + base node
count) then `page.evaluate(() => window.__nl.…)`. Add new hooks to `window.__nl`
in `harness.html` if you need to reach more of the view.
