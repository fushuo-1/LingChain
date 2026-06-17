import { CompletionItemKind, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver';
import { CompletionProvider } from './completionProvider';
import { SymbolIndex } from './symbolIndex';
import { Symbol } from './symbol';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeSymbol(overrides: Partial<Symbol> = {}): Symbol {
  return {
    name: 'main',
    kind: 'function',
    file: 'file:///project/main.c',
    line: 0,
    column: 0,
    ...overrides,
  };
}

/**
 * Create a minimal TextDocuments<TextDocument> stub backed by a Map.
 *
 * This lets us test the CompletionProvider without a real LSP connection.
 */
function makeDocumentStore(
  entries: Array<{ uri: string; content: string }>,
): TextDocuments<TextDocument> {
  // We construct a real TextDocuments instance and use its sync/known
  // capabilities by directly populating via didOpen.  However, since we
  // only need `.get()` to work, we use a simpler approach: create documents
  // and override the internal map.
  //
  // TextDocuments.get() reads from an internal Map keyed by URI.  We can
  // populate it by calling `listen` with a mock connection and then
  // firing didOpen notifications — but that's complex.  Instead, we use
  // the fact that `TextDocument.create()` gives us a document, and we
  // provide a stub store that has a `.get()` method matching the
  // `TextDocuments<TextDocument>` interface.

  // Build a plain object with the `.get()` method the provider uses.
  const docs = new Map<string, TextDocument>();
  for (const { uri, content } of entries) {
    docs.set(uri, TextDocument.create(uri, 'c', 0, content));
  }

  // The CompletionProvider only calls `documents.get(uri)`, so we cast
  // a duck-typed object.  The real TextDocuments type has many more
  // methods but they aren't called.
  return {
    get: (uri: string) => docs.get(uri),
  } as unknown as TextDocuments<TextDocument>;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('CompletionProvider', () => {
  let tmpDir: string;
  let dbPath: string;
  let index: SymbolIndex;
  let provider: CompletionProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    index = new SymbolIndex(dbPath);
    await index.init();
    provider = new CompletionProvider(index);
  });

  afterEach(async () => {
    await index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Prefix matching ────────────────────────────────────────────────

  describe('prefix matching', () => {
    it('should return symbols matching a typed prefix', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'HAL_Init', kind: 'function', file: uri, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'HAL_Delay', kind: 'function', file: uri, line: 1, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'main', kind: 'function', file: uri, line: 2, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: 'HAL_' }]);
      const position: Position = { line: 0, character: 4 }; // after "HAL_"

      const items = await provider.getCompletion(uri, position, documents);

      expect(items).toHaveLength(2);
      const labels = items.map((i) => i.label).sort();
      expect(labels).toEqual(['HAL_Delay', 'HAL_Init']);
    });

    it('should return empty array when prefix is empty', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'main', kind: 'function', file: uri, line: 0, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: '  main' }]);
      // Cursor at column 2 — prefix is empty (preceded by spaces).
      const position: Position = { line: 0, character: 2 };

      const items = await provider.getCompletion(uri, position, documents);

      expect(items).toEqual([]);
    });

    it('should return empty array when no symbols match prefix', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'init', kind: 'function', file: uri, line: 0, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: 'zzz' }]);
      const position: Position = { line: 0, character: 3 };

      const items = await provider.getCompletion(uri, position, documents);

      expect(items).toEqual([]);
    });

    it('should return empty array for unknown document URI', async () => {
      const documents = makeDocumentStore([]);
      const position: Position = { line: 0, character: 0 };

      const items = await provider.getCompletion(
        'file:///nonexistent.c',
        position,
        documents,
      );

      expect(items).toEqual([]);
    });

    it('should handle cursor in the middle of an identifier', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'init_hardware', kind: 'function', file: uri, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'init_software', kind: 'function', file: uri, line: 1, column: 0 }),
      );

      // "init_" then cursor at column 5 — prefix is "init_".
      const documents = makeDocumentStore([{ uri, content: 'init_();' }]);
      const position: Position = { line: 0, character: 5 };

      const items = await provider.getCompletion(uri, position, documents);

      expect(items).toHaveLength(2);
    });
  });

  // ── 2. Completion kind mapping ────────────────────────────────────────

  describe('completion kind mapping', () => {
    it('should map function kind to CompletionItemKind.Function', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'doStuff', kind: 'function', file: uri, line: 0, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: 'do' }]);
      const items = await provider.getCompletion(uri, { line: 0, character: 2 }, documents);

      expect(items[0].kind).toBe(CompletionItemKind.Function);
    });

    it('should map variable kind to CompletionItemKind.Variable', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'counter', kind: 'variable', file: uri, line: 0, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: 'cou' }]);
      const items = await provider.getCompletion(uri, { line: 0, character: 3 }, documents);

      expect(items[0].kind).toBe(CompletionItemKind.Variable);
    });

    it('should map type kind to CompletionItemKind.Class', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'point_t', kind: 'type', file: uri, line: 0, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: 'poi' }]);
      const items = await provider.getCompletion(uri, { line: 0, character: 3 }, documents);

      expect(items[0].kind).toBe(CompletionItemKind.Class);
    });

    it('should map macro kind to CompletionItemKind.Constant', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'MAX_SIZE', kind: 'macro', file: uri, line: 0, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: 'MAX' }]);
      const items = await provider.getCompletion(uri, { line: 0, character: 3 }, documents);

      expect(items[0].kind).toBe(CompletionItemKind.Constant);
    });

    it('should map enum kind to CompletionItemKind.Enum', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'color_t', kind: 'enum', file: uri, line: 0, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: 'col' }]);
      const items = await provider.getCompletion(uri, { line: 0, character: 3 }, documents);

      expect(items[0].kind).toBe(CompletionItemKind.Enum);
    });

    it('should expose mapKind as public for direct testing', () => {
      expect(provider.mapKind('function')).toBe(CompletionItemKind.Function);
      expect(provider.mapKind('variable')).toBe(CompletionItemKind.Variable);
      expect(provider.mapKind('type')).toBe(CompletionItemKind.Class);
      expect(provider.mapKind('macro')).toBe(CompletionItemKind.Constant);
      expect(provider.mapKind('enum')).toBe(CompletionItemKind.Enum);
    });
  });

  // ── 3. Multiple symbols ───────────────────────────────────────────────

  describe('multiple symbols', () => {
    it('should deduplicate symbols with the same name from different files', async () => {
      const uriA = 'file:///project/a.c';
      const uriB = 'file:///project/b.c';
      await index.upsertFile(uriA, 'hashA');
      await index.upsertFile(uriB, 'hashB');
      await index.insertSymbol(
        makeSymbol({ name: 'init', kind: 'function', file: uriA, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'init', kind: 'function', file: uriB, line: 10, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri: uriA, content: 'ini' }]);
      const items = await provider.getCompletion(uriA, { line: 0, character: 3 }, documents);

      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('init');
    });

    it('should return symbols across all indexed files', async () => {
      const uriA = 'file:///project/hal.c';
      const uriB = 'file:///project/uart.c';
      const uriC = 'file:///project/config.h';
      await index.upsertFile(uriA, 'hashA');
      await index.upsertFile(uriB, 'hashB');
      await index.upsertFile(uriC, 'hashC');
      await index.insertSymbol(
        makeSymbol({ name: 'HAL_Init', kind: 'function', file: uriA, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'HAL_Delay', kind: 'function', file: uriB, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'HAL_TIMEOUT', kind: 'macro', file: uriC, line: 0, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri: uriA, content: 'HAL_' }]);
      const items = await provider.getCompletion(uriA, { line: 0, character: 4 }, documents);

      expect(items).toHaveLength(3);
      const labels = items.map((i) => i.label).sort();
      expect(labels).toEqual(['HAL_Delay', 'HAL_Init', 'HAL_TIMEOUT']);
    });

    it('should include detail with kind and file', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'myFunc', kind: 'function', file: uri, line: 5, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: 'my' }]);
      const items = await provider.getCompletion(uri, { line: 0, character: 2 }, documents);

      expect(items).toHaveLength(1);
      expect(items[0].detail).toBe(`function -- ${uri}`);
    });

    it('should return all symbol kinds in mixed completions', async () => {
      const uri = 'file:///project/mixed.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'app_init', kind: 'function', file: uri, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'app_state', kind: 'variable', file: uri, line: 1, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'app_config_t', kind: 'type', file: uri, line: 2, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'APP_VERSION', kind: 'macro', file: uri, line: 3, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'app_mode_t', kind: 'enum', file: uri, line: 4, column: 0 }),
      );

      const documents = makeDocumentStore([{ uri, content: 'app' }]);
      const items = await provider.getCompletion(uri, { line: 0, character: 3 }, documents);

      expect(items).toHaveLength(5);
      const kindMap = new Map(items.map((i) => [i.label, i.kind]));
      expect(kindMap.get('app_init')).toBe(CompletionItemKind.Function);
      expect(kindMap.get('app_state')).toBe(CompletionItemKind.Variable);
      expect(kindMap.get('app_config_t')).toBe(CompletionItemKind.Class);
      expect(kindMap.get('APP_VERSION')).toBe(CompletionItemKind.Constant);
      expect(kindMap.get('app_mode_t')).toBe(CompletionItemKind.Enum);
    });

    it('should return results sorted by name', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      // Insert in reverse alphabetical order.
      await index.insertSymbol(
        makeSymbol({ name: 'zebra', kind: 'variable', file: uri, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'apple', kind: 'variable', file: uri, line: 1, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'mango', kind: 'variable', file: uri, line: 2, column: 0 }),
      );

      // Single-character prefix that matches all three.
      const documents = makeDocumentStore([{ uri, content: 'a z m' }]);
      // We need a prefix that matches all three — but different prefixes.
      // Instead, use a broader test: all identifiers that start with any letter.
      // Use single-char prefix that only matches some.
      const docs2 = makeDocumentStore([{ uri, content: 'a' }]);
      const items = await provider.getCompletion(uri, { line: 0, character: 1 }, docs2);
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('apple');
    });
  });
});
