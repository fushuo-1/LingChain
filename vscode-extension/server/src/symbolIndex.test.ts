import {
  SymbolIndex,
  commonDirectory,
  projectDatabasePath,
  removeStaleLock,
  resolveProjectRoot,
} from './symbolIndex';
import { Symbol } from './symbol';
import { hashContent } from './fileHasher';
import { Database } from 'node-sqlite3-wasm';
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

  // ── 1b. Reclaiming space after a rebuild ──────────────────────────────

  describe('migration space reclamation', () => {
    /** On-disk size of the database, in bytes. */
    const fileSize = () => fs.statSync(dbPath).size;

    /**
     * Write a legacy database holding enough rows that dropping them leaves a
     * measurable hole on disk.  `DROP TABLE` only marks pages free, so without
     * `VACUUM` the file keeps its old size.
     */
    async function writeLegacyDatabase(rows: number): Promise<void> {
      const legacy = new SymbolIndex(dbPath);
      await legacy.init();
      await legacy.upsertFile('file:///a.c', 'hash');
      const filler = Array.from({ length: rows }, (_, i) => ({
        name: `symbol_${i}`,
        kind: 'function' as const,
        file: 'file:///a.c',
        line: i,
        column: 0,
      }));
      await legacy.insertSymbols(filler, 'file:///a.c');
      await legacy.close();

      const raw = new Database(dbPath);
      raw.exec('PRAGMA user_version = 0');
      raw.close();
    }

    it('should shrink the file when an older schema is discarded', async () => {
      await writeLegacyDatabase(20_000);
      const sizeBefore = fileSize();

      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.close();

      expect(fileSize()).toBeLessThan(sizeBefore);
    });

    it('should leave the rebuilt index usable after vacuuming', async () => {
      await writeLegacyDatabase(20_000);

      const index = new SymbolIndex(dbPath);
      await index.init();

      // The legacy rows are gone and the tables still work.
      expect(await index.getFileHash('file:///a.c')).toBeUndefined();
      await index.upsertFile('file:///b.c', 'fresh');
      await index.insertSymbol({
        name: 'after_rebuild',
        kind: 'function',
        file: 'file:///b.c',
        line: 1,
        column: 0,
      });

      const found = await index.findByName('after_rebuild');
      expect(found).toHaveLength(1);
      await index.close();
    });

    it('should not vacuum when the schema is already current', async () => {
      // A no-op init must not rewrite the file: VACUUM on every open would
      // cost time on each launch for nothing.
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///a.c', 'hash');
      await index.close();

      const sizeBefore = fileSize();

      const again = new SymbolIndex(dbPath);
      await again.init();
      expect(await again.getFileHash('file:///a.c')).toBe('hash');
      await again.close();

      expect(fileSize()).toBe(sizeBefore);
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

  // ── Contribution tracking / de-duplication ──────────────────────────

  describe('contribution tracking', () => {
    const HEADER = 'file:///proj/Inc/util.h';
    const MAIN = 'file:///proj/Src/main.c';

    it('should remove rows attributed to an included header', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile(HEADER, 'included');
      await index.insertSymbols(
        [makeSymbol({ name: 'util_add', file: HEADER, line: 3 })],
        MAIN,
      );
      await index.insertUsages(
        [{ name: 'util_add', file: HEADER, line: 3, column: 4 }],
        MAIN,
      );

      expect(await index.findByFile(HEADER)).toHaveLength(1);

      await index.deleteContribution(MAIN);

      expect(await index.findByFile(HEADER)).toEqual([]);
      expect(await index.findUsagesByName('util_add')).toEqual([]);
      await index.close();
    });

    it('should report one definition per position when several files see it', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile(HEADER, 'included');

      const declaration = makeSymbol({ name: 'util_add', file: HEADER, line: 3 });
      // The same header line is re-observed by every including translation
      // unit, so two rows exist with different origins.
      await index.insertSymbols([declaration], MAIN);
      await index.insertSymbols([declaration], 'file:///proj/Src/util.c');

      expect(await index.findByFile(HEADER)).toHaveLength(1);
      expect(await index.findByName('util_add')).toHaveLength(1);
      expect(await index.findBySubstring('util_add')).toHaveLength(1);
      expect(await index.findByPrefix('util_')).toHaveLength(1);
      await index.close();
    });

    it('should report one occurrence per position when several files see it', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile(HEADER, 'included');

      const occurrence = { name: 'util_add', file: HEADER, line: 3, column: 4 };
      await index.insertUsages([occurrence], MAIN);
      await index.insertUsages([occurrence], 'file:///proj/Src/util.c');

      expect(await index.findUsagesByName('util_add')).toEqual([occurrence]);
      await index.close();
    });
  });

  // ── Database location / reopen ──────────────────────────────────────

  describe('projectDatabasePath', () => {
    it('should name the database after the project plus a path hash', () => {
      const result = projectDatabasePath(
        'C:/ws/Proj',
        'C:/ws/Proj/MDK-ARM/FOC.uvprojx',
      );

      expect(path.basename(result)).toMatch(/^foc-[0-9a-f]{8}\.db$/);
    });

    it('should keep the cache inside the project directory', () => {
      const result = projectDatabasePath(
        'C:/ws/Proj',
        'C:/ws/Proj/MDK-ARM/FOC.uvprojx',
      );

      expect(result).toBe(
        path.join(
          path.resolve('C:/ws/Proj'),
          '.lingchain',
          path.basename(result),
        ),
      );
    });

    it('should differ per project and be stable for the same one', () => {
      const a = projectDatabasePath('C:/ws', 'C:/ws/MDK-ARM/a.uvprojx');
      const b = projectDatabasePath('C:/ws', 'C:/ws/MDK-ARM/b.uvprojx');

      expect(a).not.toBe(b);
      // Project paths are compared case-insensitively (Windows semantics).
      expect(projectDatabasePath('C:/ws', 'C:/WS/MDK-ARM/A.uvprojx')).toBe(a);
    });

    it('should sanitise awkward project names', () => {
      const result = projectDatabasePath(
        'C:/ws',
        'C:/ws/MDK-ARM/my proj (v2).uvprojx',
      );

      expect(path.basename(result)).toMatch(/^my_proj_v2_-[0-9a-f]{8}\.db$/);
    });
  });

  describe('resolveProjectRoot', () => {
    const norm = (p: string) => p.replace(/\\/g, '/');

    it('should use the source tree when the .uvprojx sits in a subdirectory', () => {
      // CubeMX layout: MDK-ARM/FOC.uvprojx with sources one level up.
      const root = resolveProjectRoot('C:/proj/MDK-ARM/FOC.uvprojx', [
        'C:/proj/Core/Src/main.c',
        'C:/proj/Bsp/bsp_adc/bsp_adc.c',
      ]);

      expect(norm(root)).toBe('C:/proj');
    });

    it('should fall back to the project file directory when sources live elsewhere', () => {
      const root = resolveProjectRoot('C:/proj/MDK-ARM/FOC.uvprojx', [
        'D:/shared/lib.c',
      ]);

      expect(norm(root)).toBe('C:/proj/MDK-ARM');
    });

    it('should fall back when the project lists no source files', () => {
      const root = resolveProjectRoot('C:/proj/MDK-ARM/FOC.uvprojx', []);

      expect(norm(root)).toBe('C:/proj/MDK-ARM');
    });
  });

  describe('commonDirectory', () => {
    const norm = (p: string) => p.replace(/\\/g, '/');

    it('should find the shared root of several files', () => {
      const common = commonDirectory([
        'C:/p/Core/Src/a.c',
        'C:/p/Bsp/b.c',
      ]);

      expect(norm(common as string)).toBe('C:/p');
    });

    it('should return the parent directory for a single file', () => {
      expect(norm(commonDirectory(['C:/p/Src/a.c']) as string)).toBe('C:/p/Src');
    });

    it('should return null for an empty list', () => {
      expect(commonDirectory([])).toBeNull();
    });
  });

  describe('stale file locks', () => {
    it('should clear a lock directory left behind by a killed process', async () => {
      // `node-sqlite3-wasm` takes its lock by creating `<db>.lock`; a process
      // that is killed rather than shut down leaves it behind, and every
      // later write then fails with "database is locked" — the index would
      // stop updating for good.
      fs.mkdirSync(`${dbPath}.lock`, { recursive: true });

      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///f.c', 'hash');
      await index.insertSymbol(makeSymbol({ name: 'a', file: 'file:///f.c' }));

      expect(await index.findByName('a')).toHaveLength(1);
      await index.close();
    });

    it('should report whether a leftover lock was removed', () => {
      expect(removeStaleLock(dbPath)).toBe(false);

      fs.mkdirSync(`${dbPath}.lock`);

      expect(removeStaleLock(dbPath)).toBe(true);
      expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    });

    it('should leave no lock directory behind after close', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.close();

      expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
    });
  });

  describe('reopen', () => {
    it('should switch to another database file', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///a.c', 'hash');

      const otherPath = path.join(tmpDir, 'other.db');
      await index.reopen(otherPath);

      expect(index.currentPath).toBe(otherPath);
      expect(await index.getFileHash('file:///a.c')).toBeUndefined();

      await index.upsertFile('file:///b.c', 'h2');
      expect(await index.getFileHash('file:///b.c')).toBe('h2');
      await index.close();
    });

    it('should keep data when reopening the same path', async () => {
      const index = new SymbolIndex(dbPath);
      await index.init();
      await index.upsertFile('file:///a.c', 'hash');

      await index.reopen(dbPath);

      expect(await index.getFileHash('file:///a.c')).toBe('hash');
      await index.close();
    });
  });
});
