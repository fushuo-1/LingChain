import {
  CompletionItem,
  CompletionItemKind,
  Position,
  TextDocuments,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SymbolIndex, IndexedSymbol } from './symbolIndex';
import { Symbol } from './symbol';

// ── CompletionProvider ───────────────────────────────────────────────────

/**
 * LSP completion provider backed by the persistent symbol index.
 *
 * Provides identifier-based code completion for C source files.
 * When the user types a partial identifier, this provider queries the
 * symbol index for matching symbols and returns them as completion items.
 *
 * Completion triggers on identifier characters: letters, digits, and
 * underscores.  The prefix is extracted by scanning backwards from the
 * cursor position until a non-identifier character is hit.
 */
export class CompletionProvider {
  private readonly index: SymbolIndex;

  constructor(index: SymbolIndex) {
    this.index = index;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Resolve `textDocument/completion`.
   *
   * Extracts the identifier prefix at the cursor position, queries the
   * symbol index for all symbols whose name starts with that prefix, and
   * returns matching `CompletionItem`s.
   *
   * @param uri       The URI of the document being edited.
   * @param position  The cursor position.
   * @param documents The document manager (for reading document content).
   * @returns An array of completion items, or an empty array when no match.
   */
  async getCompletion(
    uri: string,
    position: Position,
    documents: TextDocuments<TextDocument>,
  ): Promise<CompletionItem[]> {
    const doc = documents.get(uri);
    if (!doc) return [];

    const prefix = this.getPrefixAtPosition(doc, position);
    // Require at least one character so we don't return the entire index
    // on an empty trigger.
    if (prefix.length === 0) return [];

    const matches = await this.index.findByPrefix(prefix);

    // Deduplicate by name — multiple definitions with the same name
    // should appear only once in the completion list.
    const seen = new Set<string>();
    const items: CompletionItem[] = [];

    for (const sym of matches) {
      if (seen.has(sym.name)) continue;
      seen.add(sym.name);
      items.push(this.symbolToCompletionItem(sym));
    }

    return items;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Extract the identifier prefix at the cursor position.
   *
   * Scans backwards from `position.character` on the current line, stopping
   * at the first character that is not a valid C identifier character
   * (`[A-Za-z0-9_]`).  Returns the substring from that boundary to the
   * cursor.
   */
  private getPrefixAtPosition(
    doc: TextDocument,
    position: Position,
  ): string {
    const lineText = doc.getText({
      start: { line: position.line, character: 0 },
      end: { line: position.line, character: Number.MAX_SAFE_INTEGER },
    });

    // Scan backwards from cursor to find the start of the identifier.
    let start = position.character;
    while (start > 0) {
      const ch = lineText[start - 1];
      if (/[A-Za-z0-9_]/.test(ch)) {
        start--;
      } else {
        break;
      }
    }

    return lineText.substring(start, position.character);
  }

  /**
   * Convert an IndexedSymbol to an LSP CompletionItem.
   *
   * Maps the internal symbol kind to the appropriate `CompletionItemKind`.
   */
  private symbolToCompletionItem(sym: IndexedSymbol): CompletionItem {
    return {
      label: sym.name,
      kind: this.mapKind(sym.kind),
      detail: `${sym.kind} -- ${sym.file}`,
    };
  }

  /**
   * Map the internal symbol kind string to an LSP `CompletionItemKind`.
   */
  mapKind(kind: Symbol['kind']): CompletionItemKind {
    const map: Record<Symbol['kind'], CompletionItemKind> = {
      function: CompletionItemKind.Function,
      variable: CompletionItemKind.Variable,
      type: CompletionItemKind.Class,
      macro: CompletionItemKind.Constant,
      enum: CompletionItemKind.Enum,
    };
    return map[kind] ?? CompletionItemKind.Text;
  }
}
