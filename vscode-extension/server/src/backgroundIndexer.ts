import * as fs from 'fs';
import * as path from 'path';
import { SymbolIndex, hashContent } from './symbolIndex';
import { TreeSitterExtractor } from './treeSitterExtractor';
import { CtagsExtractor } from './ctagsExtractor';
import { ArmclangPreprocessor } from './armclangPreprocessor';
import { LineMap } from './lineMap';
import { Symbol, Usage } from './symbol';
import { ProgressReporter } from './progressReporter';
import { pathToFileUri } from './fileUri';

/**
 * Hash stored for a file that was only referenced by a `#include`, never
 * indexed on its own.  It never matches a real content hash, so the file is
 * parsed properly if it is ever handed to the indexer directly.
 */
const INCLUDED_FILE_HASH = 'included';

/**
 * Extensions the indexer accepts.  Keil projects also list assembly (`.s`),
 * which tree-sitter's C grammar cannot parse usefully.
 */
const C_EXTENSIONS = /\.(c|h)$/i;

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
 *  - **Incremental**: `indexFile` is public so a save can refresh a single
 *    file without re-walking the project.
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

  /**
   * Optional armclang preprocessor.  Set via the constructor or
   * `setPreprocessor` once a compile context is available.
   */
  private preprocessor: ArmclangPreprocessor | null;

  constructor(
    index: SymbolIndex,
    extractor: TreeSitterExtractor,
    ctagsExtractor: CtagsExtractor,
    reporter: ProgressReporter,
    preprocessor: ArmclangPreprocessor | null = null,
  ) {
    this.index = index;
    this.extractor = extractor;
    this.ctagsExtractor = ctagsExtractor;
    this.reporter = reporter;
    this.preprocessor = preprocessor;
  }

  /**
   * Enable (or disable) armclang -E preprocessing for subsequent indexing.
   *
   * Called once a compile context is available (after a project is
   * selected).  Preprocessing expands macros and inlines includes before
   * tree-sitter parsing; positions are mapped back to the original source
   * via the LineMap.  Falls back to direct parsing when unavailable.
   */
  setPreprocessor(preprocessor: ArmclangPreprocessor | null): void {
    this.preprocessor = preprocessor;
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

    // Keil projects list assembly files alongside C sources; indexing them
    // would only add noise (tree-sitter's C grammar has nothing to say about
    // them) and cost time.
    const targets = files.filter((f) => C_EXTENSIONS.test(f));
    const skippedFiles = files.length - targets.length;

    const total = targets.length;
    this.reporter.reportProgress(
      skippedFiles > 0
        ? `Starting indexing of ${total} C file(s) (skipping ${skippedFiles} non-C file(s))…`
        : `Starting indexing of ${total} file(s)…`,
      0,
    );

    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < targets.length; i++) {
      const filePath = targets[i];
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
    // 1. Remove the rows this file contributed previously: its own symbols
    //    (cascade from `files`) and anything attributed to its headers.
    await this.index.deleteByFile(uri);
    await this.index.deleteContribution(uri);

    // 2. Extract symbols and identifier usages.
    const { symbols, usages } = await this.extractFile(filePath, content, uri);

    // 3. Persist.  Preprocessing attributes symbols to the headers it inlined,
    //    so every referenced file needs a `files` row before the rows that
    //    point at it (foreign key).
    await this.index.upsertFile(uri, currentHash);
    await this.ensureFileRows(symbols, usages, uri);

    try {
      if (symbols.length > 0) {
        await this.index.insertSymbols(symbols, uri);
      }
      if (usages.length > 0) {
        await this.index.insertUsages(usages, uri);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `persisting ${symbols.length} symbol(s) and ${usages.length} usage(s) for ${uri} failed: ${detail}`,
      );
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
   * Create placeholder `files` rows for files that only appear as the
   * source of an included symbol (headers inlined by the preprocessor).
   *
   * Without these rows the symbol inserts fail the foreign key, and the file
   * could not be navigated to either.
   */
  private async ensureFileRows(
    symbols: Symbol[],
    usages: Usage[],
    ownUri: string,
  ): Promise<void> {
    const referenced = new Set<string>();
    for (const s of symbols) referenced.add(s.file);
    for (const u of usages) referenced.add(u.file);
    referenced.delete(ownUri);

    for (const file of referenced) {
      if (!file) continue;
      const existing = await this.index.getFileHash(file);
      if (existing === undefined) {
        await this.index.upsertFile(file, INCLUDED_FILE_HASH);
      }
    }
  }

  /**
   * Extract the definitions and identifier usages for `filePath`,
   * preferring armclang -E preprocessing.
   *
   * When a preprocessor is configured, the source is preprocessed first and
   * tree-sitter runs over the preprocessed output; positions are then mapped
   * back to the original source via the LineMap.  If preprocessing fails or
   * produces no symbols, we fall back to parsing the raw content directly
   * (tree-sitter with the built-in regex fallback).
   */
  private async extractFile(
    filePath: string,
    content: string,
    uri: string,
  ): Promise<{ symbols: Symbol[]; usages: Usage[] }> {
    // Make sure the WASM grammar is loaded; otherwise the extractor silently
    // degrades to the regex heuristic.
    await this.extractor.initialize();

    if (this.preprocessor) {
      try {
        const pre = await this.preprocessor.preprocessFile(filePath);
        const symbols = this.mapOriginalPositions(
          this.extractor.extractSymbols(pre.preprocessedContent, uri),
          pre.lineMap,
          uri,
        );
        const usages = this.mapOriginalPositions(
          this.extractor.extractUsages(pre.preprocessedContent, uri),
          pre.lineMap,
          uri,
        );
        if (symbols.length > 0) {
          return { symbols, usages };
        }
      } catch (err) {
        this.reporter.reportProgress(
          `Preprocessing failed for ${filePath}, falling back to direct parse: ${err instanceof Error ? err.message : err}`,
          0,
        );
      }
    }

    // Fallback – tree-sitter (or regex fallback) over the raw source.
    const direct = this.extractor.extractSymbols(content, uri);
    if (direct.length > 0) {
      return { symbols: direct, usages: this.extractor.extractUsages(content, uri) };
    }

    // Last resort – ctags, for files tree-sitter cannot make sense of.
    // ctags reports definitions only, so no usages are recorded.
    try {
      const tagged = await this.ctagsExtractor.extractSymbols(filePath);
      return {
        symbols: tagged.map((s) => ({ ...s, file: this.pathToUri(s.file) })),
        usages: [],
      };
    } catch {
      return { symbols: direct, usages: [] };
    }
  }

  /**
   * Map positions from the preprocessed output back to the original source
   * using the LineMap parsed from `#line` directives.
   *
   * Lines (0-based) are converted to 1-based for the LineMap lookup and back
   * to 0-based on the result.  The `file` field is switched to the file named
   * by the directive (so symbols originating from included headers are
   * attributed to the correct file); relative paths fall back to the file
   * being indexed.
   */
  private mapOriginalPositions<T extends { file: string; line: number }>(
    items: T[],
    lineMap: LineMap,
    fallbackUri: string,
  ): T[] {
    return items.map((item) => {
      const orig = lineMap.getOriginalPosition(item.line + 1);
      if (!orig) return item;
      return {
        ...item,
        file: this.toUri(orig.file, fallbackUri),
        line: Math.max(0, orig.line - 1),
      } as T;
    });
  }

  /**
   * Convert a (possibly relative) path from a #line directive to a
   * file:// URI, falling back to `fallbackUri` when the path is relative.
   */
  private toUri(filePath: string, fallbackUri: string): string {
    return path.isAbsolute(filePath) ? this.pathToUri(filePath) : fallbackUri;
  }

  /**
   * Convert a filesystem path to a file:// URI.
   *
   * The drive letter is upper-cased so that the same file always produces the
   * same URI, whichever side spelled it (see `fileUri.ts`).
   */
  private pathToUri(filePath: string): string {
    return pathToFileUri(filePath);
  }

  /**
   * Yield control so pending I/O callbacks and LSP requests can execute.
   */
  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }
}
