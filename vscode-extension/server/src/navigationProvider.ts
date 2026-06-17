import {
  Position,
  Location,
  Hover,
  MarkupKind,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SymbolIndex, IndexedSymbol } from './symbolIndex';

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Minimal interface for document lookups.
 *
 * Satisfied by both `TextDocuments<T>` (from vscode-languageserver) and a
 * plain `Map<string, TextDocument>` (used in tests).
 */
interface DocumentProvider {
  get(uri: string): TextDocument | undefined;
}

// ── NavigationProvider ───────────────────────────────────────────────────

/**
 * LSP navigation provider backed by the persistent symbol index.
 *
 * Capabilities:
 *  - **Go to Definition** – returns the *definition* site of the symbol
 *    under the cursor.  When multiple definitions share the same name
 *    (e.g. overloaded functions across files) all locations are returned
 *    so VS Code can show a pick-list.
 *  - **Find All References** – returns every index entry whose name matches
 *    the symbol under the cursor (definitions + usages that were indexed).
 *  - **Hover** – returns a Markdown snippet showing the symbol kind and the
 *    source line extracted from the document content.
 */
export class NavigationProvider {
  private readonly index: SymbolIndex;

  constructor(index: SymbolIndex) {
    this.index = index;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Resolve `textDocument/definition`.
   *
   * Looks up the symbol at `position` in the index and returns all matching
   * definition locations.  When only one match exists the editor jumps
   * directly; when several exist a pick-list is shown.
   */
  async getDefinition(
    uri: string,
    position: Position,
    documents: DocumentProvider,
  ): Promise<Location[]> {
    const word = this.getWordAtPosition(uri, position, documents);
    if (!word) return [];

    const matches = await this.index.findByName(word);
    if (matches.length === 0) return [];

    return matches.map((sym) => this.symbolToLocation(sym));
  }

  /**
   * Resolve `textDocument/references`.
   *
   * Returns every indexed occurrence of the symbol under the cursor.
   * Because the index stores definitions only (no usage tracking yet),
   * this currently returns the same set as `getDefinition`.  A future
   * slice will add cross-reference tracking so that call-sites,
   * assignments, and include-directives are also captured.
   */
  async getReferences(
    uri: string,
    position: Position,
    documents: DocumentProvider,
  ): Promise<Location[]> {
    const word = this.getWordAtPosition(uri, position, documents);
    if (!word) return [];

    const matches = await this.index.findByName(word);
    return matches.map((sym) => this.symbolToLocation(sym));
  }

  /**
   * Resolve `textDocument/hover`.
   *
   * Returns a Markdown hover card with:
 *  - The symbol kind (function, variable, type, macro, enum).
 *  - The definition line extracted from the document content.
 *
   * Returns `null` when the cursor is not on a known symbol.
   */
  async getHover(
    uri: string,
    position: Position,
    documents: DocumentProvider,
  ): Promise<Hover | null> {
    const word = this.getWordAtPosition(uri, position, documents);
    if (!word) return null;

    const matches = await this.index.findByName(word);
    if (matches.length === 0) return null;

    // Prefer the match that lives in the current file; fall back to the
    // first match.
    const primary =
      matches.find((m) => m.file === uri) ?? matches[0];

    const definitionLine = this.getDefinitionLine(primary, documents);

    const kindLabel = this.kindToLabel(primary.kind);
    const contents =
      definitionLine !== null
        ? `\`\`\`c\n${definitionLine}\n\`\`\`\n*${kindLabel}*`
        : `*${kindLabel}* \`${word}\``;

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: contents,
      },
      range: this.getWordRange(uri, position, documents) ?? undefined,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Extract the identifier word under the cursor.
   *
   * Uses a word-boundary regex that covers C identifiers (`[A-Za-z_][A-Za-z0-9_]*`).
   * Returns `null` when the cursor is on whitespace or punctuation.
   */
  private getWordAtPosition(
    uri: string,
    position: Position,
    documents: DocumentProvider,
  ): string | null {
    const doc = documents.get(uri);
    if (!doc) return null;

    const line = doc.getText({
      start: { line: position.line, character: 0 },
      end: { line: position.line, character: Number.MAX_SAFE_INTEGER },
    });

    const regex = /[A-Za-z_][A-Za-z0-9_]*/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        return match[0];
      }
    }

    return null;
  }

  /**
   * Return the LSP range of the identifier under the cursor.
   */
  private getWordRange(
    uri: string,
    position: Position,
    documents: DocumentProvider,
  ): { start: Position; end: Position } | null {
    const doc = documents.get(uri);
    if (!doc) return null;

    const line = doc.getText({
      start: { line: position.line, character: 0 },
      end: { line: position.line, character: Number.MAX_SAFE_INTEGER },
    });

    const regex = /[A-Za-z_][A-Za-z0-9_]*/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(line)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position.character >= start && position.character <= end) {
        return {
          start: { line: position.line, character: start },
          end: { line: position.line, character: end },
        };
      }
    }

    return null;
  }

  /**
   * Convert an IndexedSymbol to an LSP Location.
   */
  private symbolToLocation(sym: IndexedSymbol): Location {
    return {
      uri: sym.file,
      range: {
        start: { line: sym.line, character: sym.column },
        end: { line: sym.line, character: sym.column + sym.name.length },
      },
    };
  }

  /**
   * Read the definition line from the document content (or `null` when the
   * document is not open).
   */
  private getDefinitionLine(
    sym: IndexedSymbol,
    documents: DocumentProvider,
  ): string | null {
    const doc = documents.get(sym.file);
    if (!doc) return null;

    const lineText = doc.getText({
      start: { line: sym.line, character: 0 },
      end: { line: sym.line, character: Number.MAX_SAFE_INTEGER },
    });

    return lineText.trim();
  }

  /**
   * Map a symbol kind to a human-readable label.
   */
  private kindToLabel(kind: IndexedSymbol['kind']): string {
    const map: Record<IndexedSymbol['kind'], string> = {
      function: 'Function',
      variable: 'Variable',
      type: 'Type',
      macro: 'Macro',
      enum: 'Enum',
    };
    return map[kind] ?? kind;
  }
}
