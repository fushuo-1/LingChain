# ADR 0004: Two-Phase Delivery

## Status

Accepted

## Context

The user wants full LSP functionality (navigation, completion, diagnostics) but also wants to see value quickly. The diagnostic requirement is to eventually match the real Keil compiler output.

## Decision

Deliver in two phases:

- **Phase 1**: Navigation + completion.
  - Go to definition, find references, workspace/document symbols, hover, and basic completion.
  - Indexing uses `armclang -E` preprocessing + tree-sitter + ctags fallback.
  - Diagnostics are not published.

- **Phase 2**: Ground-truth diagnostics.
  - Invoke `armclang -c` for the current file and publish diagnostics.
  - Parse armclang JSON diagnostics.
  - Debounce and cache compiler invocations for acceptable latency.

## Consequences

- Phase 1 can be completed and validated quickly.
- The compile context extracted for Phase 1 is reused for Phase 2 diagnostics.

## Alternatives

- Implement everything at once: higher risk and longer time to first usable version.
- Use static analysis for diagnostics: would not match Keil output.
