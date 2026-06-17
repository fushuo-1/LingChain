# ADR 0002: TypeScript + web-tree-sitter + node-sqlite3-wasm

## Status

Accepted

## Context

We need a parser, an indexer, and a runtime for the LSP server. The codebase must run on Windows without requiring native compilation tools on the target machine.

## Decision

- Runtime: TypeScript / Node.js for both the extension and the server.
- C parser: `web-tree-sitter` (WebAssembly) to parse preprocessed C source.
- Index storage: `node-sqlite3-wasm` for a pure-JavaScript/WASM SQLite database.
- Fallback indexer: Universal Ctags for files that cannot be preprocessed.

## Consequences

- No native modules are required in the VSIX package, simplifying distribution.
- The server tolerates incomplete or vendor-specific code better than clang-based tools.
- We trade some parsing accuracy for robustness; semantic type inference is intentionally limited in Phase 1.

## Alternatives

- libclang: most accurate but suffers the same configuration problems as clangd.
- Rust + tree-sitter: better performance but slower development and steeper learning curve.
- Python: good for parsing but less natural integration with VS Code.
