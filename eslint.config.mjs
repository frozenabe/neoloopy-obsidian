// Self-check lint config — mirrors the Obsidian community-plugin validator so a
// clean `npm run lint` here predicts a clean submission. The validator runs
// eslint-plugin-obsidianmd's `recommended` set, which already bundles the
// type-aware typescript-eslint rules (scoped to TS) and the manifest checks; we
// just point its type-aware rules at this repo's tsconfig. Dev-only; nothing
// here ships in main.js.
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    // Only shipped TS source is type-checkable (tsconfig includes src/**/*.ts);
    // skip the bundle, tooling configs, and dev-only tests — the validator
    // doesn't scan them either.
    ignores: [
      "main.js",
      "node_modules/",
      "esbuild.config.mjs",
      "eslint.config.mjs",
      "vitest.config.ts",
      "test/**",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    // obsidianmd's recommended set enables a couple of type-aware rules globally
    // (a `files: null` block), so they leak onto package.json — which has no TS
    // program and crashes the run. Silence the type-aware obsidianmd rules for
    // JSON; the validator validates the manifest/package separately. Scoped to
    // package.json — the only JSON the recommended set wires a JSON parser for;
    // a broader glob would lint other .json files with the JS parser and fail.
    files: ["package.json"],
    rules: {
      "obsidianmd/no-plugin-as-component": "off",
      "obsidianmd/no-view-references-in-plugin": "off",
      "obsidianmd/no-unsupported-api": "off",
      "obsidianmd/prefer-file-manager-trash-file": "off",
      "obsidianmd/prefer-instanceof": "off",
    },
  },
  {
    // Type-aware rules (obsidianmd/no-unsupported-api,
    // @typescript-eslint/no-floating-promises, …) need a TS program.
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Stricter than the live validator — it does NOT report these. Kept off so
      // a clean run here matches the validator's actual finding set (and so
      // --fix never rewrites UI strings like the "ƒX" glyph).
      "obsidianmd/ui/sentence-case": "off",
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
];
