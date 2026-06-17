import { BackgroundIndexer } from './backgroundIndexer';
import { SymbolIndex } from './symbolIndex';
import { hashContent } from './fileHasher';
import { TreeSitterExtractor } from './treeSitterExtractor';
import { CtagsExtractor } from './ctagsExtractor';
import { ProgressReporter } from './progressReporter';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Minimal mock for vscode-languageserver Connection. */
function createMockConnection() {
  const logs: string[] = [];
  return {
    console: {
      log: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(`WARN: ${msg}`),
      error: (msg: string) => logs.push(`ERR: ${msg}`),
    },
    logs,
  };
}

/** Write a C source file to disk and return its absolute path. */
function writeSourceFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('BackgroundIndexer', () => {
  let tmpDir: string;
  let dbPath: string;
  let index: SymbolIndex;
  let extractor: TreeSitterExtractor;
  let ctagsExtractor: CtagsExtractor;
  let reporter: ProgressReporter;
  let mockConn: ReturnType<typeof createMockConnection>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgindexer-test-'));
    dbPath = path.join(tmpDir, 'test.db');

    index = new SymbolIndex(dbPath);
    await index.init();

    extractor = new TreeSitterExtractor();
    ctagsExtractor = new CtagsExtractor();

    mockConn = createMockConnection();
    reporter = new ProgressReporter(mockConn as any);
  });

  afterEach(async () => {
    await index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Indexing multiple files ────────────────────────────────────────

  it('should index all provided files and populate the symbol index', async () => {
    const mainC = writeSourceFile(tmpDir, 'main.c', [
      'int main(void) {',
      '  return 0;',
      '}',
    ].join('\n'));

    const utilC = writeSourceFile(tmpDir, 'util.c', [
      '#define MAX_BUF 256',
      'void helper(void) {}',
    ].join('\n'));

    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);
    await indexer.startIndexing([mainC, utilC]);

    // Both files should be in the index.
    const mainUri = `file:///${mainC.replace(/\\/g, '/')}`;
    const utilUri = `file:///${utilC.replace(/\\/g, '/')}`;

    const mainHash = await index.getFileHash(mainUri);
    expect(mainHash).toBeDefined();
    expect(mainHash).toBe(hashContent(fs.readFileSync(mainC, 'utf-8')));

    const utilHash = await index.getFileHash(utilUri);
    expect(utilHash).toBeDefined();
    expect(utilHash).toBe(hashContent(fs.readFileSync(utilC, 'utf-8')));
  });

  // ── 2. Skipping unchanged files ──────────────────────────────────────

  it('should skip unchanged files on subsequent indexing passes', async () => {
    const srcC = writeSourceFile(tmpDir, 'src.c', 'int x = 42;\n');
    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);

    // First pass – file is new, should be indexed.
    const result1 = await indexer.indexFile(srcC);
    expect(result1).toBe(true);

    // Second pass – file unchanged, should be skipped.
    const result2 = await indexer.indexFile(srcC);
    expect(result2).toBe(false);
  });

  it('should re-index a file when its content changes', async () => {
    const srcC = writeSourceFile(tmpDir, 'src.c', 'int x = 42;\n');
    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);

    // First pass.
    await indexer.indexFile(srcC);

    // Modify the file.
    fs.writeFileSync(srcC, 'int y = 99;\n', 'utf-8');

    // Second pass – should detect the change.
    const result = await indexer.indexFile(srcC);
    expect(result).toBe(true);

    // The new hash should be stored.
    const uri = `file:///${srcC.replace(/\\/g, '/')}`;
    const storedHash = await index.getFileHash(uri);
    expect(storedHash).toBe(hashContent('int y = 99;\n'));
  });

  // ── 3. Progress reporting ────────────────────────────────────────────

  it('should report progress via the ProgressReporter', async () => {
    const srcC = writeSourceFile(tmpDir, 'src.c', 'int main(void) { return 0; }\n');
    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);

    await indexer.startIndexing([srcC]);

    // Should have at least "Starting" and "complete" log messages.
    const messages = mockConn.logs;
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // First message should mention starting.
    expect(messages[0]).toMatch(/Starting indexing/);
    // Last message should mention complete.
    expect(messages[messages.length - 1]).toMatch(/Indexing complete/);
  });

  it('should report a 100% progress message when done', async () => {
    const srcC = writeSourceFile(tmpDir, 'src.c', '#define FOO 1\n');
    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);

    await indexer.startIndexing([srcC]);

    const lastMsg = mockConn.logs[mockConn.logs.length - 1];
    expect(lastMsg).toContain('(100%)');
  });

  // ── 4. Error handling ────────────────────────────────────────────────

  it('should handle non-existent files gracefully without throwing', async () => {
    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);

    // startIndexing should not throw even when a file does not exist.
    await expect(
      indexer.startIndexing(['/tmp/does-not-exist-12345.c']),
    ).resolves.toBeUndefined();

    // Should have reported an error in the progress messages.
    const errorLogs = mockConn.logs.filter((l) => l.includes('Error indexing'));
    expect(errorLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('should continue indexing remaining files after one fails', async () => {
    const goodFile = writeSourceFile(tmpDir, 'good.c', 'int ok = 1;\n');
    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);

    await indexer.startIndexing([
      '/tmp/nonexistent-file.c',
      goodFile,
    ]);

    // The good file should still be indexed.
    const goodUri = `file:///${goodFile.replace(/\\/g, '/')}`;
    const hash = await index.getFileHash(goodUri);
    expect(hash).toBe(hashContent('int ok = 1;\n'));
  });

  // ── 5. isRunning flag ────────────────────────────────────────────────

  it('should report isRunning correctly during and after indexing', async () => {
    const srcC = writeSourceFile(tmpDir, 'src.c', 'int x;\n');
    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);

    expect(indexer.isRunning).toBe(false);

    const promise = indexer.startIndexing([srcC]);
    // After the await below, indexing should be done.
    await promise;

    expect(indexer.isRunning).toBe(false);
  });

  // ── 6. Debounce: concurrent startIndexing calls ─────────────────────

  it('should ignore startIndexing calls while already running', async () => {
    const srcC = writeSourceFile(tmpDir, 'src.c', 'int x;\n');
    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);

    // Start first pass (don't await yet).
    const p1 = indexer.startIndexing([srcC]);
    // Immediately start a second pass – should be a no-op.
    const p2 = indexer.startIndexing([srcC]);

    await Promise.all([p1, p2]);

    // Only one "Starting" message should appear (the second call is a no-op).
    const startMsgs = mockConn.logs.filter((l) => l.includes('Starting indexing'));
    expect(startMsgs).toHaveLength(1);
  });

  // ── 7. Empty file list ───────────────────────────────────────────────

  it('should handle an empty file list without error', async () => {
    const indexer = new BackgroundIndexer(index, extractor, ctagsExtractor, reporter);
    await expect(indexer.startIndexing([])).resolves.toBeUndefined();

    // Should still report start and completion.
    expect(mockConn.logs.length).toBeGreaterThanOrEqual(2);
    expect(mockConn.logs[mockConn.logs.length - 1]).toContain('0 indexed');
  });
});
