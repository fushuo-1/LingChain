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
import * as path from 'path';
import { KeilProject, CompileContext } from './keilProject';
import { ArmclangPreprocessor } from './armclangPreprocessor';

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
let preprocessor: ArmclangPreprocessor | undefined;

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

    // Resolve armclang path — armclang ships with Keil MDK; we look for it
    // next to the .uvprojx in the default ARMCC6 bin directory.
    const armclangPath = resolveArmclangPath(project.projectDir);
    preprocessor = new ArmclangPreprocessor(armclangPath, activeContext);

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
    connection.console.log(`  armclang path: ${armclangPath}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    connection.console.error(`Failed to parse project: ${message}`);
  }
});

// ---------------------------------------------------------------------------
// Document sync — preprocess on open
// ---------------------------------------------------------------------------

documents.onDidOpen(async (event) => {
  if (!preprocessor) {
    return; // No project selected yet
  }

  const uri = event.document.uri;
  // Only preprocess .c / .h files
  if (!/\.(c|h)$/i.test(uri)) {
    return;
  }

  const filePath = uri.startsWith('file://')
    ? new URL(uri).pathname
    : uri;

  try {
    const result = await preprocessor.preprocessFile(filePath);
    connection.console.log(
      `Preprocessed ${path.basename(filePath)} — ` +
        `${result.lineMap.directiveCount} #line directives, ` +
        `${result.lineMap.getIncludedFiles().length} included files`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    connection.console.warn(
      `Preprocessing failed for ${path.basename(filePath)}: ${message}`
    );
  }
});

documents.onDidChangeContent((_change) => {
  // Phase 1: no diagnostics published yet
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the armclang executable path.
 *
 * Looks for armclang.exe (Windows) or armclang (Unix) next to the project
 * directory in the conventional Keil ARMCC6 location.  Falls back to
 * "armclang" on PATH if the conventional path does not exist.
 */
function resolveArmclangPath(projectDir: string): string {
  // Keil v5 default: <UV4 install>/ARM/ARMCC/bin/armclang
  // We accept an env override for custom installs.
  const envPath = process.env.ARMCLANG_PATH;
  if (envPath) {
    return envPath;
  }

  // Conventional location relative to the project
  const candidate = path.join(
    projectDir,
    'ARM',
    'ARMCC',
    'bin',
    process.platform === 'win32' ? 'armclang.exe' : 'armclang'
  );

  // We return the candidate even if it may not exist; armclang -E will
  // fail with a clear error that the caller can handle.
  return candidate;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

documents.listen(connection);
connection.listen();
