import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// node_modules/obsidian ships types only (no runtime JS), so tests cannot import
// its runtime values. Alias "obsidian" to a minimal runtime stub for vitest ONLY.
// The esbuild production build (esbuild.config.mjs) is unaffected — it marks
// "obsidian" external and resolves against the real Obsidian runtime at load time.
export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url)),
    },
  },
});
