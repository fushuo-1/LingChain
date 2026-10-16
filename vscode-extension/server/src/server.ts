import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  DefinitionParams,
  ReferenceParams,
  HoverParams,
  DocumentSymbolParams,
  WorkspaceSymbolParams,
  CompletionParams,
  Diagnostic as LspDiagnostic,
  DiagnosticSeverity as LspDiagnosticSeverity,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { Symbol, LiveSymbolStore } from './symbol';
import { TreeSitterExtractor } from './treeSitterExtractor';
import { CtagsExtractor } from './ctagsExtractor';
import { SymbolIndex, projectDatabasePath, resolveProjectRoot } from './symbolIndex';
import { BackgroundIndexer } from './backgroundIndexer';
import { ProgressReporter } from './progressReporter';
import { NavigationProvider } from './navigationProvider';
import { SymbolListProvider } from './symbolListProvider';
import { CompletionProvider } from './completionProvider';
import { ArmclangPreprocessor } from './armclangPreprocessor';
import {
  DiagnosticsProvider,
  Diagnostic as ArmclangDiagnostic,
} from './diagnosticsProvider';
import { KeilProject, CompileContext } from './keilProject';
import { locateArmclang } from './armclangLocator';
import { fileUriToPath } from './fileUri';

// ── Language server bootstrap ────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const treeSitterExtractor = new TreeSitterExtractor();
const ctagsExtractor = new CtagsExtractor();

/** Persistent symbol index (SQLite-backed). */
let symbolIndex: SymbolIndex | null = null;

/** Background indexer – created once the symbol index is ready. */
let backgroundIndexer: BackgroundIndexer | null = null;

/** Navigation provider – created once the symbol index is ready. */
let navigationProvider: NavigationProvider | null = null;

/** Symbol list provider – created once the symbol index is ready. */
let symbolListProvider: SymbolListProvider | null = null;

/** Completion provider – created once the symbol index is ready. */
let completionProvider: CompletionProvider | null = null;

/** Diagnostics provider – created once a compile context is available. */
let diagnosticsProvider: DiagnosticsProvider | null = null;

/** Cached diagnostics per file URI, used to avoid redundant publishes. */
const diagnosticsCache: Map<string, ArmclangDiagnostic[]> = new Map();

/** Per-document symbol cache keyed by URI (legacy, kept for real-time edits). */
const liveSymbolCache: Map<string, Symbol[]> = new Map();

/** Read-only view over the live symbol cache, handed to the providers. */
let liveSymbols: LiveSymbolStore | null = null;

/**
 * Resolves once `onInitialized` has finished wiring up the index and
 * providers.  Project selection must wait for it: the notification can
 * arrive while the database and grammar are still loading, and acting on it
 * then would silently index nothing.
 */
let whenReady: Promise<void> = Promise.resolve();
let markReady: () => void = () => {};
whenReady = new Promise<void>((resolve) => {
  markReady = resolve;
});

// ── Path helpers ────────────────────────────────────────────────────────

/**
 * Convert a `file://` URI to a filesystem path (Windows drive letters
 * included).  Non-file URIs are returned unchanged.
 */
export function uriToFilePath(uri: string): string {
  return fileUriToPath(uri);
}

/**
 * Wrap the live symbol cache in the read-only interface the providers
 * consume.
 */
export function createLiveSymbolStore(
  cache: Map<string, Symbol[]>,
): LiveSymbolStore {
  return {
    get: (uri) => cache.get(uri),
    all: () => [...cache.values()].flat(),
  };
}

connection.onInitialize(() => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      completionProvider: {},
    },
  };
});

connection.onInitialized(async () => {
  try {
    connection.console.log('[server] LingChain C language server initialised.');

    // Load the C grammar once up front so symbol extraction uses tree-sitter
    // rather than quietly falling back to the regex heuristic.
    await treeSitterExtractor.initialize();
    if (!treeSitterExtractor.isReady) {
      connection.console.warn(
        `[server] tree-sitter unavailable (${treeSitterExtractor.lastInitError ?? 'unknown reason'}) – falling back to regex symbol extraction.`,
      );
    } else {
      connection.console.log('[server] tree-sitter C grammar loaded.');
    }

    // Until a project is selected the index is an in-memory placeholder.
    // Putting a file here instead would leave a stray `.lingchain/` in the
    // workspace root, separate from the project's own cache (see
    // `projectDatabasePath`).  Selecting a project reopens the index on that
    // project's file.
    symbolIndex = new SymbolIndex(':memory:');
    await symbolIndex.init();

    // Live symbols (open documents, including unsaved edits) take precedence
    // over the persisted index in every provider.
    liveSymbols = createLiveSymbolStore(liveSymbolCache);

    // Wire up the background indexer.
    const reporter = new ProgressReporter(connection);
    backgroundIndexer = new BackgroundIndexer(
      symbolIndex,
      treeSitterExtractor,
      ctagsExtractor,
      reporter,
    );

    // Wire up the navigation provider.
    navigationProvider = new NavigationProvider(symbolIndex, liveSymbols);

    // Wire up the symbol list provider.
    symbolListProvider = new SymbolListProvider(symbolIndex, liveSymbols);

    // Wire up the completion provider.
    completionProvider = new CompletionProvider(symbolIndex, liveSymbols);
  } finally {
    markReady();
  }
});

// Releasing the index on shutdown drops its file lock.  Without this the
// `.lock` directory would be left to the next start, which recovers by
// removing it (see `removeStaleLock`).
connection.onShutdown(async () => {
  await symbolIndex?.close();
});

// ── Project selection ──────────────────────────────────────────────────

/**
 * Handle the client's `lingchain/selectProject` notification.
 *
 * Loads the selected Keil project, starts background indexing of its source
 * files, and initialises the diagnostics provider.  armclang is discovered
 * on PATH (the client may later send an explicit path).
 */
connection.onNotification(
  'lingchain/selectProject',
  async (params: { projectPath: string; armclangPath?: string }) => {
    // Wait until the index and providers exist: this notification can arrive
    // while `onInitialized` is still loading the grammar and database.
    await whenReady;

    const projectPath = params?.projectPath;
    if (!projectPath) return;
    connection.console.log(
      `[server] Active Keil project selected: ${projectPath}`,
    );

    try {
      const project = new KeilProject(projectPath);
      project.parse();
      const compileContext = project.getCompileContext();

      // Switch the index to this project's own database before indexing, so
      // switching projects never mixes their symbols.  The cache lives next
      // to the project's sources, under `<project root>/.lingchain/`.
      if (symbolIndex) {
        const projectRoot = resolveProjectRoot(
          projectPath,
          compileContext.sourceFiles,
        );
        const dbPath = projectDatabasePath(projectRoot, projectPath);
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        await symbolIndex.reopen(dbPath);
        connection.console.log(`[server] project root: ${projectRoot}`);
        connection.console.log(`[server] index database: ${dbPath}`);
      }

      // Locate armclang: an explicit client setting wins, otherwise probe
      // environment variables, the Keil registry, common install paths and
      // finally PATH.  Without it both preprocessing and diagnostics are
      // disabled rather than silently failing per file.
      const armclang = locateArmclang(params?.armclangPath);
      if (armclang) {
        connection.console.log(
          `[server] armclang resolved from ${armclang.source}: ${armclang.path}`,
        );
      } else {
        connection.console.warn(
          '[server] armclang not found – preprocessing and diagnostics disabled. ' +
            'Set lingchain.armclang.path, KEIL_ARMCLANG, or install Keil MDK.',
        );
      }

      // Enable armclang -E preprocessing for the background indexer now
      // that a compile context is available.  Positions in the preprocessed
      // output are mapped back to the original source via the LineMap;
      // indexing falls back to direct parsing when armclang is unavailable.
      if (backgroundIndexer) {
        backgroundIndexer.setPreprocessor(
          armclang
            ? new ArmclangPreprocessor(armclang.path, compileContext)
            : null,
        );
      }

      if (compileContext.sourceFiles.length > 0) {
        startIndexingForProject(compileContext.sourceFiles);
      } else {
        connection.console.warn(
          `[server] No source files found in project ${projectPath}.`,
        );
      }

      // Phase 2 – ground-truth diagnostics from the target toolchain.
      if (armclang) {
        initializeDiagnostics(armclang.path, compileContext);
      }
    } catch (err) {
      connection.console.error(
        `[server] Failed to load project ${projectPath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  },
);

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

// ── Diagnostics pipeline ────────────────────────────────────────────────

/**
 * Initialise the diagnostics provider with a compile context.
 *
 * Called when a Keil project is loaded and a compile context has been
 * resolved.  The armclang binary path can be provided by the client or
 * discovered on PATH.
 */
function initializeDiagnostics(
  armclangPath: string,
  compileContext: CompileContext,
): void {
  diagnosticsProvider = new DiagnosticsProvider(armclangPath, compileContext);
  connection.console.log(
    `[server] Diagnostics provider initialised (armclang: ${armclangPath}).`,
  );
}

/**
 * Convert our internal Diagnostic type to an LSP Diagnostic.
 */
function toLspDiagnostic(d: ArmclangDiagnostic): LspDiagnostic {
  const severityMap: Record<string, LspDiagnosticSeverity> = {
    error: LspDiagnosticSeverity.Error,
    warning: LspDiagnosticSeverity.Warning,
    info: LspDiagnosticSeverity.Information,
  };

  return {
    range: {
      start: { line: d.line, character: d.column },
      end: { line: d.line, character: d.column + 1 },
    },
    severity: severityMap[d.severity] ?? LspDiagnosticSeverity.Information,
    message: d.message,
    source: 'armclang',
  };
}

/**
 * Run diagnostics on a file and publish the results to the client.
 *
 * Results are cached per URI; if the diagnostics have not changed since
 * the last publish, the redundant notification is skipped.
 */
async function publishDiagnosticsForFile(filePath: string, uri: string): Promise<void> {
  if (!diagnosticsProvider) return;

  try {
    const results = await diagnosticsProvider.runDiagnostics(filePath);

    // Convert to LSP diagnostics.
    const lspDiags = results.map(toLspDiagnostic);

    // Only publish if the diagnostics have actually changed.
    const prev = diagnosticsCache.get(uri);
    const prevJson = prev ? JSON.stringify(prev) : '';
    const nextJson = JSON.stringify(results);
    if (prevJson === nextJson) return;

    diagnosticsCache.set(uri, results);
    connection.sendDiagnostics({ uri, diagnostics: lspDiags });
  } catch (err) {
    connection.console.error(
      `[server] Diagnostics failed for ${uri}: ${err instanceof Error ? err.message : err}`,
    );
  }
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

  // Make sure the WASM grammar is loaded before extracting; otherwise the
  // extractor silently degrades to the regex heuristic.
  await treeSitterExtractor.initialize();

  // Step 1 – tree-sitter (or regex fallback inside the extractor).
  let symbols = treeSitterExtractor.extractSymbols(content, uri);

  // Step 2 – ctags fallback when tree-sitter couldn't produce results.
  if (symbols.length === 0) {
    connection.console.log(
      `[server] tree-sitter produced 0 symbols for ${uri}; trying ctags…`,
    );
    try {
      symbols = await ctagsExtractor.extractSymbols(uriToFilePath(uri));
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
  // Clear diagnostics when a document is closed.
  if (diagnosticsProvider) {
    diagnosticsProvider.cancelAll();
  }
  diagnosticsCache.delete(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

// Note: onDidSave requires the client to send textDocument/didSave notifications.
// The VS Code client sends these when the document is saved.
documents.onDidSave?.((event) => {
  const uri = event.document.uri;
  const filePath = uriToFilePath(uri);

  // Keep the persisted index in step with what is on disk, so navigation and
  // completion survive a restart without a full re-index.
  if (backgroundIndexer) {
    backgroundIndexer.indexFile(filePath).catch((err) => {
      connection.console.warn(
        `[server] Incremental indexing failed for ${uri}: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  if (!diagnosticsProvider) return;
  publishDiagnosticsForFile(filePath, uri).catch((err) => {
    connection.console.error(
      `[server] publishDiagnosticsForFile failed: ${err instanceof Error ? err.message : err}`,
    );
  });
});

// ── Navigation handlers ─────────────────────────────────────────────────

connection.onDefinition((params: DefinitionParams) => {
  if (!navigationProvider) return [];
  return navigationProvider.getDefinition(
    params.textDocument.uri,
    params.position,
    documents,
  );
});

connection.onReferences((params: ReferenceParams) => {
  if (!navigationProvider) return [];
  return navigationProvider.getReferences(
    params.textDocument.uri,
    params.position,
    documents,
  );
});

connection.onHover((params: HoverParams) => {
  if (!navigationProvider) return null;
  return navigationProvider.getHover(
    params.textDocument.uri,
    params.position,
    documents,
  );
});

// ── Completion handler ─────────────────────────────────────────────────

connection.onCompletion((params: CompletionParams) => {
  if (!completionProvider) return [];
  return completionProvider.getCompletion(
    params.textDocument.uri,
    params.position,
    documents,
  );
});

// ── Symbol list handlers ────────────────────────────────────────────────

connection.onDocumentSymbol((params: DocumentSymbolParams) => {
  if (!symbolListProvider) return [];
  return symbolListProvider.getDocumentSymbols(params.textDocument.uri);
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams) => {
  if (!symbolListProvider) return [];
  return symbolListProvider.getWorkspaceSymbols(params.query);
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
  initializeDiagnostics,
  publishDiagnosticsForFile,
  toLspDiagnostic,
  diagnosticsProvider,
  navigationProvider,
  symbolListProvider,
  completionProvider,
};