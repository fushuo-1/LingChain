# ADR 0003: Keil Project Discovery and armclang Preprocessing

## Status

Accepted

_Amended 2026-09-10: corrected the project-selection, `.uvoptx` and
settings-override claims, and recorded how armclang is located. These were
documentation errors — the implementation was not changed to match this text._

## Context

Target users work with STM32CubeMX-generated Keil MDK projects. The compile configuration lives in the `.uvprojx` project file (the sibling `.uvoptx` holds debug/flash settings), and the compiler is `armclang.exe`.

## Decision

- Project discovery scans the workspace for `.uvprojx` files.
- The active project is selected with the `lingchain.selectProject` command
  (status bar or command palette). When the workspace contains exactly one
  `.uvprojx` file it is selected automatically at activation; when it contains
  several, the user picks one from a QuickPick.
- The parser reads compile context from `.uvprojx`. `.uvoptx` is not parsed:
  it holds debug/flash settings rather than compile context.
- Include paths and defines come from the project file only; there is no
  per-value user override yet. The settings that do exist cover the armclang
  executable (`lingchain.armclang.path`) and the server module
  (`lingchain.server.path`).
- armclang is located when a project is selected, in order: the explicit
  setting, then the `KEIL_ARMCLANG` / `ARMCLANG_PATH` / `KEIL_MDK` /
  `KEIL_UV4` environment variables, the Keil registry key, well-known install
  directories, and finally `PATH`. When it cannot be found, preprocessing and
  diagnostics are disabled rather than attempted per file.
- The server invokes `armclang -E` to preprocess source and headers before
  tree-sitter parsing. Target flags (`--target=arm-arm-none-eabi`, plus
  `-mcpu=…` derived from the device name) are passed so that target-dependent
  built-in macros resolve correctly.
- Preprocessed output is not persisted; only the extracted symbol index is
  stored in SQLite.
- `#line` directives in preprocessor output are used to map symbol locations
  back to the original files.
- Files that fail preprocessing fall back to raw tree-sitter parsing, then to
  Universal Ctags; failures are reported through the indexing progress log.
- Diagnostics run `armclang -fsyntax-only --format=json`, so no object files
  are written into the user's source tree.

## Consequences

- Navigation is accurate for macro-expanded code.
- A valid Keil installation is required for preprocessing and diagnostics,
  but not for navigation: without armclang the server still indexes and
  navigates using tree-sitter (or the regex fallback) and simply publishes no
  diagnostics, logging a warning at project-selection time.
- Preprocessing failures do not break the whole project.
- The compile context extracted for Phase 1 (include paths, defines, device)
  is reused by Phase 2 diagnostics.

## Alternatives

- Use GCC preprocessing instead of armclang: would not match Keil semantics.
- Skip preprocessing entirely: would miss macro-defined symbols.
- Persist preprocessed files: would consume significant disk space.
