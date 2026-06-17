import { DocumentSymbol, SymbolKind } from 'vscode-languageserver';
import { SymbolListProvider } from './symbolListProvider';
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

// ── Tests ────────────────────────────────────────────────────────────────

describe('SymbolListProvider', () => {
  let tmpDir: string;
  let dbPath: string;
  let index: SymbolIndex;
  let provider: SymbolListProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbollist-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    index = new SymbolIndex(dbPath);
    await index.init();
    provider = new SymbolListProvider(index);
  });

  afterEach(async () => {
    await index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. getDocumentSymbols ────────────────────────────────────────────

  describe('getDocumentSymbols', () => {
    it('should return symbols for a single file', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');

      await index.insertSymbol(
        makeSymbol({ name: 'main', kind: 'function', file: uri, line: 0, column: 4 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'counter', kind: 'variable', file: uri, line: 3, column: 10 }),
      );

      const symbols = await provider.getDocumentSymbols(uri);

      expect(symbols).toHaveLength(2);
      const names = symbols.map((s) => s.name).sort();
      expect(names).toEqual(['counter', 'main']);
    });

    it('should return empty array for file with no symbols', async () => {
      const uri = 'file:///project/empty.c';
      await index.upsertFile(uri, 'hash');

      const symbols = await provider.getDocumentSymbols(uri);
      expect(symbols).toEqual([]);
    });

    it('should return empty array for unknown URI', async () => {
      const symbols = await provider.getDocumentSymbols('file:///nonexistent.c');
      expect(symbols).toEqual([]);
    });

    it('should map function kind to SymbolKind.Function', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'init', kind: 'function', file: uri, line: 0, column: 0 }),
      );

      const symbols = await provider.getDocumentSymbols(uri);
      expect(symbols[0].kind).toBe(SymbolKind.Function);
    });

    it('should map variable kind to SymbolKind.Variable', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'x', kind: 'variable', file: uri, line: 0, column: 0 }),
      );

      const symbols = await provider.getDocumentSymbols(uri);
      expect(symbols[0].kind).toBe(SymbolKind.Variable);
    });

    it('should map type kind to SymbolKind.Class', async () => {
      const uri = 'file:///project/types.h';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'point_t', kind: 'type', file: uri, line: 0, column: 0 }),
      );

      const symbols = await provider.getDocumentSymbols(uri);
      expect(symbols[0].kind).toBe(SymbolKind.Class);
    });

    it('should map macro kind to SymbolKind.Constant', async () => {
      const uri = 'file:///project/config.h';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'MAX_SIZE', kind: 'macro', file: uri, line: 0, column: 8 }),
      );

      const symbols = await provider.getDocumentSymbols(uri);
      expect(symbols[0].kind).toBe(SymbolKind.Constant);
    });

    it('should map enum kind to SymbolKind.Enum', async () => {
      const uri = 'file:///project/enums.h';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'color_t', kind: 'enum', file: uri, line: 0, column: 0 }),
      );

      const symbols = await provider.getDocumentSymbols(uri);
      expect(symbols[0].kind).toBe(SymbolKind.Enum);
    });

    it('should set correct range for symbol name', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'doWork', kind: 'function', file: uri, line: 5, column: 12 }),
      );

      const symbols = await provider.getDocumentSymbols(uri);

      expect(symbols[0].range.start.line).toBe(5);
      expect(symbols[0].range.start.character).toBe(12);
      expect(symbols[0].range.end.line).toBe(5);
      expect(symbols[0].range.end.character).toBe(12 + 'doWork'.length);
    });

    it('should set selectionRange equal to range', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'main', kind: 'function', file: uri, line: 0, column: 4 }),
      );

      const symbols = await provider.getDocumentSymbols(uri);

      expect(symbols[0].selectionRange).toEqual(symbols[0].range);
    });

    it('should only return symbols for the requested file', async () => {
      const uriA = 'file:///project/a.c';
      const uriB = 'file:///project/b.c';

      await index.upsertFile(uriA, 'hashA');
      await index.upsertFile(uriB, 'hashB');
      await index.insertSymbol(
        makeSymbol({ name: 'funcA', kind: 'function', file: uriA, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'funcB', kind: 'function', file: uriB, line: 0, column: 0 }),
      );

      const symbolsA = await provider.getDocumentSymbols(uriA);
      expect(symbolsA).toHaveLength(1);
      expect(symbolsA[0].name).toBe('funcA');
    });

    it('should return all symbol kinds from a mixed file', async () => {
      const uri = 'file:///project/mixed.c';
      await index.upsertFile(uri, 'hash');

      const syms: Symbol[] = [
        makeSymbol({ name: 'main', kind: 'function', file: uri, line: 0, column: 4 }),
        makeSymbol({ name: 'counter', kind: 'variable', file: uri, line: 1, column: 10 }),
        makeSymbol({ name: 'MAX_SIZE', kind: 'macro', file: uri, line: 2, column: 8 }),
        makeSymbol({ name: 'point_t', kind: 'type', file: uri, line: 3, column: 12 }),
        makeSymbol({ name: 'color_t', kind: 'enum', file: uri, line: 4, column: 12 }),
      ];

      for (const s of syms) {
        await index.insertSymbol(s);
      }

      const symbols = await provider.getDocumentSymbols(uri);

      expect(symbols).toHaveLength(5);
      const kindMap = new Map(symbols.map((s) => [s.name, s.kind]));
      expect(kindMap.get('main')).toBe(SymbolKind.Function);
      expect(kindMap.get('counter')).toBe(SymbolKind.Variable);
      expect(kindMap.get('MAX_SIZE')).toBe(SymbolKind.Constant);
      expect(kindMap.get('point_t')).toBe(SymbolKind.Class);
      expect(kindMap.get('color_t')).toBe(SymbolKind.Enum);
    });
  });

  // ── 2. getWorkspaceSymbols ────────────────────────────────────────────

  describe('getWorkspaceSymbols', () => {
    it('should find symbols by substring across files', async () => {
      const uriA = 'file:///project/main.c';
      const uriB = 'file:///project/hal.c';

      await index.upsertFile(uriA, 'hashA');
      await index.upsertFile(uriB, 'hashB');
      await index.insertSymbol(
        makeSymbol({ name: 'HAL_Init', kind: 'function', file: uriA, line: 10, column: 5 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'HAL_Delay', kind: 'function', file: uriB, line: 20, column: 5 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'main', kind: 'function', file: uriA, line: 0, column: 4 }),
      );

      const results = await provider.getWorkspaceSymbols('HAL');

      expect(results).toHaveLength(2);
      const names = results.map((r) => r.name).sort();
      expect(names).toEqual(['HAL_Delay', 'HAL_Init']);
    });

    it('should return empty array for empty query', async () => {
      const results = await provider.getWorkspaceSymbols('');
      expect(results).toEqual([]);
    });

    it('should return empty array when no symbols match', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'main', kind: 'function', file: uri, line: 0, column: 4 }),
      );

      const results = await provider.getWorkspaceSymbols('xyz');
      expect(results).toEqual([]);
    });

    it('should match exact symbol name', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'init_hardware', kind: 'function', file: uri, line: 5, column: 5 }),
      );

      const results = await provider.getWorkspaceSymbols('init_hardware');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('init_hardware');
    });

    it('should include location with correct URI and range', async () => {
      const uri = 'file:///project/hal.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'HAL_Init', kind: 'function', file: uri, line: 10, column: 5 }),
      );

      const results = await provider.getWorkspaceSymbols('HAL_Init');

      expect(results).toHaveLength(1);
      expect(results[0].location.uri).toBe(uri);
      expect(results[0].location.range.start.line).toBe(10);
      expect(results[0].location.range.start.character).toBe(5);
      expect(results[0].location.range.end.character).toBe(5 + 'HAL_Init'.length);
    });

    it('should map kind correctly for all symbol types', async () => {
      const uri = 'file:///project/symbols.c';
      await index.upsertFile(uri, 'hash');

      await index.insertSymbol(
        makeSymbol({ name: 'myFunc', kind: 'function', file: uri, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'myVar', kind: 'variable', file: uri, line: 1, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'myType', kind: 'type', file: uri, line: 2, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'MY_MACRO', kind: 'macro', file: uri, line: 3, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'myEnum', kind: 'enum', file: uri, line: 4, column: 0 }),
      );

      const results = await provider.getWorkspaceSymbols('my');
      const kindMap = new Map(results.map((r) => [r.name, r.kind]));

      expect(kindMap.get('myFunc')).toBe(SymbolKind.Function);
      expect(kindMap.get('myVar')).toBe(SymbolKind.Variable);
      expect(kindMap.get('myType')).toBe(SymbolKind.Class);
      expect(kindMap.get('myEnum')).toBe(SymbolKind.Enum);
    });

    it('should be case-sensitive', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'HAL_Init', kind: 'function', file: uri, line: 0, column: 0 }),
      );

      const lower = await provider.getWorkspaceSymbols('hal');
      expect(lower).toHaveLength(0);

      const upper = await provider.getWorkspaceSymbols('HAL');
      expect(upper).toHaveLength(1);
    });

    it('should limit results to 50', async () => {
      const uri = 'file:///project/big.c';
      await index.upsertFile(uri, 'hash');

      // Insert 60 symbols that all match "sym".
      for (let i = 0; i < 60; i++) {
        await index.insertSymbol(
          makeSymbol({
            name: `sym_${i}`,
            kind: 'variable',
            file: uri,
            line: i,
            column: 0,
          }),
        );
      }

      const results = await provider.getWorkspaceSymbols('sym_');
      expect(results).toHaveLength(50);
    });

    it('should find symbols from multiple files', async () => {
      const uriA = 'file:///project/a.c';
      const uriB = 'file:///project/b.c';
      const uriC = 'file:///project/c.h';

      await index.upsertFile(uriA, 'hashA');
      await index.upsertFile(uriB, 'hashB');
      await index.upsertFile(uriC, 'hashC');
      await index.insertSymbol(
        makeSymbol({ name: 'init_board', kind: 'function', file: uriA, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'init_uart', kind: 'function', file: uriB, line: 0, column: 0 }),
      );
      await index.insertSymbol(
        makeSymbol({ name: 'INIT_TIMEOUT', kind: 'macro', file: uriC, line: 0, column: 0 }),
      );

      const results = await provider.getWorkspaceSymbols('INIT');

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('INIT_TIMEOUT');

      // "init" (lowercase) matches init_board and init_uart
      const lowerResults = await provider.getWorkspaceSymbols('init');
      expect(lowerResults).toHaveLength(2);
    });

    it('should find partial name matches', async () => {
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(
        makeSymbol({ name: 'SystemCoreClock', kind: 'variable', file: uri, line: 0, column: 0 }),
      );

      const results = await provider.getWorkspaceSymbols('Core');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('SystemCoreClock');
    });
  });
});
