# ADR 0002: TypeScript + web-tree-sitter + node-sqlite3-wasm

## Status

Accepted

## Context

We need a parser, an indexer, and a runtime for the LSP server. The codebase must run on Windows without requiring native compilation tools on the target machine.

## Decision

- Runtime: TypeScript / Node.js for both the extension and the server.
- C parser: `web-tree-sitter` (WebAssembly) to parse preprocessed C source.
- C grammar: the prebuilt `tree-sitter-c.wasm` shipped by the
  `tree-sitter-wasms` package. Its language version must stay within the range
  supported by the `web-tree-sitter` runtime (0.22.x accepts language versions
  13–14), so the two are upgraded as a pair. The upstream `tree-sitter-c`
  release artefacts are newer than that range and cannot be dropped in without
  also upgrading the runtime.
- Index storage: `node-sqlite3-wasm` for a pure-JavaScript/WASM SQLite
  database holding file hashes, definition symbols, and identifier usages
  (the last backing "Find All References"). There is one database per Keil
  project, kept in a `.lingchain/` directory inside the project (the project
  root is derived from the common ancestor of its source files). These files
  are large — a HAL-based project indexes to tens of megabytes — so a project
  held in a synced folder will have them uploaded. The schema carries a
  version, and since the database is derived data, a version bump empties it
  and the next indexing pass rebuilds it.
- Fallback indexer: Universal Ctags for files that cannot be preprocessed.

## Consequences

- No native modules are required in the VSIX package, simplifying distribution.
- The server tolerates incomplete or vendor-specific code better than clang-based tools.
- Symbols come from tree-sitter only when the grammar loads; otherwise
  extraction silently degrades to a regex heuristic. The server therefore logs
  the grammar status at startup and asserts it in the smoke test instead of
  assuming the parser is active.
- We trade some parsing accuracy for robustness; semantic type inference is intentionally limited in Phase 1.

## Alternatives

- libclang: most accurate but suffers the same configuration problems as clangd.
- Rust + tree-sitter: better performance but slower development and steeper learning curve.
- Python: good for parsing but less natural integration with VS Code.
