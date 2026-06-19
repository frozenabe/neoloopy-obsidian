# Changelog

All notable changes to the neoloopy Obsidian plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.5]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.5
[0.1.4]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.4
[0.1.3]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.3
[0.1.2]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.2
[0.1.1]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.1
[0.1.0]: https://github.com/frozenabe/neoloopy-obsidian/releases/tag/0.1.0
