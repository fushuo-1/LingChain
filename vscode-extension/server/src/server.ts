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
  Diagnostic as LspDiagnostic,
  DiagnosticSeverity as LspDiagnosticSeverity,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Symbol } from './symbol';
import { TreeSitterExtractor } from './treeSitterExtractor';
import { CtagsExtractor } from './ctagsExtractor';
import { SymbolIndex } from './symbolIndex';
import { BackgroundIndexer } from './backgroundIndexer';
import { ProgressReporter } from './progressReporter';
import { NavigationProvider } from './navigationProvider';
import { SymbolListProvider } from './symbolListProvider';
import {
  DiagnosticsProvider,
  Diagnostic as ArmclangDiagnostic,
} from './diagnosticsProvider';
import { CompileContext } from './keilProject';

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

/** Diagnostics provider – created once a compile context is available. */
let diagnosticsProvider: DiagnosticsProvider | null = null;

/** Cached diagnostics per file URI, used to avoid redundant publishes. */
const diagnosticsCache: Map<string, ArmclangDiagnostic[]> = new Map();

/** Per-document symbol cache keyed by URI (legacy, kept for real-time edits). */
const liveSymbolCache: Map<string, Symbol[]> = new Map();

connection.onInitialize((_params: InitializeParams) => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
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

  // Wire up the navigation provider.
  navigationProvider = new NavigationProvider(symbolIndex);

  // Wire up the symbol list provider.
  symbolListProvider = new SymbolListProvider(symbolIndex);
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
  if (!diagnosticsProvider) return;
  const uri = event.document.uri;
  const filePath = uri.startsWith('file://')
    ? decodeURIComponent(uri.slice(7)).replace(/^\/([A-Z]:)/, '$1')
    : uri;
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
};
