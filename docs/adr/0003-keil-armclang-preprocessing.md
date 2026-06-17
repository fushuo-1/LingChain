# ADR 0003: Keil Project Discovery and armclang Preprocessing

## Status

Accepted

## Context

Target users work with STM32CubeMX-generated Keil MDK projects. The build configuration lives in `.uvprojx` and `.uvoptx` files, and the compiler is `armclang.exe`.

## Decision

- Project discovery scans the workspace for `.uvprojx` files.
- The active project is selected manually via the status bar or command palette; automatic selection is not used.
- The parser reads compile context from `.uvprojx` (primary) and `.uvoptx` (supplementary).
- Users can override detected values through VS Code settings.
- The server invokes `armclang -E` to preprocess source and headers before tree-sitter parsing.
- Preprocessed output is not persisted; only the extracted symbol index is stored in SQLite.
- `#line` directives in preprocessor output are used to map symbol locations back to the original files.
- Files that fail preprocessing fall back to raw tree-sitter/ctags parsing, with errors reported to the user.

## Consequences

- Navigation is accurate for macro-expanded code.
- The server depends on a valid Keil installation and license.
- Preprocessing failures do not break the whole project.

## Alternatives

- Use GCC preprocessing instead of armclang: would not match Keil semantics.
- Skip preprocessing entirely: would miss macro-defined symbols.
- Persist preprocessed files: would consume significant disk space.
