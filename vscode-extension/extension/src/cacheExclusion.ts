import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = '.lingµchain';

/**
 * Add .lingµchain/ to .gitignore if not already present
 */
export async function addToGitignore(workspaceRoot?: string): Promise<boolean> {
  const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return false;
  }

  const gitignorePath = path.join(root, '.gitignore');
  let content = '';

  try {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    // File doesn't exist, will create
  }

  const lines = content.split(/\r?\n/);
  const alreadyPresent = lines.some(
    (line) => line.trim() === CACHE_DIR || line.trim() === `${CACHE_DIR}/`
  );

  if (alreadyPresent) {
    return false;
  }

  const needsNewline = content.length > 0 && !content.endsWith('\n');
  const addition = needsNewline ? `\n${CACHE_DIR}/\n` : `${CACHE_DIR}/\n`;

  fs.appendFileSync(gitignorePath, addition, 'utf-8');
  return true;
}

/**
 * Add .lingµchain to VS Code files.exclude setting
 */
export async function addToFilesExclude(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration();
  const exclude = config.get<Record<string, boolean>>('files.exclude') ?? {};

  if (exclude[CACHE_DIR] === true || exclude[`${CACHE_DIR}/**`] === true) {
    return false;
  }

  exclude[CACHE_DIR] = true;

  await config.update(
    'files.exclude',
    exclude,
    vscode.ConfigurationTarget.Workspace
  );
  return true;
}

/**
 * Ensure both cache exclusions are applied
 */
export async function ensureCacheExclusion(workspaceRoot?: string): Promise<void> {
  await addToGitignore(workspaceRoot);
  await addToFilesExclude();
}
