/**
 * Usage index and "Find All References".
 *
 * The usage table backs `textDocument/references`: it records every
 * identifier occurrence (definitions included), cascades from `files`, and
 * is discarded when the schema changes so it can be rebuilt.
 */
import { Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Database } from 'node-sqlite3-wasm';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SymbolIndex } from './symbolIndex';
import { NavigationProvider } from './navigationProvider';
import { Usage } from './symbol';

const URI = 'file:///project/main.c';

function usage(overrides: Partial<Usage> = {}): Usage {
  return { name: 'target', file: URI, line: 0, column: 0, ...overrides };
}

function docsFor(...docs: TextDocument[]) {
  const map = new Map(docs.map((d) => [d.uri, d]));
  return { get: (uri: string) => map.get(uri) };
}

describe('usage index', () => {
  let tmpDir: string;
  let index: SymbolIndex;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
    index = new SymbolIndex(path.join(tmpDir, 'test.db'));
    await index.init();
  });

  afterEach(async () => {
    await index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Storage ───────────────────────────────────────────────────────────

  it('should store and find usages by name', async () => {
    await index.upsertFile(URI, 'hash');
    await index.insertUsages([
      usage({ line: 4, column: 10 }),
      usage({ line: 0, column: 0 }),
      usage({ name: 'other', line: 9, column: 2 }),
    ]);

    const found = await index.findUsagesByName('target');

    expect(found).toEqual([
      { name: 'target', file: URI, line: 0, column: 0 },
      { name: 'target', file: URI, line: 4, column: 10 },
    ]);
  });

  it('should return nothing for an unknown name', async () => {
    expect(await index.findUsagesByName('missing')).toEqual([]);
  });

  it('should accept an empty insert', async () => {
    await expect(index.insertUsages([])).resolves.toBeUndefined();
  });

  it('should honour the result limit', async () => {
    await index.upsertFile(URI, 'hash');
    await index.insertUsages(
      Array.from({ length: 10 }, (_, i) => usage({ line: i })),
    );

    expect(await index.findUsagesByName('target', 3)).toHaveLength(3);
  });

  it('should delete usages together with their file', async () => {
    await index.upsertFile(URI, 'hash');
    await index.insertSymbol({
      name: 'target',
      kind: 'function',
      file: URI,
      line: 0,
      column: 0,
    });
    await index.insertUsages([usage(), usage({ line: 5 })]);

    await index.deleteByFile(URI);

    expect(await index.findUsagesByName('target')).toEqual([]);
    expect(await index.findByFile(URI)).toEqual([]);
  });

  // ── Schema migration ──────────────────────────────────────────────────

  it('should discard cached rows written by an older schema', async () => {
    const dbPath = path.join(tmpDir, 'legacy.db');

    const legacy = new SymbolIndex(dbPath);
    await legacy.init();
    await legacy.upsertFile(URI, 'hash');
    await legacy.insertSymbol({
      name: 'target',
      kind: 'function',
      file: URI,
      line: 0,
      column: 0,
    });
    await legacy.close();

    // Pretend the database predates the usage table.
    const raw = new Database(dbPath);
    raw.exec('PRAGMA user_version = 0');
    raw.close();

    const reopened = new SymbolIndex(dbPath);
    await reopened.init();

    expect(await reopened.findByFile(URI)).toEqual([]);
    expect(await reopened.getFileHash(URI)).toBeUndefined();
    await reopened.close();
  });

  // ── NavigationProvider ────────────────────────────────────────────────

  describe('NavigationProvider.getReferences', () => {
    it('should return every recorded occurrence', async () => {
      await index.upsertFile(URI, 'hash');
      await index.insertSymbol({
        name: 'target',
        kind: 'function',
        file: URI,
        line: 0,
        column: 0,
      });
      await index.insertUsages([
        usage({ line: 0, column: 0 }),
        usage({ line: 4, column: 10 }),
        usage({ name: 'noise', line: 5, column: 0 }),
      ]);

      const provider = new NavigationProvider(index);
      const doc = TextDocument.create(
        URI,
        'c',
        1,
        ['int target(void);', '', '', 'int caller(void) {', '  return target();', '}'].join('\n'),
      );

      const references = await provider.getReferences(
        URI,
        Position.create(0, 5),
        docsFor(doc),
      );

      expect(references).toEqual([
        {
          uri: URI,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 6 },
          },
        },
        {
          uri: URI,
          range: {
            start: { line: 4, character: 10 },
            end: { line: 4, character: 16 },
          },
        },
      ]);
    });

    it('should fall back to definitions when no usages are indexed', async () => {
      await index.upsertFile(URI, 'hash');
      await index.insertSymbol({
        name: 'target',
        kind: 'function',
        file: URI,
        line: 2,
        column: 0,
      });

      const provider = new NavigationProvider(index);
      const doc = TextDocument.create(URI, 'c', 1, 'int target(void);');

      const references = await provider.getReferences(
        URI,
        Position.create(0, 5),
        docsFor(doc),
      );

      expect(references.map((r) => r.range.start.line)).toEqual([2]);
    });
  });
});
