/**
 * Manual mock for the `vscode` module used by Jest in extension tests.
 *
 * Provides just enough surface area for `cacheExclusion` and any future
 * extension-side tests.  Individual tests can override return values via
 * jest.spyOn or by re-importing after jest.mock adjustments.
 */

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export const workspace = {
  workspaceFolders: undefined as any,
  getConfiguration: jest.fn(() => ({
    get: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
  })),
};

export const commands = {
  registerCommand: jest.fn(),
};

export const window = {
  createStatusBarItem: jest.fn(() => ({
    text: '',
    tooltip: '',
    command: '',
    show: jest.fn(),
    dispose: jest.fn(),
  })),
  showWarningMessage: jest.fn(),
  showQuickPick: jest.fn(),
};

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
};

export const RelativePattern = jest.fn();
export const StatusBarItem = jest.fn();
