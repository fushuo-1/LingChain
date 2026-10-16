import {
  DocumentSymbol,
  SymbolKind,
  SymbolInformation,
  Range,
} from 'vscode-languageserver';
import { SymbolIndex, IndexedSymbol } from './symbolIndex';
import { Symbol, LiveSymbolStore, LocatedSymbol } from './symbol';

// ── SymbolListProvider ───────────────────────────────────────────────────

/**
 * LSP symbol-list provider backed by the persistent symbol index.
 *
 * Capabilities:
 *  - **Document Symbols** (`textDocument/documentSymbol`) – returns a flat
 *    list of symbols belonging to a single file.  VS Code uses this to
 *    populate the Outline view and the breadcrumb bar.
 *  - **Workspace Symbols** (`workspace/symbol`) – searches the entire
 *    symbol index by name prefix / substring and returns matching symbols
 *    with their file locations.  Used by the "Go to Symbol in Workspace"
 *    command (Ctrl+T).
 *
 * Symbols from open documents (`LiveSymbolStore`) take precedence over the
 * persisted index so unsaved edits show up in the Outline and the symbol
 * picker immediately.
 */
export class SymbolListProvider {
  private readonly index: SymbolIndex;
  private readonly live: LiveSymbolStore | undefined;

  constructor(index: SymbolIndex, live?: LiveSymbolStore) {
    this.index = index;
    this.live = live;
  }

  // ── Document Symbols ──────────────────────────────────────────────────

  /**
   * Return all symbols for the given document URI.
   *
   * The result is a flat `DocumentSymbol[]` array (no children / nesting).
   * Each entry carries the symbol name, kind, and the range covering the
   * symbol name on its definition line.
   */
  async getDocumentSymbols(uri: string): Promise<DocumentSymbol[]> {
    const live = this.live?.get(uri);
    if (live && live.length > 0) {
      return live.map((sym) => this.indexedToDocumentSymbol(sym));
    }

    const indexed = await this.index.findByFile(uri);
    return indexed.map((sym) => this.indexedToDocumentSymbol(sym));
  }

  // ── Workspace Symbols ─────────────────────────────────────────────────

  /**
   * Search the entire index for symbols whose name contains `query` as a
   * substring (case-sensitive, matching VS Code's default behaviour).
   *
   * Returns up to 50 results to keep the picker responsive on large
   * codebases.
   */
  async getWorkspaceSymbols(query: string): Promise<SymbolInformation[]> {
    if (!query || query.length === 0) {
      return [];
    }

    const liveMatches = (this.live?.all() ?? []).filter((s) =>
      s.name.includes(query),
    );
    const indexed = await this.index.findBySubstring(query, 50);

    // Live symbols first, then index entries that are not already covered.
    const seen = new Set(liveMatches.map((s) => symbolKey(s)));
    const merged: LocatedSymbol[] = [...liveMatches];
    for (const sym of indexed) {
      const key = symbolKey(sym);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(sym);
    }

    return merged.slice(0, 50).map((sym) => this.indexedToSymbolInformation(sym));
  }

  // ── Mapping helpers ───────────────────────────────────────────────────

  /**
   * Convert a symbol to an LSP DocumentSymbol (used by the
   * Outline view).
   *
   * The range covers the full definition line so that the highlight in
   * the Outline view is meaningful even without a full parse.  The
   * selectionRange covers just the symbol name.
   */
  private indexedToDocumentSymbol(sym: LocatedSymbol): DocumentSymbol {
    const nameRange: Range = {
      start: { line: sym.line, character: sym.column },
      end: { line: sym.line, character: sym.column + sym.name.length },
    };

    return {
      name: sym.name,
      kind: this.mapKind(sym.kind),
      range: nameRange,
      selectionRange: nameRange,
    };
  }

  /**
   * Convert a symbol to an LSP SymbolInformation (used by workspace symbol
   * search).
   */
  private indexedToSymbolInformation(sym: LocatedSymbol): SymbolInformation {
    return {
      name: sym.name,
      kind: this.mapKind(sym.kind),
      location: {
        uri: sym.file,
        range: {
          start: { line: sym.line, character: sym.column },
          end: { line: sym.line, character: sym.column + sym.name.length },
        },
      },
    };
  }

  /**
   * Map the internal symbol kind string to an LSP `SymbolKind` enum value.
   */
  private mapKind(kind: Symbol['kind']): SymbolKind {
    const map: Record<Symbol['kind'], SymbolKind> = {
      function: SymbolKind.Function,
      variable: SymbolKind.Variable,
      type: SymbolKind.Class,
      macro: SymbolKind.Constant,
      enum: SymbolKind.Enum,
    };
    return map[kind] ?? SymbolKind.Null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Stable identity of a symbol occurrence, used to de-duplicate results. */
function symbolKey(sym: LocatedSymbol): string {
  return `${sym.file}:${sym.line}:${sym.column}`;
}
