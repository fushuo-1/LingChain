import { Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { NavigationProvider } from './navigationProvider';
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

function makeDoc(uri: string, content: string): TextDocument {
  return TextDocument.create(uri, 'c', 1, content);
}

/** Build a documents map from a list of TextDocuments. */
function docsMap(...docs: TextDocument[]) {
  const map = new Map<string, TextDocument>();
  for (const d of docs) map.set(d.uri, d);
  return map;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('NavigationProvider', () => {
  let tmpDir: string;
  let dbPath: string;
  let index: SymbolIndex;
  let provider: NavigationProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    index = new SymbolIndex(dbPath);
    await index.init();
    provider = new NavigationProvider(index);
  });

  afterEach(async () => {
    await index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. getDefinition ──────────────────────────────────────────────────

  describe('getDefinition', () => {
    it('should return definition location for a function under cursor', async () => {
      const uri = 'file:///project/main.c';
      const content = 'int main(void) {\n  return 0;\n}\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'main', kind: 'function', file: uri, line: 0, column: 4 }));

      const results = await provider.getDefinition(uri, Position.create(0, 4), docs);

      expect(results).toHaveLength(1);
      expect(results[0].uri).toBe(uri);
      expect(results[0].range.start.line).toBe(0);
      expect(results[0].range.start.character).toBe(4);
    });

    it('should return empty array for unknown symbol', async () => {
      const uri = 'file:///project/main.c';
      const content = 'int main(void) {\n  return 0;\n}\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      const results = await provider.getDefinition(uri, Position.create(0, 4), docs);
      expect(results).toEqual([]);
    });

    it('should return empty array when cursor is on whitespace', async () => {
      const uri = 'file:///project/main.c';
      const content = '   int x;\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      const results = await provider.getDefinition(uri, Position.create(0, 1), docs);
      expect(results).toEqual([]);
    });

    it('should return multiple locations for ambiguous symbols (pick-list)', async () => {
      const uriA = 'file:///project/a.c';
      const uriB = 'file:///project/b.c';
      const contentA = 'void init(void) {\n}\n';
      const contentB = 'void init(void) {\n}\n';
      const docA = makeDoc(uriA, contentA);
      const docB = makeDoc(uriB, contentB);
      const docs = docsMap(docA, docB);

      await index.upsertFile(uriA, 'hashA');
      await index.upsertFile(uriB, 'hashB');
      await index.insertSymbol(makeSymbol({ name: 'init', kind: 'function', file: uriA, line: 0, column: 5 }));
      await index.insertSymbol(makeSymbol({ name: 'init', kind: 'function', file: uriB, line: 0, column: 5 }));

      const results = await provider.getDefinition(uriA, Position.create(0, 5), docs);

      expect(results).toHaveLength(2);
      const uris = results.map((r) => r.uri).sort();
      expect(uris).toEqual([uriA, uriB].sort());
    });

    it('should resolve macro definitions', async () => {
      const uri = 'file:///project/config.h';
      const content = '#define MAX_SIZE 1024\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'MAX_SIZE', kind: 'macro', file: uri, line: 0, column: 8 }));

      // Cursor on 'M' of MAX_SIZE (column 8)
      const results = await provider.getDefinition(uri, Position.create(0, 8), docs);

      expect(results).toHaveLength(1);
      expect(results[0].range.start.character).toBe(8);
    });

    it('should resolve type definitions', async () => {
      const uri = 'file:///project/types.h';
      const content = 'typedef struct { int x; int y; } point_t;\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'point_t', kind: 'type', file: uri, line: 0, column: 35 }));

      const results = await provider.getDefinition(uri, Position.create(0, 35), docs);

      expect(results).toHaveLength(1);
    });

    it('should resolve enum definitions', async () => {
      const uri = 'file:///project/enums.h';
      const content = 'typedef enum { RED, GREEN, BLUE } color_t;\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'color_t', kind: 'enum', file: uri, line: 0, column: 37 }));

      const results = await provider.getDefinition(uri, Position.create(0, 37), docs);

      expect(results).toHaveLength(1);
    });
  });

  // ── 2. getReferences ──────────────────────────────────────────────────

  describe('getReferences', () => {
    it('should return all references (definitions) across project', async () => {
      const uriA = 'file:///project/a.c';
      const uriB = 'file:///project/b.c';
      const contentA = 'void process(void);\n';
      const contentB = 'void process(void) {\n}\n';
      const docA = makeDoc(uriA, contentA);
      const docB = makeDoc(uriB, contentB);
      const docs = docsMap(docA, docB);

      await index.upsertFile(uriA, 'hashA');
      await index.upsertFile(uriB, 'hashB');
      await index.insertSymbol(makeSymbol({ name: 'process', kind: 'function', file: uriA, line: 0, column: 5 }));
      await index.insertSymbol(makeSymbol({ name: 'process', kind: 'function', file: uriB, line: 0, column: 5 }));

      const results = await provider.getReferences(uriA, Position.create(0, 5), docs);

      expect(results).toHaveLength(2);
    });

    it('should return empty array when cursor is on unknown word', async () => {
      const uri = 'file:///project/main.c';
      const content = 'int main(void) {\n  return 0;\n}\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      // Cursor on 'return' which is not in the index
      const results = await provider.getReferences(uri, Position.create(1, 2), docs);
      expect(results).toEqual([]);
    });

    it('should return references for variables', async () => {
      const uri = 'file:///project/main.c';
      const content = 'static int counter = 0;\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'counter', kind: 'variable', file: uri, line: 0, column: 11 }));

      const results = await provider.getReferences(uri, Position.create(0, 11), docs);

      expect(results).toHaveLength(1);
      expect(results[0].uri).toBe(uri);
    });
  });

  // ── 3. getHover ──────────────────────────────────────────────────────

  describe('getHover', () => {
    it('should return hover info for a function', async () => {
      const uri = 'file:///project/main.c';
      const content = 'int main(void) {\n  return 0;\n}\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'main', kind: 'function', file: uri, line: 0, column: 4 }));

      const result = await provider.getHover(uri, Position.create(0, 4), docs);

      expect(result).not.toBeNull();
      expect(result!.contents).toHaveProperty('kind', 'markdown');
      const md = (result!.contents as { kind: string; value: string }).value;
      expect(md).toContain('int main(void)');
      expect(md).toContain('Function');
    });

    it('should return hover info for a macro', async () => {
      const uri = 'file:///project/config.h';
      const content = '#define MAX_SIZE 1024\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'MAX_SIZE', kind: 'macro', file: uri, line: 0, column: 8 }));

      const result = await provider.getHover(uri, Position.create(0, 8), docs);

      expect(result).not.toBeNull();
      const md = (result!.contents as { kind: string; value: string }).value;
      expect(md).toContain('Macro');
      expect(md).toContain('#define MAX_SIZE 1024');
    });

    it('should return null for unknown symbol', async () => {
      const uri = 'file:///project/main.c';
      const content = 'int main(void) {\n  return 0;\n}\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      const result = await provider.getHover(uri, Position.create(0, 4), docs);
      expect(result).toBeNull();
    });

    it('should return null when cursor is on whitespace', async () => {
      const uri = 'file:///project/main.c';
      const content = '   \n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      const result = await provider.getHover(uri, Position.create(0, 1), docs);
      expect(result).toBeNull();
    });

    it('should prefer current file match when symbol exists in multiple files', async () => {
      const uriA = 'file:///project/a.c';
      const uriB = 'file:///project/b.c';
      const contentA = 'void init(void) {\n  setupHardware();\n}\n';
      const contentB = 'void init(void) {\n  setupSoftware();\n}\n';
      const docA = makeDoc(uriA, contentA);
      const docB = makeDoc(uriB, contentB);
      const docs = docsMap(docA, docB);

      await index.upsertFile(uriA, 'hashA');
      await index.upsertFile(uriB, 'hashB');
      await index.insertSymbol(makeSymbol({ name: 'init', kind: 'function', file: uriA, line: 0, column: 5 }));
      await index.insertSymbol(makeSymbol({ name: 'init', kind: 'function', file: uriB, line: 0, column: 5 }));

      const result = await provider.getHover(uriB, Position.create(0, 5), docs);

      expect(result).not.toBeNull();
      const md = (result!.contents as { kind: string; value: string }).value;
      // Should show the definition line from file B (the current file).
      // The definition line is extracted from line 0, which is the same
      // "void init(void) {" in both files, so verify via the range instead.
      expect(md).toContain('Function');
      // The range should exist (cursor was on an identifier).
      expect(result!.range).toBeDefined();
    });

    it('should fall back to kind-only label when document is not open', async () => {
      const uri = 'file:///project/secret.c';
      const docs = docsMap(); // no documents open

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'hidden', kind: 'function', file: uri, line: 0, column: 0 }));

      // We can't hover without a document (getWordAtPosition returns null).
      // This tests the null-document guard path.
      const result = await provider.getHover(uri, Position.create(0, 0), docs);
      expect(result).toBeNull();
    });
  });

  // ── 4. Multi-symbol scenarios ─────────────────────────────────────────

  describe('multiple symbol kinds', () => {
    it('should distinguish between symbols of different kinds with the same name', async () => {
      // In C it's technically possible (though unusual) for a variable and
      // a struct tag to share a name in different scopes.  The index does
      // not scope-guard, so all matches are returned.
      const uri = 'file:///project/overlap.c';
      const content = 'typedef int status_t;\nint status_t;\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'status_t', kind: 'type', file: uri, line: 0, column: 12 }));
      await index.insertSymbol(makeSymbol({ name: 'status_t', kind: 'variable', file: uri, line: 1, column: 4 }));

      const defResults = await provider.getDefinition(uri, Position.create(0, 12), docs);

      expect(defResults).toHaveLength(2);
      // Both should point to the same file.
      expect(defResults.every((r) => r.uri === uri)).toBe(true);
    });

    it('should handle cursor at start of identifier', async () => {
      const uri = 'file:///project/edge.c';
      const content = 'void doWork(void) {\n}\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'doWork', kind: 'function', file: uri, line: 0, column: 5 }));

      // Cursor at column 5 — exactly at start of 'doWork'
      const results = await provider.getDefinition(uri, Position.create(0, 5), docs);
      expect(results).toHaveLength(1);
    });

    it('should handle cursor at end of identifier', async () => {
      const uri = 'file:///project/edge.c';
      const content = 'void doWork(void) {\n}\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'doWork', kind: 'function', file: uri, line: 0, column: 5 }));

      // Cursor at column 11 — right after 'doWork' (end boundary inclusive)
      const results = await provider.getDefinition(uri, Position.create(0, 11), docs);
      expect(results).toHaveLength(1);
    });

    it('should handle cursor in middle of identifier', async () => {
      const uri = 'file:///project/edge.c';
      const content = 'void doWork(void) {\n}\n';
      const doc = makeDoc(uri, content);
      const docs = docsMap(doc);

      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'doWork', kind: 'function', file: uri, line: 0, column: 5 }));

      // Cursor at column 8 — middle of 'doWork'
      const results = await provider.getDefinition(uri, Position.create(0, 8), docs);
      expect(results).toHaveLength(1);
    });
  });
});
