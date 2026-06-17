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
