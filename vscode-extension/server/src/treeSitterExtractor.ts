import { Symbol } from './symbol';

// web-tree-sitter is loaded dynamically at runtime (requires WASM binary).
// We type the minimal subset we actually use so we don't pull in a hard
// compile-time dependency that blocks `tsc` when the WASM isn't present.
interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  namedChildren: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
  parent: SyntaxNode | null;
}

interface Parser {
  parse(input: string): Tree;
  setLanguage(language: unknown): void;
}

interface Tree {
  rootNode: SyntaxNode;
}

/**
 * Extracts C symbols from source code using web-tree-sitter.
 *
 * The class is designed to work with *preprocessed* C code (i.e. after the
 * preprocessor has resolved `#include`, `#define`, etc.). It still handles
 * any residual `#define` lines that a simple preprocessor might leave in.
 */
export class TreeSitterExtractor {
  private parser: Parser | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialise the tree-sitter parser. Safe to call multiple times – the
   * underlying WASM is loaded only once.
   */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    try {
      // Dynamic import – web-tree-sitter is an optional peer dependency.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Parser = (await import('web-tree-sitter')).default;
      await Parser.init();
      this.parser = new Parser();
      const C = await Parser.Language.load('tree-sitter-c.wasm');
      this.parser.setLanguage(C);
    } catch {
      // Parser will remain null; extractSymbols will return [].
      this.parser = null;
    }
  }

  /**
   * Return `true` when the underlying WASM parser loaded successfully.
   */
  get isReady(): boolean {
    return this.parser !== null;
  }

  /**
   * Parse `content` and extract all C symbols.
   *
   * Falls back to a regex-based heuristic when tree-sitter is unavailable
   * or fails to parse the input.
   */
  extractSymbols(content: string, uri: string): Symbol[] {
    if (!this.parser) {
      return this.regexFallback(content, uri);
    }

    try {
      const tree = this.parser.parse(content);
      const symbols: Symbol[] = [];
      this.walk(tree.rootNode, uri, symbols);
      return symbols;
    } catch {
      return this.regexFallback(content, uri);
    }
  }

  // ── Tree-sitter node walking ──────────────────────────────────────────

  private walk(node: SyntaxNode, uri: string, out: Symbol[]): void {
    this.visit(node, uri, out);
    for (const child of node.namedChildren) {
      this.walk(child, uri, out);
    }
  }

  private visit(node: SyntaxNode, uri: string, out: Symbol[]): void {
    switch (node.type) {
      case 'function_definition':
        this.visitFunctionDef(node, uri, out);
        break;
      case 'declaration':
        this.visitDeclaration(node, uri, out);
        break;
      case 'type_definition':
        this.visitTypeDef(node, uri, out);
        break;
      case 'struct_specifier':
        this.visitStructOrUnion(node, uri, out, 'type');
        break;
      case 'union_specifier':
        this.visitStructOrUnion(node, uri, out, 'type');
        break;
      case 'enum_specifier':
        this.visitEnum(node, uri, out);
        break;
      case 'preproc_def':
        this.visitMacroDef(node, uri, out);
        break;
      case 'preproc_function_def':
        this.visitMacroDef(node, uri, out);
        break;
      default:
        break;
    }
  }

  private visitFunctionDef(node: SyntaxNode, uri: string, out: Symbol[]): void {
    const declarator = node.childForFieldName('declarator');
    if (!declarator) return;
    const name = this.extractDeclaratorName(declarator);
    if (!name) return;
    out.push({
      name,
      kind: 'function',
      file: uri,
      line: node.startPosition.row,
      column: node.startPosition.column,
    });
  }

  private visitDeclaration(node: SyntaxNode, uri: string, out: Symbol[]): void {
    // A single `declaration` node can declare multiple variables separated by
    // commas (e.g. `int a, b, c;`). We walk each init_declarator child.
    for (const child of node.namedChildren) {
      if (child.type === 'init_declarator') {
        const declarator = child.childForFieldName('declarator');
        if (!declarator) continue;
        const name = this.extractDeclaratorName(declarator);
        if (name) {
          out.push({
            name,
            kind: 'variable',
            file: uri,
            line: child.startPosition.row,
            column: child.startPosition.column,
          });
        }
      } else if (child.type === 'function_declarator') {
        // `int foo(void);` declaration (not definition)
        const name = this.extractDeclaratorName(child);
        if (name) {
          out.push({
            name,
            kind: 'function',
            file: uri,
            line: node.startPosition.row,
            column: node.startPosition.column,
          });
        }
      }
    }
  }

  private visitTypeDef(node: SyntaxNode, uri: string, out: Symbol[]): void {
    const declarator = node.childForFieldName('declarator');
    if (!declarator) return;
    const name = this.extractDeclaratorName(declarator);
    if (name) {
      out.push({
        name,
        kind: 'type',
        file: uri,
        line: node.startPosition.row,
        column: node.startPosition.column,
      });
    }
  }

  private visitStructOrUnion(
    node: SyntaxNode,
    uri: string,
    out: Symbol[],
    kind: 'type',
  ): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      out.push({
        name: nameNode.text,
        kind,
        file: uri,
        line: node.startPosition.row,
        column: node.startPosition.column,
      });
    }
  }

  private visitEnum(node: SyntaxNode, uri: string, out: Symbol[]): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      out.push({
        name: nameNode.text,
        kind: 'enum',
        file: uri,
        line: node.startPosition.row,
        column: node.startPosition.column,
      });
    }
    // Enum constants
    for (const child of node.namedChildren) {
      if (child.type === 'enumerator') {
        const enumeratorName = child.childForFieldName('name');
        if (enumeratorName) {
          out.push({
            name: enumeratorName.text,
            kind: 'enum',
            file: uri,
            line: child.startPosition.row,
            column: child.startPosition.column,
          });
        }
      }
    }
  }

  private visitMacroDef(node: SyntaxNode, uri: string, out: Symbol[]): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      out.push({
        name: nameNode.text,
        kind: 'macro',
        file: uri,
        line: node.startPosition.row,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * Drill through pointer / array / function declarators to find the
   * innermost identifier name.
   */
  private extractDeclaratorName(node: SyntaxNode): string | null {
    switch (node.type) {
      case 'identifier':
        return node.text;
      case 'field_identifier':
        return node.text;
      case 'pointer_declarator':
      case 'array_declarator':
      case 'function_declarator':
      case 'parenthesized_declarator': {
        const inner = node.childForFieldName('declarator');
        return inner ? this.extractDeclaratorName(inner) : null;
      }
      default:
        return null;
    }
  }

  // ── Regex fallback ────────────────────────────────────────────────────

  /**
   * Simple regex-based extraction used when tree-sitter is unavailable.
   * Handles preprocessed C code including `#line` directives that adjust
   * the logical line numbering.
   */
  regexFallback(content: string, uri: string): Symbol[] {
    const symbols: Symbol[] = [];
    const lines = content.split('\n');

    // Track logical line offsets from #line directives (common in
    // preprocessor output). When we encounter `#line N "file"` or `# N "file"`
    // we remember the mapping so subsequent symbols get the original source
    // line numbers.
    let lineOffset = 0; // logical = physical + lineOffset

    // Keywords that look like function calls but aren't.
    const IGNORED_NAMES = new Set([
      'if', 'for', 'while', 'switch', 'return', 'sizeof', 'typeof',
    ]);

    // C type keywords that may appear in a declaration prefix.
    const TYPE_KEYWORDS = new Set([
      'void', 'char', 'short', 'int', 'long', 'float', 'double',
      'signed', 'unsigned', 'const', 'static', 'extern', 'volatile',
      'register', 'inline', 'auto', 'restrict', '_Bool', '_Complex',
      'struct', 'union', 'enum', 'typedef',
    ]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const logicalLine = i + lineOffset;
      const trimmed = line.trim();

      // ── Preprocessor line directive ───────────────────────────────
      // Matches: #line 42 "file.c"  or  # 42 "file.c"
      const lineDirMatch = line.match(/^#\s*(?:line\s+)?(\d+)\s+"[^"]*"/);
      if (lineDirMatch) {
        // The directive says the *next* line is from source line N.
        lineOffset = parseInt(lineDirMatch[1], 10) - (i + 1);
        continue;
      }

      // Skip other preprocessor directives (includes, pragmas, etc.) that
      // aren't #define — we only care about macros.
      if (
        trimmed.startsWith('#') &&
        !trimmed.startsWith('#define') &&
        !trimmed.match(/^#\s+define\b/)
      ) {
        continue;
      }

      // ── #define MACRO or #define MACRO(...) ──────────────────────
      const macroMatch = line.match(/^\s*#\s*define\s+(\w+)/);
      if (macroMatch) {
        symbols.push({
          name: macroMatch[1],
          kind: 'macro',
          file: uri,
          line: logicalLine,
          column: line.indexOf(macroMatch[1]),
        });
        continue;
      }

      // ── typedef … name; ──────────────────────────────────────────
      const typedefMatch = line.match(/\btypedef\b.*?\s+(\w+)\s*;/);
      if (typedefMatch) {
        symbols.push({
          name: typedefMatch[1],
          kind: 'type',
          file: uri,
          line: logicalLine,
          column: line.indexOf(typedefMatch[1]),
        });
        continue;
      }

      // ── struct / union / enum tag ─────────────────────────────────
      const tagMatch = line.match(/\b(struct|union|enum)\s+(\w+)/);
      if (tagMatch) {
        symbols.push({
          name: tagMatch[2],
          kind: 'enum',
          file: uri,
          line: logicalLine,
          column: line.indexOf(tagMatch[2]),
        });
      }

      // ── Function definition ──────────────────────────────────────
      // Matches patterns like:
      //   int foo(void) {
      //   void *memset(void *s, int c, size_t n) {
      //   static inline uint32_t read_reg(uint32_t addr) {
      //
      // The regex allows an optional leading pointer star and any number
      // of type/storage keywords before the function name, then a
      // parenthesised argument list, then `{`.
      const funcMatch = line.match(
        /^(?:(?:[\w*]+\s+)*?)(\*?\s*\w+)\s*\([^)]*\)\s*\{/,
      );
      if (funcMatch) {
        const rawName = funcMatch[1].replace(/^\*+\s*/, '');
        if (!IGNORED_NAMES.has(rawName) && !TYPE_KEYWORDS.has(rawName)) {
          symbols.push({
            name: rawName,
            kind: 'function',
            file: uri,
            line: logicalLine,
            column: line.indexOf(rawName),
          });
          continue;
        }
      }

      // ── Global variable declaration ──────────────────────────────
      // Matches a line like `int counter = 0;` or `char *buf = NULL;`
      // that ends with a semicolon and isn't inside a function body
      // (heuristic: the line starts with a type keyword or typedef name).
      if (!trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
        const varMatch = line.match(
          /^((?:(?:const|static|extern|volatile|unsigned|signed|struct|union|enum)\s+)*(?:\w+\s+)*)(\*?\s*\w+)\s*(?:\[.*?\])?\s*(?:=[^;]*)?\s*;/,
        );
        if (varMatch) {
          const prefix = varMatch[1].trim();
          const rawName = varMatch[2].replace(/^\*+\s*/, '');
          // Only accept if the prefix contains at least one C type keyword,
          // otherwise we'd match arbitrary statements.
          const prefixWords = new Set(prefix.split(/\s+/));
          const hasType = [...TYPE_KEYWORDS].some((kw) => prefixWords.has(kw));
          if (hasType && rawName && !IGNORED_NAMES.has(rawName)) {
            symbols.push({
              name: rawName,
              kind: 'variable',
              file: uri,
              line: logicalLine,
              column: line.indexOf(rawName),
            });
          }
        }
      }
    }

    return symbols;
  }
}
