import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// node_modules/obsidian ships types only (no runtime JS), so tests cannot import
// its runtime values. Alias "obsidian" to a minimal runtime stub for vitest ONLY.
// The esbuild production build (esbuild.config.mjs) is unaffected — it marks
// "obsidian" external and resolves against the real Obsidian runtime at load time.
//
// Run the suite against @neoloopy/cld-canvas's TS SOURCE rather than its built
// dist, so tests exercise the current source without a rebuild step (and never
// go stale against an older dist). The plugin's own production build resolves the
// package through node_modules → dist as normal.
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url)),
      "@neoloopy/cld-canvas": fileURLToPath(
        new URL("./packages/cld-canvas/src/index.ts", import.meta.url),
      ),
    },
  },
});
