import { Connection } from 'vscode-languageserver';

/**
 * Reports background-indexing progress to the VS Code client via LSP
 * notifications.
 *
 * Uses the `window/logMessage` notification so progress appears in the
 * Output panel.  For richer progress UIs (progress bars), the client can
 * listen to `$/progress` notifications, but `logMessage` keeps the server
 * free of custom notification types in Phase 1.
 */
export class ProgressReporter {
  private readonly connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Send a progress message to the client.
   *
   * @param message  Human-readable status line (e.g. "Indexing main.c").
   * @param percentage  0–100 progress value.  Values are clamped.
   */
  reportProgress(message: string, percentage: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
    this.connection.console.log(
      `[indexer] (${clamped}%) ${message}`,
    );
  }
}
