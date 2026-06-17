import { SymbolIndex } from './symbolIndex';
import { Symbol } from './symbol';
import { hashContent } from './fileHasher';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Helper: build a Symbol with sensible defaults. */
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

describe('SymbolIndex', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbolindex-test-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    // Clean up temp directory (including WAL / SHM sidecar files).
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Creating and opening the database ──────────────────────────────

  describe('init / close', () => {
    it('should create the database file on disk', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      expect(fs.existsSync(dbPath)).toBe(true);
      await index.close();
    });

    it('should be idempotent — calling init twice does not error', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      // Insert something so the schema is populated.
      await index.upsertFile('file:///a.c', 'hash1');
      // Re-init on the same path should succeed (CREATE IF NOT EXISTS).
      const index2 = new SymbolIndex(dbPath);
      await index2.init();
      const hash = await index2.getFileHash('file:///a.c');
      expect(hash).toBe('hash1');
      await index2.close();
      await index.close();
    });
  });

  // ── 2. Inserting and querying symbols by name ─────────────────────────

  describe('findByName', () => {
    it('should return an empty array when no symbols match', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///a.c', hashContent(''));
      await index.insertSymbol(makeSymbol({ name: 'foo', file: 'file:///a.c' }));

      const results = await index.findByName('nonexistent');
      expect(results).toEqual([]);
      await index.close();
    });

    it('should find symbols by exact name', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///a.c', 'hashA');
      await index.insertSymbol(makeSymbol({ name: 'doStuff', kind: 'function', file: 'file:///a.c', line: 5 }));
      await index.insertSymbol(makeSymbol({ name: 'SIZE', kind: 'macro', file: 'file:///a.c', line: 10 }));

      const results = await index.findByName('doStuff');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('doStuff');
      expect(results[0].kind).toBe('function');
      expect(results[0].line).toBe(5);
      expect(results[0].hash).toBe('hashA');
      await index.close();
    });

    it('should return symbols across multiple files with the same name', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///a.c', 'hashA');
      await index.upsertFile('file:///b.c', 'hashB');
      await index.insertSymbol(makeSymbol({ name: 'init', file: 'file:///a.c', line: 1 }));
      await index.insertSymbol(makeSymbol({ name: 'init', file: 'file:///b.c', line: 20 }));

      const results = await index.findByName('init');
      expect(results).toHaveLength(2);
      const files = results.map((r) => r.file).sort();
      expect(files).toEqual(['file:///a.c', 'file:///b.c']);
      await index.close();
    });
  });

  // ── 3. Inserting and querying symbols by file ─────────────────────────

  describe('findByFile', () => {
    it('should return an empty array for a file with no symbols', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///empty.c', 'hash');

      const results = await index.findByFile('file:///empty.c');
      expect(results).toEqual([]);
      await index.close();
    });

    it('should return all symbols belonging to a file', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      const uri = 'file:///project/main.c';
      await index.upsertFile(uri, 'hashMain');
      await index.insertSymbol(makeSymbol({ name: 'main', kind: 'function', file: uri, line: 3 }));
      await index.insertSymbol(makeSymbol({ name: 'MAX_BUF', kind: 'macro', file: uri, line: 0 }));

      const results = await index.findByFile(uri);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.hash === 'hashMain')).toBe(true);
      await index.close();
    });

    it('should include the id field in returned symbols', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      const uri = 'file:///a.c';
      await index.upsertFile(uri, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'x', kind: 'variable', file: uri }));

      const results = await index.findByFile(uri);
      expect(results[0].id).toEqual(expect.any(Number));
      await index.close();
    });
  });

  // ── 4. Deleting symbols by file ──────────────────────────────────────

  describe('deleteByFile', () => {
    it('should remove all symbols and the file record', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      const uri = 'file:///project/old.c';
      await index.upsertFile(uri, 'hashOld');
      await index.insertSymbol(makeSymbol({ name: 'old_fn', file: uri }));
      await index.insertSymbol(makeSymbol({ name: 'OLD_MACRO', kind: 'macro', file: uri }));

      await index.deleteByFile(uri);

      expect(await index.findByFile(uri)).toEqual([]);
      expect(await index.getFileHash(uri)).toBeUndefined();
      await index.close();
    });

    it('should not affect symbols in other files', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///a.c', 'hashA');
      await index.upsertFile('file:///b.c', 'hashB');
      await index.insertSymbol(makeSymbol({ name: 'fnA', file: 'file:///a.c' }));
      await index.insertSymbol(makeSymbol({ name: 'fnB', file: 'file:///b.c' }));

      await index.deleteByFile('file:///a.c');

      const remaining = await index.findByFile('file:///b.c');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('fnB');
      await index.close();
    });

    it('should be a no-op for a URI that does not exist', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      // Should not throw.
      await index.deleteByFile('file:///does-not-exist.c');
      await index.close();
    });
  });

  // ── 5. Upserting files with hash ─────────────────────────────────────

  describe('upsertFile', () => {
    it('should insert a new file record', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///new.c', 'abc123');
      expect(await index.getFileHash('file:///new.c')).toBe('abc123');
      await index.close();
    });

    it('should update the hash on conflict (same URI)', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///x.c', 'old_hash');
      await index.upsertFile('file:///x.c', 'new_hash');
      expect(await index.getFileHash('file:///x.c')).toBe('new_hash');
      await index.close();
    });

    it('should work with hashContent helper', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      const content = 'int main(void) { return 0; }';
      const hash = hashContent(content);
      await index.upsertFile('file:///main.c', hash);
      expect(await index.getFileHash('file:///main.c')).toBe(hash);
      await index.close();
    });
  });

  // ── 6. Error handling ────────────────────────────────────────────────

  describe('error handling', () => {
    it('should throw when calling methods before init()', async () => {
      const index = new SymbolIndex(dbPath);

      await expect(index.upsertFile('file:///a.c', 'h')).rejects.toThrow(
        'SymbolIndex not initialised',
      );
      await expect(index.insertSymbol(makeSymbol())).rejects.toThrow(
        'SymbolIndex not initialised',
      );
      await expect(index.findByName('x')).rejects.toThrow(
        'SymbolIndex not initialised',
      );
      await expect(index.findByFile('file:///a.c')).rejects.toThrow(
        'SymbolIndex not initialised',
      );
      await expect(index.deleteByFile('file:///a.c')).rejects.toThrow(
        'SymbolIndex not initialised',
      );
      await expect(index.getFileHash('file:///a.c')).rejects.toThrow(
        'SymbolIndex not initialised',
      );
    });

    it('should throw when inserting a symbol without a corresponding file record', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();

      // FK constraint is enabled, so inserting with a non-existent file URI
      // should reject.
      await expect(
        index.insertSymbol(makeSymbol({ file: 'file:///ghost.c' })),
      ).rejects.toThrow();
      await index.close();
    });

    it('should propagate transaction rollback on bulk insert failure', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///ok.c', 'hash');

      const symbols: Symbol[] = [
        makeSymbol({ name: 'good', file: 'file:///ok.c' }),
        makeSymbol({ name: 'bad', file: 'file:///nonexistent.c' }),
      ];

      await expect(index.insertSymbols(symbols)).rejects.toThrow();

      // The first symbol should have been rolled back.
      const results = await index.findByName('good');
      expect(results).toEqual([]);
      await index.close();
    });

    it('close() should be safe to call multiple times', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.close();
      // Second close should not throw.
      await index.close();
    });
  });
});
