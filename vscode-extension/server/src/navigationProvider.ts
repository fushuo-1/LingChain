import {
  Position,
  Location,
  Hover,
  MarkupKind,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SymbolIndex } from './symbolIndex';
import { LiveSymbolStore, LocatedSymbol } from './symbol';

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

// ── Helpers ──────────────────────────────────────────────────────────────

/** Stable identity of a symbol occurrence, used to de-duplicate results. */
function symbolKey(sym: LocatedSymbol): string {
  return `${sym.file}:${sym.line}:${sym.column}`;
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
  private readonly live: LiveSymbolStore | undefined;

  constructor(index: SymbolIndex, live?: LiveSymbolStore) {
    this.index = index;
    this.live = live;
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

    const matches = await this.gatherMatches(word);
    if (matches.length === 0) return [];

    return matches.map((sym) => this.symbolToLocation(sym));
  }

  /**
   * Resolve `textDocument/references`.
   *
   * Returns every recorded occurrence of the symbol under the cursor —
   * definition sites plus call sites, assignments and type references —
   * from the usage index.  When usages have not been indexed yet (a file
   * indexed by an older build, or one that only ctags could parse), it falls
   * back to the definition sites so the feature still returns something
   * useful instead of nothing.
   */
  async getReferences(
    uri: string,
    position: Position,
    documents: DocumentProvider,
  ): Promise<Location[]> {
    const word = this.getWordAtPosition(uri, position, documents);
    if (!word) return [];

    const usages = await this.index.findUsagesByName(word);
    if (usages.length > 0) {
      return usages.map((usage) => this.usageToLocation(usage));
    }

    const matches = await this.gatherMatches(word);
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

    const matches = await this.gatherMatches(word);
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
   * Collect every known definition of `word`, preferring live (in-editor)
   * symbols over persisted index entries and removing duplicates.
   *
   * A symbol is identified by file + line + column, so a live symbol whose
   * position moved after an unsaved edit is reported alongside (not instead
   * of) the stale index entry.
   */
  private async gatherMatches(word: string): Promise<LocatedSymbol[]> {
    const liveMatches = (this.live?.all() ?? []).filter(
      (s) => s.name === word,
    );
    const indexed = await this.index.findByName(word);

    const merged: LocatedSymbol[] = [...liveMatches];
    const seen = new Set(merged.map((s) => symbolKey(s)));

    for (const sym of indexed) {
      const key = symbolKey(sym);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(sym);
    }

    return merged;
  }

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
   * Convert a symbol to an LSP Location.
   */
  private symbolToLocation(sym: LocatedSymbol): Location {
    return {
      uri: sym.file,
      range: {
        start: { line: sym.line, character: sym.column },
        end: { line: sym.line, character: sym.column + sym.name.length },
      },
    };
  }

  /**
   * Convert an identifier occurrence to an LSP Location.
   */
  private usageToLocation(usage: {
    name: string;
    file: string;
    line: number;
    column: number;
  }): Location {
    return {
      uri: usage.file,
      range: {
        start: { line: usage.line, character: usage.column },
        end: { line: usage.line, character: usage.column + usage.name.length },
      },
    };
  }

  /**
   * Read the definition line from the document content (or `null` when the
   * document is not open).
   */
  private getDefinitionLine(
    sym: LocatedSymbol,
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
  private kindToLabel(kind: LocatedSymbol['kind']): string {
    const map: Record<LocatedSymbol['kind'], string> = {
      function: 'Function',
      variable: 'Variable',
      type: 'Type',
      macro: 'Macro',
      enum: 'Enum',
    };
    return map[kind] ?? kind;
  }
}
