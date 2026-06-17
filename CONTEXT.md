# LingµChain — Context

## Project

A VS Code extension + LSP server that provides C language navigation, completion, and diagnostics for embedded projects, especially those where `clangd` fails due to vendor toolchains (e.g. Keil MDK / ARM Compiler).

## Domain terms

- **Project root**: the folder opened in VS Code. The extension discovers embedded projects under this root.
- **Target toolchain**: the real compiler used to build the project (e.g. Keil ARM Compiler 5/6, arm-none-eabi-gcc). The LSP server may invoke this toolchain for ground-truth diagnostics in a later phase.
- **Compile context**: the set of include paths, macros, and source files needed to parse a translation unit. For Keil projects this is extracted from `.uvprojx`/`.uvoptx`; for Makefile/CMake projects it is extracted from the build system.
- **Symbol index**: a persistent database mapping identifiers to their definitions, declarations, and references.
- **Navigation request**: an LSP request such as `textDocument/definition`, `textDocument/references`, or `textDocument/documentSymbol`.
- **Completion request**: an LSP request for `textDocument/completion`.
- **Diagnostic request**: an LSP request for `textDocument/publishDiagnostics`. Phase 1 uses static analysis; Phase 2 invokes the target toolchain.

## Scope

- Phase 1: navigation + completion for embedded C projects, tolerant of missing headers and vendor-specific syntax.
- Phase 2: ground-truth diagnostics by invoking the target toolchain.

## Decisions

See `docs/adr/` for architectural decisions.
