import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  NotificationType,
} from 'vscode-languageclient/node';
import * as path from 'path';
import { scanKeilProjects, promptProjectSelection } from './keilProjectScanner';
import { createStatusBar, updateStatusBar } from './statusBar';
import { ensureCacheExclusion } from './cacheExclusion';

/** Custom notification sent from client -> server when a project is selected. */
export const SelectProjectNotification = new NotificationType<{ projectPath: string }>(
  'lingchain/selectProject'
);

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // --- Auto-exclude cache directory from git and file explorer ---
  ensureCacheExclusion();

  // --- Status bar ---
  createStatusBar(context);

  // --- Register the select-project command ---
  const selectProjectCmd = vscode.commands.registerCommand(
    'lingchain.selectProject',
    async () => {
      const uri = await promptProjectSelection();
      if (!uri) {
        return;
      }

      updateStatusBar(uri.fsPath);

      // Notify the language server about the new active project
      if (client) {
        client.sendNotification(SelectProjectNotification, {
          projectPath: uri.fsPath,
        });
      }
    }
  );
  context.subscriptions.push(selectProjectCmd);

  // --- Start the LSP server ---
  const serverModule = context.asAbsolutePath(
    path.join('..', 'server', 'out', 'server.js')
  );

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'c' },
      { scheme: 'file', language: 'cpp' },
    ],
  };

  client = new LanguageClient(
    'lingchainEmbeddedC',
    'LingµChain Embedded C',
    serverOptions,
    clientOptions
  );

  client.start();

  // --- Auto-select if exactly one project exists ---
  scanKeilProjects().then((projects) => {
    if (projects.length === 1) {
      updateStatusBar(projects[0].fsPath);
      if (client) {
        client.sendNotification(SelectProjectNotification, {
          projectPath: projects[0].fsPath,
        });
      }
    }
  });
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
