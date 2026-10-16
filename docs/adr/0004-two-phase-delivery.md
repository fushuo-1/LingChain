# ADR 0004: Two-Phase Delivery

## Status

Accepted

_Amended 2026-09-10: Phase 2 uses `-fsyntax-only` rather than `-c`, and the
caching claim was made precise._

## Context

The user wants full LSP functionality (navigation, completion, diagnostics) but also wants to see value quickly. The diagnostic requirement is to eventually match the real Keil compiler output.

## Decision

Deliver in two phases:

- **Phase 1**: Navigation + completion.
  - Go to definition, find references, workspace/document symbols, hover, and basic completion.
  - Indexing uses `armclang -E` preprocessing + tree-sitter + ctags fallback.
  - Diagnostics are not published.

- **Phase 2**: Ground-truth diagnostics.
  - Invoke `armclang -fsyntax-only --format=json` for the current file and publish diagnostics.
    `-fsyntax-only` is used instead of `-c` so that no object file is written next to the user's sources.
  - Parse armclang JSON diagnostics, falling back to text parsing for older toolchains.
  - Debounce compiler invocations per file, and cache the parsed diagnostics so unchanged results are not published twice.

## Consequences

- Phase 1 can be completed and validated quickly.
- The compile context extracted for Phase 1 is reused for Phase 2 diagnostics.

## Alternatives

- Implement everything at once: higher risk and longer time to first usable version.
- Use static analysis for diagnostics: would not match Keil output.
