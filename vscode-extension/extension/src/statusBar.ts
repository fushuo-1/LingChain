import * as vscode from 'vscode';
import * as path from 'path';

const COMMAND_ID = 'lingchain.selectProject';

let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Create and register the LingµChain status bar item.
 *
 * The item is placed on the left side of the status bar and shows the active
 * Keil project name. Clicking it triggers the project selection command.
 *
 * @param context  Extension context used for disposables.
 * @returns The created StatusBarItem.
 */
export function createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = COMMAND_ID;
  statusBarItem.tooltip = 'Select active Keil project';
  context.subscriptions.push(statusBarItem);

  // Show with default text; will be updated once a project is selected
  updateStatusBar(undefined);
  statusBarItem.show();

  return statusBarItem;
}

/**
 * Update the status bar to reflect the currently active project.
 *
 * @param projectPath  Absolute path to the .uvprojx file, or undefined
 *                     when no project is selected.
 */
export function updateStatusBar(projectPath: string | undefined): void {
  if (!statusBarItem) {
    return;
  }

  if (projectPath) {
    const name = path.basename(projectPath, '.uvprojx');
    statusBarItem.text = `LingµChain: ${name}`;
    statusBarItem.tooltip = projectPath;
  } else {
    statusBarItem.text = 'LingµChain: (no project)';
    statusBarItem.tooltip = 'Click to select active Keil project';
  }
}

/**
 * Dispose the status bar item (for testing or teardown).
 */
export function disposeStatusBar(): void {
  statusBarItem?.dispose();
  statusBarItem = undefined;
}
