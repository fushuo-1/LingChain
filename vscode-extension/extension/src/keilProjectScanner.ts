import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Scan the current VS Code workspace folders for Keil .uvprojx project files.
 *
 * Searches recursively up to 5 levels deep to avoid crawling very large
 * directory trees (e.g. node_modules or build output).
 *
 * @returns Array of URIs pointing to discovered .uvprojx files.
 */
export async function scanKeilProjects(): Promise<vscode.Uri[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return [];
  }

  const results: vscode.Uri[] = [];

  for (const folder of workspaceFolders) {
    const pattern = new vscode.RelativePattern(folder, '**/*.uvprojx');
    const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 100);
    results.push(...uris);
  }

  // Sort alphabetically by basename for a stable ordering in the picker
  results.sort((a, b) =>
    path.basename(a.fsPath).localeCompare(path.basename(b.fsPath))
  );

  return results;
}

/**
 * Present a QuickPick so the user can choose which discovered Keil project
 * should be treated as the active project.
 *
 * @returns The selected project URI, or undefined if the user cancelled.
 */
export async function promptProjectSelection(): Promise<vscode.Uri | undefined> {
  const projects = await scanKeilProjects();

  if (projects.length === 0) {
    vscode.window.showWarningMessage(
      'LingµChain: No .uvprojx files found in the workspace.'
    );
    return undefined;
  }

  if (projects.length === 1) {
    return projects[0];
  }

  const items = projects.map((uri) => ({
    label: path.basename(uri.fsPath),
    description: vscode.workspace.asRelativePath(uri),
    uri,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the active Keil project',
  });

  return selected?.uri;
}
