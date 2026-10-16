import * as fs from 'fs';
import * as path from 'path';
import { Symbol, Usage } from './symbol';

// web-tree-sitter is loaded dynamically at runtime (requires WASM binary).
// We type the minimal subset we actually use so we don't pull in a hard
// compile-time dependency that blocks `tsc` when the WASM isn't present.
interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  namedChildren: SyntaxNode[];
  childCount: number;
  child(index: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  fieldNameForChild(index: number): string | null;
  parent: SyntaxNode | null;
}

interface Parser {
  parse(input: string): Tree;
  setLanguage(language: unknown): void;
}

/** Constructor type of the web-tree-sitter `Parser` class. */
type ParserCtor = {
  new (): Parser;
  init(): Promise<void>;
  Language: { load(path: string): Promise<unknown> };
};

/**
 * Node types that can appear in a declarator position and wrap the name.
 * Drilled through when locating a symbol's identifier.
 */
const DECLARATOR_NODE_TYPES = new Set([
  'pointer_declarator',
  'array_declarator',
  'function_declarator',
  'parenthesized_declarator',
]);

interface Tree {
  rootNode: SyntaxNode;
}

// ── Process-wide runtime ─────────────────────────────────────────────────

/**
 * web-tree-sitter's WASM runtime is process-global: calling `Parser.init()`
 * a second time makes it throw.  The constructor and the loaded grammar are
 * therefore cached per process and shared by every extractor instance.
 */
let parserCtorPromise: Promise<ParserCtor> | null = null;
const grammarCache = new Map<string, Promise<unknown>>();

/** Load (once) and initialise the tree-sitter runtime. */
function loadParserCtor(): Promise<ParserCtor> {
  if (!parserCtorPromise) {
    parserCtorPromise = (async () => {
      const mod = (await import('web-tree-sitter')) as {
        default?: ParserCtor;
      } & Partial<ParserCtor>;
      const Parser = (mod.default ??
        (mod as unknown as ParserCtor)) as ParserCtor;
      await Parser.init();
      return Parser;
    })();

    // A failed load must not be cached, so a later call can retry.
    parserCtorPromise.catch(() => {
      parserCtorPromise = null;
    });
  }

  return parserCtorPromise;
}

/** Load (once per path) a grammar WASM binary. */
function loadGrammar(
  Parser: ParserCtor,
  grammarPath: string,
): Promise<unknown> {
  let cached = grammarCache.get(grammarPath);
  if (!cached) {
    cached = Parser.Language.load(grammarPath);
    cached.catch(() => grammarCache.delete(grammarPath));
    grammarCache.set(grammarPath, cached);
  }
  return cached;
}

/**
 * Extracts C symbols from source code using web-tree-sitter.
 *
 * The class is designed to work with *preprocessed* C code (i.e. after the
 * preprocessor has resolved `#include`, `#define`, etc.). It still handles
 * any residual `#define` lines that a simple preprocessor might leave in.
 *
 * `initialize()` must be awaited before `extractSymbols()`; callers that skip
 * it silently get the regex fallback.
 */
export class TreeSitterExtractor {
  private parser: Parser | null = null;
  private initPromise: Promise<void> | null = null;
  private initError: string | null = null;

  /**
   * Initialise the tree-sitter parser. Safe to call multiple times – the
   * underlying WASM is loaded only once.  A failed attempt is not cached so
   * that a later call can retry.
   */
  async initialize(): Promise<void> {
    if (this.parser) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    const grammarPath = this.resolveGrammarPath();
    if (!grammarPath) {
      this.initError =
        'tree-sitter-c.wasm not found (install the tree-sitter-wasms package)';
      this.parser = null;
      return;
    }

    try {
      const Parser = await loadParserCtor();
      const language = await loadGrammar(Parser, grammarPath);
      const parser = new Parser();
      parser.setLanguage(language);
      this.parser = parser;
      this.initError = null;
    } catch (err) {
      // Parser stays null; extractSymbols falls back to the regex path.
      this.parser = null;
      this.initError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Locate the C grammar WASM binary.
   *
   * Preferred source is the `tree-sitter-wasms` package (a prebuilt grammar
   * bundle); a binary sitting next to the compiled server is used as a
   * fallback for deployments that vendor one.
   */
  private resolveGrammarPath(): string | null {
    try {
      return require.resolve('tree-sitter-wasms/out/tree-sitter-c.wasm');
    } catch {
      // Package not installed – fall through to a vendored binary.
    }

    const adjacent = path.join(__dirname, '..', 'tree-sitter-c.wasm');
    return fs.existsSync(adjacent) ? adjacent : null;
  }

  /**
   * Extract every identifier occurrence from `content`.
   *
   * Definitions are included: a reference list for a name normally contains
   * its definition alongside its uses.  Returns an empty array when the
   * tree-sitter grammar is unavailable — the regex fallback cannot reliably
   * distinguish identifiers from surrounding prose.
   */
  extractUsages(content: string, uri: string): Usage[] {
    if (!this.parser) return [];

    try {
      const tree = this.parser.parse(content);
      const usages: Usage[] = [];
      this.collectUsages(tree.rootNode, uri, usages);
      return usages;
    } catch {
      return [];
    }
  }

  /**
   * Return `true` when the underlying WASM parser loaded successfully.
   */
  get isReady(): boolean {
    return this.parser !== null;
  }

  /**
   * Reason the last `initialize()` attempt failed, or `null` when the parser
   * is ready.  Useful for surfacing a degraded-indexing warning.
   */
  get lastInitError(): string | null {
    return this.initError;
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

  /**
   * Collect every identifier node under `node` as a usage.
   *
   * `identifier` covers variable and function names, `type_identifier`
   * covers type references, and `field_identifier` covers struct/union
   * member access (`s.field`).
   */
  private collectUsages(
    node: SyntaxNode,
    uri: string,
    out: Usage[],
  ): void {
    if (
      node.type === 'identifier' ||
      node.type === 'type_identifier' ||
      node.type === 'field_identifier'
    ) {
      out.push({
        name: node.text,
        file: uri,
        line: node.startPosition.row,
        column: node.startPosition.column,
      });
    }

    for (const child of node.namedChildren) {
      this.collectUsages(child, uri, out);
    }
  }

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
      case 'enumerator':
        this.visitEnumerator(node, uri, out);
        break;
      case 'field_declaration':
        this.visitFieldDeclaration(node, uri, out);
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
    const nameNode = this.findDeclaratorNameNode(declarator);
    if (!nameNode) return;
    out.push({
      name: nameNode.text,
      kind: 'function',
      file: uri,
      line: nameNode.startPosition.row,
      column: nameNode.startPosition.column,
    });
  }

  private visitDeclaration(node: SyntaxNode, uri: string, out: Symbol[]): void {
    // A single `declaration` node can declare multiple variables separated by
    // commas (e.g. `int a, b, c;`). We walk each init_declarator child.
    for (const child of node.namedChildren) {
      if (child.type === 'init_declarator') {
        const declarator = child.childForFieldName('declarator');
        if (!declarator) continue;
        const nameNode = this.findDeclaratorNameNode(declarator);
        if (nameNode) {
          out.push({
            name: nameNode.text,
            kind: 'variable',
            file: uri,
            line: nameNode.startPosition.row,
            column: nameNode.startPosition.column,
          });
        }
      } else if (child.type === 'function_declarator') {
        // `int foo(void);` declaration (not definition)
        const nameNode = this.findDeclaratorNameNode(child);
        if (nameNode) {
          out.push({
            name: nameNode.text,
            kind: 'function',
            file: uri,
            line: nameNode.startPosition.row,
            column: nameNode.startPosition.column,
          });
        }
      } else if (
        child.type === 'identifier' ||
        DECLARATOR_NODE_TYPES.has(child.type)
      ) {
        // Declaration without an initialiser: `extern sixstep_t motor;`,
        // `static int counter;`, `char *buffer;`.  Such a name is a real
        // definition site, and leaving it out makes "go to definition" fail
        // on everything declared this way — which is most of a project's
        // globals.
        const nameNode = this.findDeclaratorNameNode(child);
        if (nameNode) {
          out.push({
            name: nameNode.text,
            kind: 'variable',
            file: uri,
            line: nameNode.startPosition.row,
            column: nameNode.startPosition.column,
          });
        }
      }
    }
  }

  private visitTypeDef(node: SyntaxNode, uri: string, out: Symbol[]): void {
    const declarator = node.childForFieldName('declarator');
    if (!declarator) return;
    const nameNode = this.findDeclaratorNameNode(declarator);
    if (nameNode) {
      out.push({
        name: nameNode.text,
        kind: 'type',
        file: uri,
        line: nameNode.startPosition.row,
        column: nameNode.startPosition.column,
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
        line: nameNode.startPosition.row,
        column: nameNode.startPosition.column,
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
        line: nameNode.startPosition.row,
        column: nameNode.startPosition.column,
      });
    }
    // Enum constants are visited separately: the enumerators live inside an
    // `enumerator_list`, which `walk` reaches on its own.
  }

  private visitEnumerator(node: SyntaxNode, uri: string, out: Symbol[]): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    out.push({
      name: nameNode.text,
      kind: 'enum',
      file: uri,
      line: nameNode.startPosition.row,
      column: nameNode.startPosition.column,
    });
  }

  /**
   * Extract struct / union members.
   *
   * A member is a real symbol: `motor.set_direction(…)` outside the struct
   * resolves to the member declared here, and without a `symbols` row the
   * declaration is unreachable by "go to definition".
   *
   * One `field_declaration` may declare several members (`int a, b;`), so
   * every `declarator` field is visited.  A member that is itself a function
   * pointer (`int (*fp)(void)`) drills down to the name inside the
   * parenthesised declarator.
   */
  private visitFieldDeclaration(
    node: SyntaxNode,
    uri: string,
    out: Symbol[],
  ): void {
    for (let i = 0; i < node.childCount; i++) {
      if (node.fieldNameForChild(i) !== 'declarator') continue;

      const child = node.child(i);
      const nameNode = child ? this.findDeclaratorNameNode(child) : null;
      if (!nameNode) continue;

      out.push({
        name: nameNode.text,
        kind: 'variable',
        file: uri,
        line: nameNode.startPosition.row,
        column: nameNode.startPosition.column,
      });
    }
  }

  private visitMacroDef(node: SyntaxNode, uri: string, out: Symbol[]): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode) {
      out.push({
        name: nameNode.text,
        kind: 'macro',
        file: uri,
        line: nameNode.startPosition.row,
        column: nameNode.startPosition.column,
      });
    }
  }

  /**
   * Drill through pointer / array / function declarators to find the
   * innermost identifier node.
   *
   * The node is returned rather than its text so that callers can record the
   * position of the *name* and not of the declaration it sits in: a symbol
   * pointing at the return type would put the cursor at the start of the line
   * instead of on the identifier.
   */
  private findDeclaratorNameNode(node: SyntaxNode): SyntaxNode | null {
    switch (node.type) {
      case 'identifier':
      case 'type_identifier':
      case 'field_identifier':
        return node;
      default:
        break;
    }

    if (!DECLARATOR_NODE_TYPES.has(node.type)) return null;

    const inner =
      node.childForFieldName('declarator') ?? this.findDeclaratorChild(node);
    return inner ? this.findDeclaratorNameNode(inner) : null;
  }

  /**
   * Find the sub-declarator of a declarator node when it is not reachable by
   * field name.
   *
   * `parenthesized_declarator` wraps its inner declarator as an unnamed child
   * — the grammar only names it for `pointer_declarator` and friends.  A
   * function pointer (`int (*fp)(void)`) is parenthesised, so without this
   * fallback its name would never be found.
   */
  private findDeclaratorChild(node: SyntaxNode): SyntaxNode | null {
    for (const child of node.namedChildren) {
      if (DECLARATOR_NODE_TYPES.has(child.type)) return child;
    }
    return null;
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
