import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Symbol } from './symbol';
import { TreeSitterExtractor } from './treeSitterExtractor';
import { CtagsExtractor } from './ctagsExtractor';
import { SymbolIndex } from './symbolIndex';
import { BackgroundIndexer } from './backgroundIndexer';
import { ProgressReporter } from './progressReporter';

// ── Language server bootstrap ────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const treeSitterExtractor = new TreeSitterExtractor();
const ctagsExtractor = new CtagsExtractor();

/** Persistent symbol index (SQLite-backed). */
let symbolIndex: SymbolIndex | null = null;

/** Background indexer – created once the symbol index is ready. */
let backgroundIndexer: BackgroundIndexer | null = null;

/** Per-document symbol cache keyed by URI (legacy, kept for real-time edits). */
const liveSymbolCache: Map<string, Symbol[]> = new Map();

connection.onInitialize((_params: InitializeParams) => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
  };
});

connection.onInitialized(async () => {
  connection.console.log('[server] LingµChain C language server initialised.');

  // Initialise the persistent symbol index.
  symbolIndex = new SymbolIndex('.lingmupchain/symbols.db');
  await symbolIndex.init();

  // Wire up the background indexer.
  const reporter = new ProgressReporter(connection);
  backgroundIndexer = new BackgroundIndexer(
    symbolIndex,
    treeSitterExtractor,
    ctagsExtractor,
    reporter,
  );
});

/**
 * Trigger background indexing for the given list of source files.
 *
 * This is called when a project is selected or a compile context is
 * resolved.  The indexer runs asynchronously so the LSP server remains
 * responsive.
 */
function startIndexingForProject(files: string[]): void {
  if (!backgroundIndexer) {
    connection.console.warn(
      '[server] Cannot start indexing – background indexer not ready.',
    );
    return;
  }
  // Fire and forget – indexing runs in the background.
  backgroundIndexer.startIndexing(files).catch((err) => {
    connection.console.error(
      `[server] Background indexing failed: ${err instanceof Error ? err.message : err}`,
    );
  });
}

// ── Symbol extraction pipeline ────────────────────────────────────────────

/**
 * (Re-)extract symbols for a single document.
 *
 * Strategy:
 *  1. Try tree-sitter (fast, in-process WASM).
 *  2. If tree-sitter is unavailable or produces zero symbols, fall back to
 *     ctags (external binary).
 *  3. If ctags also fails, use the regex fallback baked into
 *     TreeSitterExtractor.
 */
async function extractForDocument(doc: TextDocument): Promise<void> {
  const uri = doc.uri;
  const content = doc.getText();

  // Step 1 – tree-sitter (or regex fallback inside the extractor).
  let symbols = treeSitterExtractor.extractSymbols(content, uri);

  // Step 2 – ctags fallback when tree-sitter couldn't produce results.
  if (symbols.length === 0) {
    connection.console.log(
      `[server] tree-sitter produced 0 symbols for ${uri}; trying ctags…`,
    );
    try {
      // ctags needs a file path; convert URI → filesystem path.
      const filePath = uri.startsWith('file://')
        ? decodeURIComponent(uri.slice(7)).replace(/^\/([A-Z]:)/, '$1') // Windows drive letter fix
        : uri;
      symbols = await ctagsExtractor.extractSymbols(filePath);
    } catch (err) {
      connection.console.warn(
        `[server] ctags fallback failed for ${uri}: ${err}`,
      );
    }
  }

  liveSymbolCache.set(uri, symbols);

  const byKind = new Map<string, number>();
  for (const s of symbols) {
    byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  }

  const summary = [...byKind.entries()]
    .map(([k, n]) => `${k}=${n}`)
    .join(', ');

  connection.console.log(
    `[server] ${uri}: extracted ${symbols.length} symbols (${summary})`,
  );
}

// ── Document lifecycle hooks ──────────────────────────────────────────────

documents.onDidChangeContent((change) => {
  extractForDocument(change.document);
});

documents.onDidOpen((event) => {
  extractForDocument(event.document);
});

documents.onDidClose((event) => {
  liveSymbolCache.delete(event.document.uri);
});

// ── Start ────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();

// Exported for testing
export {
  liveSymbolCache as symbolIndex,
  extractForDocument,
  treeSitterExtractor,
  ctagsExtractor,
  startIndexingForProject,
};
