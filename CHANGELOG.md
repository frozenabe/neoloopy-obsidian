# Changelog

All notable changes to the neoloopy Obsidian plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] - 2026-06-26

### Added

- **Subsystem public interface in the ƒx editor.** A variable that a parent
  model exposes now shows a **Public input** / **Public output** chip, and a node
  that drills into a child model shows a read-only **Subsystem · \<child\>**
  section listing the child's outputs as `Child.[Node]` references and its inputs
  with any parent-side binding — mirroring the companion app's hierarchical
  models, while publishing and binding stay in the app. Private variables show
  nothing.

### Fixed

- The ƒx editor's **Uses** list now recognizes multi-word variable names. A name
  like `Effective Rate` was being split into `Effective` and `Rate` and wrongly
  flagged as "Not defined in this model"; multi-word names are now matched as a
  whole.

## [0.1.8] - 2026-06-23

### Fixed

- Hardened the smoke-test bundle loader so temporary CommonJS copies are created
  inside private temp directories with exclusive `0600` file creation.
- Removed CodeQL-prone dynamic regular expression construction from note
  timestamp preservation.
- Removed the `Math.random()` fallback from model and variable id generation;
  ids now require Web Crypto randomness.

## [0.1.7] - 2026-06-20

### Added

- **Mobile (iOS) support.** The plugin is no longer desktop-only
  (`isDesktopOnly: false`), and the canvas is finally usable by touch.
  Double-tapping empty space creates a node right where you tapped with an
  inline name field; the canvas pins itself to the band above the soft keyboard
  and pans the new node into view so it never hides behind the keyboard (a port
  of the companion app's keyboard avoidance). Tapping away with an empty name
  discards the node, a named node is kept, and Escape cancels.
- **Subsystem marker on the canvas.** A node linked to a child model now shows a
  small stacked-sheets glyph in its top-left corner, matching the companion app,
  so drill-in nodes are recognizable at a glance.

### Fixed

- The canvas no longer collapses to zero height when the iOS soft keyboard
  opens — the bug that made a freshly created node appear for a moment and then
  vanish.
- The inline rename field is now compact and centered on its node instead of
  being stretched to full width by Obsidian's mobile input styling.

## [0.1.6] - 2026-06-19

### Added

- **Variable notes are named after the variable.** A variable's note file is now
  named after its label (`Birth_Rate.md`) instead of an opaque id, so the vault
  reads like the diagram. The stable internal `var_…` id stays in the note's
  frontmatter as the link target, so renaming a variable never breaks a causal
  link. Two variables with the same name are suffixed `-2`/`-3`.
- **Two-way variable name/file sync.** Renaming a variable on the canvas renames
  its note file; renaming the note file in Obsidian's explorer updates the
  variable's label (spaces map to underscores). This is the variable-level
  complement of the title/folder sync added in 0.1.5.

### Fixed

- Renaming a model on the canvas no longer overwrites its title with the
  lowercase-hyphen folder name. The folder move fired the same external-rename
  handler 0.1.5 introduced, which then re-titled the model to its slug.

## [0.1.5] - 2026-06-19

### Added

- **Two-way title/folder sync.** Renaming a model's folder in Obsidian's file
  explorer now updates the model's title to match (the folder is canonical for
  an external rename) — the complement of the existing canvas rename, which
  re-slugs and moves the folder to follow the title. Renaming a model now stays
  in sync no matter which side you change.

### Fixed

- **The model picker now tracks the vault live.** Deleting a model's folder in
  Obsidian removes it from the picker dropdown immediately, instead of lingering
  until the canvas is refreshed. If the deleted folder was the open model, the
  canvas switches to another model (or clears when it was the last one).
- Reloading the open model no longer throws if its folder was just deleted out
  from under it.

## [0.1.4] - 2026-06-19

### Added

- **Rename a model's title.** A pencil button next to the model picker and a new
  **"Rename model"** command let you change a model's title at any time.
- **Title prompt on creation.** Creating a model now asks for a title up front
  instead of silently defaulting to a date-based name.

### Changed

- **Folder name follows the title.** Creating or renaming a model re-slugs and
  moves its folder to match the title, suffixing `-2`/`-3` on collision. The move
  is link-aware (via Obsidian's `FileManager.renameFile`), so `[[../<dir>/System]]`
  subsystem anchors and other links into the model are rewritten to the new
  location rather than left dangling.
- Marked the plugin **desktop-only** (`isDesktopOnly: true`): the canvas is not
  yet usable on touch devices.

## [0.1.3] - 2026-06-19

### Fixed

- Enable canvas node creation and rename on **iOS touch** — a double-tap gesture
  plus in-gesture keyboard focus. The canvas rendered on iOS but could not be
  edited because WKWebView delivers no `dblclick` for touch.

## [0.1.2] - 2026-06-19

### Fixed

- Resolve Obsidian community-plugin validator findings for store submission.

## [0.1.1] - 2026-06-19

### Changed

- Clean re-release superseding 0.1.0.

## [0.1.0] - 2026-06-19

### Added

- Initial release: build causal-loop diagrams from variables and polarized
  causal links, detect reinforcing (R) and balancing (B) feedback loops,
  annotate them, and export to JSON / Markdown / Mermaid — fully local and
  offline.

[0.1.8]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.8
[0.1.7]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.7
[0.1.6]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.6
[0.1.5]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.5
[0.1.4]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.4
[0.1.3]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.3
[0.1.2]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.2
[0.1.1]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.1
[0.1.0]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.0
