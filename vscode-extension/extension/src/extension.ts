import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  NotificationType,
} from 'vscode-languageclient/node';
import * as fs from 'fs';
import * as path from 'path';
import { scanKeilProjects, promptProjectSelection } from './keilProjectScanner';
import { createStatusBar, updateStatusBar } from './statusBar';

/** Payload of the custom client -> server project-selection notification. */
export interface SelectProjectParams {
  projectPath: string;
  /** Explicit armclang path; when omitted the server probes for itself. */
  armclangPath?: string;
}

/** Custom notification sent from client -> server when a project is selected. */
export const SelectProjectNotification = new NotificationType<SelectProjectParams>(
  'lingchain/selectProject'
);

let client: LanguageClient | undefined;

/**
 * Resolves once the language client has finished initializing.
 *
 * The server only registers its project-selection handler while handling
 * `initialize`, so a notification sent before that is dropped.
 */
let clientStarted: Promise<void> | undefined;

/** Path of the Keil project currently in use, if any. */
let activeProject: string | undefined;

/** Cached result of the workspace project scan. */
let projectCache: { at: number; projects: vscode.Uri[] } | undefined;
const PROJECT_CACHE_MS = 30000;

/** Append a client-side line to the extension's output channel. */
function log(message: string): void {
  client?.outputChannel?.appendLine(`[client] ${message}`);
}

/**
 * Find the Keil projects in the workspace, reusing a recent scan.
 *
 * `findFiles` walks the whole workspace, which is too slow to run on every
 * editor switch in a large (possibly OneDrive-backed) folder.
 */
async function getProjects(): Promise<vscode.Uri[]> {
  if (projectCache && Date.now() - projectCache.at < PROJECT_CACHE_MS) {
    return projectCache.projects;
  }

  const projects = await scanKeilProjects();
  projectCache = { at: Date.now(), projects };
  return projects;
}

/**
 * Find the project that owns `filePath`.
 *
 * A project owns the files under the directory holding its `.uvprojx` and
 * under that directory's parent — CubeMX keeps the project file in `MDK-ARM/`
 * while the sources sit in `Core/`, `Bsp/`, … one level up.  The deepest
 * match wins, so nested projects resolve to the innermost one.
 */
export function findOwningProject(
  projects: readonly vscode.Uri[],
  filePath: string
): vscode.Uri | undefined {
  const target = path.resolve(filePath).toLowerCase();
  let best: vscode.Uri | undefined;
  let bestLength = -1;

  for (const project of projects) {
    const projectDir = path.dirname(project.fsPath);

    for (const root of [projectDir, path.dirname(projectDir)]) {
      const prefix = path.resolve(root).toLowerCase() + path.sep;
      if (target.startsWith(prefix) && prefix.length > bestLength) {
        best = project;
        bestLength = prefix.length;
      }
    }
  }

  return best;
}

/**
 * Select the project that owns the file in `editor`, when it differs from the
 * active one.
 *
 * This is what makes a workspace holding several Keil projects usable without
 * switching manually every time the user moves between them.
 */
async function selectProjectForEditor(
  editor: vscode.TextEditor | undefined
): Promise<void> {
  const uri = editor?.document.uri;
  if (!uri || uri.scheme !== 'file') return;

  const projects = await getProjects();
  if (projects.length === 0) return;

  const owner = findOwningProject(projects, uri.fsPath);
  if (!owner || owner.fsPath === activeProject) return;

  updateStatusBar(owner.fsPath);
  notifyProjectSelected(owner.fsPath);
}

/**
 * Read the `lingchain.armclang.path` setting.
 *
 * @returns The configured path, or `undefined` when unset/blank.
 */
function getConfiguredArmclangPath(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('lingchain')
    .get<string>('armclang.path');
  return configured && configured.trim().length > 0 ? configured : undefined;
}

/**
 * Resolve the LSP server entry point.
 *
 * Resolution order:
 *  1. the explicit `lingchain.server.path` setting
 *  2. `server/out/server.js` inside the extension (packaged layout)
 *  3. `../server/out/server.js` (development layout, sibling workspace)
 */
export function resolveServerModule(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace
    .getConfiguration('lingchain')
    .get<string>('server.path');
  if (configured && configured.trim().length > 0) {
    return configured;
  }

  const bundled = context.asAbsolutePath(
    path.join('server', 'out', 'server.js')
  );
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  return context.asAbsolutePath(path.join('..', 'server', 'out', 'server.js'));
}

/**
 * Notify the language server that `projectPath` is now the active project.
 *
 * Waits for the client to finish initializing first: notifications sent
 * during startup are not delivered.
 */
function notifyProjectSelected(projectPath: string): void {
  activeProject = projectPath;

  const payload: SelectProjectParams = {
    projectPath,
    armclangPath: getConfiguredArmclangPath(),
  };

  const send = () => {
    client?.sendNotification(SelectProjectNotification, payload);
    log(`selected project: ${projectPath}`);
  };

  (clientStarted ?? Promise.resolve())
    .then(send)
    .catch((err) =>
      log(`failed to select project: ${err instanceof Error ? err.message : err}`)
    );
}

export function activate(context: vscode.ExtensionContext): void {
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
      notifyProjectSelected(uri.fsPath);
    }
  );
  context.subscriptions.push(selectProjectCmd);

  // --- Start the LSP server ---
  const serverModule = resolveServerModule(context);

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
    'LingChain Embedded C',
    serverOptions,
    clientOptions
  );

  clientStarted = client.start();
  clientStarted.catch((err) =>
    log(`language client failed to start: ${err instanceof Error ? err.message : err}`)
  );

  // --- Select a project once the server is up ---
  clientStarted
    .then(() => getProjects())
    .then((projects) => {
      log(`found ${projects.length} Keil project(s) in the workspace`);

      if (projects.length === 1) {
        updateStatusBar(projects[0].fsPath);
        notifyProjectSelected(projects[0].fsPath);
      } else if (projects.length === 0) {
        log(
          'no .uvprojx found – navigation stays empty until a Keil project folder is opened'
        );
      } else {
        log(
          'several .uvprojx found – following the file you open (or pick one via the status bar)'
        );
        void selectProjectForEditor(vscode.window.activeTextEditor);
      }
    })
    .catch((err) =>
      log(`project scan failed: ${err instanceof Error ? err.message : err}`)
    );

  // --- Follow the file the user is working on ---
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void selectProjectForEditor(editor);
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
