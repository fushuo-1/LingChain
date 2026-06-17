import {
  DocumentSymbol,
  SymbolKind,
  SymbolInformation,
  Range,
} from 'vscode-languageserver';
import { SymbolIndex, IndexedSymbol } from './symbolIndex';
import { Symbol } from './symbol';

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
 */
export class SymbolListProvider {
  private readonly index: SymbolIndex;

  constructor(index: SymbolIndex) {
    this.index = index;
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

    const matches = await this.index.findBySubstring(query, 50);

    return matches.map((sym) => this.indexedToSymbolInformation(sym));
  }

  // ── Mapping helpers ───────────────────────────────────────────────────

  /**
   * Convert an IndexedSymbol to an LSP DocumentSymbol (used by the
   * Outline view).
   *
   * The range covers the full definition line so that the highlight in
   * the Outline view is meaningful even without a full parse.  The
   * selectionRange covers just the symbol name.
   */
  private indexedToDocumentSymbol(sym: IndexedSymbol): DocumentSymbol {
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
   * Convert an IndexedSymbol to an LSP SymbolInformation (used by
   * workspace symbol search).
   */
  private indexedToSymbolInformation(sym: IndexedSymbol): SymbolInformation {
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
