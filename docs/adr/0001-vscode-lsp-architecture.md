# ADR 0001: VS Code Extension + LSP Server Architecture

## Status

Accepted

## Context

We need to provide code navigation, completion, and diagnostics for embedded C projects in VS Code. The existing `clangd` experience is poor for these projects because:

- The real toolchain is often Keil MDK / ARM Compiler (armclang), not GCC.
- `compile_commands.json` is hard to generate accurately from Keil projects.
- Vendor-specific syntax extensions and missing headers produce many false-positive diagnostics in clangd.

## Decision

Use a VS Code extension + LSP server architecture:

- The VS Code extension (`@lingchain/embedded-c-client`) discovers projects, manages UI state, and starts the LSP server.
- The LSP server (`@lingchain/embedded-c-server`) handles indexing, parsing, and LSP requests.

The server runs as a separate Node.js process and communicates over stdio using the Language Server Protocol.

## Consequences

- The server can be reused by other editors later.
- The extension stays thin and focused on VS Code-specific concerns.
- We accept the overhead of inter-process communication in exchange for a clean separation of concerns.

## Alternatives

- Pure VS Code API provider: simpler but not reusable and harder to maintain for full LSP features.
- Server bundled in extension process: simpler debugging but crashes are not isolated.
