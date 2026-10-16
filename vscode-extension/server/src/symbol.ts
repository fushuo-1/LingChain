/**
 * Symbol types extracted from C source code.
 */
export interface Symbol {
  /** The name of the symbol (function name, variable name, type name, etc.) */
  name: string;
  /** The kind of symbol */
  kind: 'function' | 'variable' | 'type' | 'macro' | 'enum';
  /** The URI of the file where the symbol is defined */
  file: string;
  /** The 0-based line number of the symbol definition */
  line: number;
  /** The 0-based column number of the symbol definition */
  column: number;
}

/**
 * The subset of a symbol needed to produce an LSP location.
 *
 * Both `Symbol` (live, extracted from an open document) and `IndexedSymbol`
 * (persisted, with a database id) satisfy this shape, which lets providers
 * merge the two sources without caring where a symbol came from.
 */
export type LocatedSymbol = Pick<Symbol, 'name' | 'kind' | 'file' | 'line' | 'column'>;

/**
 * Read-only view of the symbols extracted from currently open documents.
 *
 * Implemented by the server's live symbol cache so that providers can
 * prefer in-editor (possibly unsaved) symbols over the persisted index.
 */
export interface LiveSymbolStore {
  /** Symbols for one document, or `undefined` when it is not open. */
  get(uri: string): Symbol[] | undefined;
  /** Symbols for every open document. */
  all(): Symbol[];
}

/**
 * An occurrence of an identifier in the source: a call site, an assignment
 * target, a type reference, and so on.
 *
 * Definitions are extracted as symbols as well, so a `Usage` list for a name
 * normally contains its definition plus every reference to it.
 */
export interface Usage {
  /** The identifier as written in the source. */
  name: string;
  /** The URI of the file containing this occurrence. */
  file: string;
  /** The 0-based line number. */
  line: number;
  /** The 0-based column number. */
  column: number;
}
