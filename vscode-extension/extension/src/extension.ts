import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

const SERVER_ENTRY = path.join(__dirname, "..", "..", "server", "out", "server.js");

const CLIENT_ID = "lingchainEmbeddedC";
const CLIENT_NAME = "LingµChain Embedded C";

let client: LanguageClient | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.commands.registerCommand(
      "lingchain.selectProject",
      async () => {
        const files = await vscode.workspace.findFiles(
          "**/*.uvprojx",
          "**/node_modules/**"
        );
        if (files.length === 0) {
          void vscode.window.showWarningMessage(
            "No .uvprojx files found in workspace."
          );
          return;
        }
        const items = files.map((uri) => ({
          label: vscode.workspace.asRelativePath(uri),
          uri,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: "Select a µVision project to activate",
        });
        if (picked) {
          await vscode.workspace
            .getConfiguration("lingchain")
            .update("projectPath", picked.uri.fsPath, true);
          void vscode.window.showInformationMessage(
            `Active project set to: ${picked.label}`
          );
        }
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand(
      "lingchain.restartServer",
      async () => {
        if (client) {
          await client.stop();
        }
        await startClient();
        void vscode.window.showInformationMessage(
          "LingµChain language server restarted."
        );
      }
    )
  );

  context.subscriptions.push(...disposables);

  await startClient();
}

async function startClient(): Promise<void> {
  const serverOptions: ServerOptions = {
    run: {
      module: SERVER_ENTRY,
      transport: TransportKind.stdio,
    },
    debug: {
      module: SERVER_ENTRY,
      transport: TransportKind.stdio,
      options: { execArgv: ["--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "c" },
      { scheme: "file", language: "cpp" },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.uvprojx"),
    },
  };

  client = new LanguageClient(CLIENT_ID, CLIENT_NAME, serverOptions, clientOptions);

  try {
    await client.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `LingµChain language server failed to start: ${msg}`
    );
    throw err;
  }
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
