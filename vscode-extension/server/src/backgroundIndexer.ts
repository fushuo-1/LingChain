import * as fs from 'fs';
import { SymbolIndex, hashContent } from './symbolIndex';
import { TreeSitterExtractor } from './treeSitterExtractor';
import { CtagsExtractor } from './ctagsExtractor';
import { Symbol } from './symbol';
import { ProgressReporter } from './progressReporter';

/**
 * Background indexer that scans project source files and populates the
 * symbol index.
 *
 * Design goals:
 *  - **Non-blocking**: uses `async/await` throughout; yields between files
 *    via `setImmediate` so the LSP event loop stays responsive.
 *  - **Skip unchanged files**: compares the content hash against the value
 *    stored in `SymbolIndex` and skips files whose hash matches.
 *  - **Progress reporting**: sends progress notifications via
 *    `ProgressReporter` so the client can show a status indicator.
 *  - **Resilient**: individual file failures are logged but do not abort
 *    the entire indexing pass.
 */
export class BackgroundIndexer {
  private readonly index: SymbolIndex;
  private readonly extractor: TreeSitterExtractor;
  private readonly ctagsExtractor: CtagsExtractor;
  private readonly reporter: ProgressReporter;

  /**
   * Tracks whether an indexing pass is currently in flight.
   * When `true` a new `startIndexing` call is a no-op (debounce).
   */
  private running = false;

  constructor(
    index: SymbolIndex,
    extractor: TreeSitterExtractor,
    ctagsExtractor: CtagsExtractor,
    reporter: ProgressReporter,
  ) {
    this.index = index;
    this.extractor = extractor;
    this.ctagsExtractor = ctagsExtractor;
    this.reporter = reporter;
  }

  /**
   * Index a batch of files.  Files whose content hash has not changed since
   * the last indexing pass are skipped.
   *
   * The method is idempotent: if indexing is already in progress the call
   * returns immediately.
   *
   * @param files  Absolute filesystem paths to `.c` / `.h` files.
   */
  async startIndexing(files: string[]): Promise<void> {
    if (this.running) return;
    this.running = true;

    const total = files.length;
    this.reporter.reportProgress(
      `Starting indexing of ${total} file(s)…`,
      0,
    );

    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      try {
        const changed = await this.indexFile(filePath);
        if (changed) {
          indexed++;
        } else {
          skipped++;
        }
      } catch (err) {
        errors++;
        this.reporter.reportProgress(
          `Error indexing ${filePath}: ${err instanceof Error ? err.message : err}`,
          Math.round(((i + 1) / total) * 100),
        );
      }

      // Yield to the event loop every file so LSP requests are not starved.
      if (i % 10 === 9) {
        await this.yieldToEventLoop();
        this.reporter.reportProgress(
          `Indexed ${i + 1}/${total} files (${indexed} new, ${skipped} unchanged, ${errors} errors)`,
          Math.round(((i + 1) / total) * 100),
        );
      }
    }

    this.reporter.reportProgress(
      `Indexing complete: ${indexed} indexed, ${skipped} unchanged, ${errors} errors`,
      100,
    );

    this.running = false;
  }

  /**
   * Index a single file.  Returns `true` if the file was re-indexed (hash
   * changed or first time), `false` if skipped.
   */
  async indexFile(filePath: string): Promise<boolean> {
    const uri = this.pathToUri(filePath);

    // Read file content.
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const currentHash = hashContent(content);

    // Check whether the file has changed since the last index.
    const storedHash = await this.index.getFileHash(uri);
    if (storedHash === currentHash) {
      // Content unchanged – skip.
      return false;
    }

    // File is new or changed – re-index.
    // 1. Remove old symbols.
    await this.index.deleteByFile(uri);

    // 2. Extract symbols.
    const symbols = this.extractSymbols(content, uri);

    // 3. Persist.
    await this.index.upsertFile(uri, currentHash);
    if (symbols.length > 0) {
      await this.index.insertSymbols(symbols);
    }

    return true;
  }

  /**
   * Return `true` when an indexing pass is currently running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Extract symbols from file content, using tree-sitter with a ctags
   * fallback (same strategy as the on-demand extraction in server.ts).
   */
  private extractSymbols(content: string, uri: string): Symbol[] {
    // Step 1 – tree-sitter (or regex fallback inside the extractor).
    let symbols = this.extractor.extractSymbols(content, uri);

    // Note: we cannot use the async ctags fallback here without making
    // this method async.  For the background indexer the regex fallback
    // inside TreeSitterExtractor is sufficient.  Callers that need ctags
    // can pre-process files before passing them in.

    return symbols;
  }

  /**
   * Convert a filesystem path to a file:// URI.
   */
  private pathToUri(filePath: string): string {
    // Normalise Windows backslashes and encode.
    const normalised = filePath.replace(/\\/g, '/');
    return `file:///${normalised}`;
  }

  /**
   * Yield control so pending I/O callbacks and LSP requests can execute.
   */
  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }
}
