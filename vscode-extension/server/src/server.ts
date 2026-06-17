import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  NotificationType,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { KeilProject, CompileContext } from './keilProject';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Custom notification matching the client
const SelectProjectNotification = new NotificationType<{ projectPath: string }>(
  'lingchain/selectProject'
);

let activeContext: CompileContext | undefined;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  connection.console.log('LingµChain Embedded C server initializing...');
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('LingµChain Embedded C server initialized.');
});

// ---------------------------------------------------------------------------
// Custom notifications
// ---------------------------------------------------------------------------

connection.onNotification(SelectProjectNotification, (params) => {
  const { projectPath } = params;
  connection.console.log(`Received project selection: ${projectPath}`);

  try {
    const project = new KeilProject(projectPath);
    project.parse();
    activeContext = project.getCompileContext();

    connection.console.log(
      `Compile context loaded — target: ${activeContext.target}`
    );
    connection.console.log(
      `  Include paths (${activeContext.includePaths.length}): ${activeContext.includePaths.join(', ')}`
    );
    connection.console.log(
      `  Defines (${activeContext.defines.length}): ${activeContext.defines.join(', ')}`
    );
    connection.console.log(
      `  Source files (${activeContext.sourceFiles.length}): ${activeContext.sourceFiles.join(', ')}`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    connection.console.error(`Failed to parse project: ${message}`);
  }
});

// ---------------------------------------------------------------------------
// Document sync (placeholder for future diagnostics)
// ---------------------------------------------------------------------------

documents.onDidChangeContent((_change) => {
  // Phase 1: no diagnostics published yet
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

documents.listen(connection);
connection.listen();
