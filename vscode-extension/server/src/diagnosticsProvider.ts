/**
 * armclang diagnostics provider.
 *
 * Runs `armclang -c` against a source file using the compile context
 * extracted from a Keil project, then parses the JSON diagnostics output
 * into LSP-compatible Diagnostic objects.
 *
 * Invocations are debounced so that rapid save sequences do not flood the
 * compiler.
 */

import { execFile, ExecFileException } from 'child_process';
import * as path from 'path';
import { CompileContext } from './keilProject';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity levels mirrored to LSP DiagnosticSeverity. */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** A single diagnostic produced by armclang. */
export interface Diagnostic {
  /** Absolute path to the source file. */
  file: string;
  /** Zero-based line number. */
  line: number;
  /** Zero-based column number. */
  column: number;
  /** Human-readable diagnostic message. */
  message: string;
  /** Severity category. */
  severity: DiagnosticSeverity;
}

// ---------------------------------------------------------------------------
// armclang JSON output format (internal)
// ---------------------------------------------------------------------------

/**
 * Shape of a single diagnostic entry in armclang's `--format=json` output.
 *
 * armclang wraps diagnostics in a top-level object:
 * ```json
 * {
 *   "diagnostics": [
 *     { "filename": "...", "line": 1, "column": 5, "message": "...", "level": "error" }
 *   ]
 * }
 * ```
 *
 * The `level` field maps to: error, warning, remark, note, fatal.
 * We collapse remark/note into 'info'.
 */
interface ArmclangJsonDiagnostic {
  filename: string;
  line: number;
  column: number;
  message: string;
  level: string;
}

interface ArmclangJsonOutput {
  diagnostics: ArmclangJsonDiagnostic[];
}

// ---------------------------------------------------------------------------
// DiagnosticsProvider
// ---------------------------------------------------------------------------

export class DiagnosticsProvider {
  private readonly armclangPath: string;
  private readonly compileContext: CompileContext;

  /** Pending debounce timer per file URI. */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Default debounce delay in milliseconds. */
  private readonly debounceMs: number;

  constructor(
    armclangPath: string,
    compileContext: CompileContext,
    debounceMs: number = 300,
  ) {
    this.armclangPath = armclangPath;
    this.compileContext = compileContext;
    this.debounceMs = debounceMs;
  }

  /**
   * Schedule diagnostics for `filePath` with debouncing.
   *
   * Returns a Promise that resolves with the diagnostics once the debounce
   * window has elapsed and the compiler has finished.  If another call for
   * the same file arrives before the timer fires, the previous promise
   * resolves with an empty array and the new call takes over.
   */
  runDiagnostics(filePath: string): Promise<Diagnostic[]> {
    return new Promise<Diagnostic[]>((resolve) => {
      // Cancel any pending timer for this file.
      const existing = this.debounceTimers.get(filePath);
      if (existing !== undefined) {
        clearTimeout(existing);
        // The old promise for the cancelled timer will never resolve —
        // we intentionally leak it; the caller should use the latest
        // returned promise.  Resolving with empty would cause spurious
        // publishDiagnostics calls.
      }

      const timer = setTimeout(() => {
        this.debounceTimers.delete(filePath);
        this.invokeCompiler(filePath)
          .then(resolve)
          .catch((_err: unknown) => {
            // Compiler invocation failure is not fatal — return empty.
            resolve([]);
          });
      }, this.debounceMs);

      this.debounceTimers.set(filePath, timer);
    });
  }

  /**
   * Invoke armclang immediately (no debounce) and return parsed diagnostics.
   *
   * Useful for one-shot checks or tests that want to bypass debouncing.
   */
  async invokeCompiler(filePath: string): Promise<Diagnostic[]> {
    const args = this.buildArgs(filePath);
    const raw = await this.runArmclang(filePath, args);
    return this.parseOutput(raw, filePath);
  }

  /**
   * Cancel all pending debounce timers.
   */
  cancelAll(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  // -- Internal ---------------------------------------------------------------

  /**
   * Build the argument list for `armclang -c --format=json`.
   *
   * Includes:
   *   - `-c`              : compile only (no link)
   *   - `--format=json`   : emit diagnostics as JSON
   *   - `-I <dir>`        : one per include path
   *   - `-D <macro>`      : one per define
   *   - The source file itself
   */
  buildArgs(filePath: string): string[] {
    const args: string[] = ['-c', '--format=json'];

    for (const inc of this.compileContext.includePaths) {
      args.push('-I', inc);
    }

    for (const def of this.compileContext.defines) {
      args.push(`-D${def}`);
    }

    args.push(filePath);

    return args;
  }

  /**
   * Spawn armclang and return stderr (where JSON diagnostics are emitted).
   *
   * armclang writes diagnostics to stderr even on success (exit 0).
   * On compile errors it still exits non-zero; we capture stderr in both
   * cases.
   */
  private runArmclang(filePath: string, args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        this.armclangPath,
        args,
        { maxBuffer: 50 * 1024 * 1024, timeout: 30_000 },
        (error: ExecFileException | null, stdout: string, stderr: string) => {
          // armclang may exit non-zero for compile errors — that is expected.
          // We only reject on spawn failures (ENOENT, etc.).
          if (error && !stderr) {
            reject(
              new Error(
                `armclang invocation failed (exit ${error.code ?? 'unknown'}): ${error.message}`
              )
            );
            return;
          }
          // Diagnostics are on stderr when using --format=json.
          resolve(stderr || stdout);
        },
      );
    });
  }

  /**
   * Parse armclang diagnostics output into our Diagnostic[] format.
   *
   * Tries JSON first, falls back to text-based parsing for older armclang
   * versions that lack `--format=json` support.
   */
  parseOutput(raw: string, _sourceFile: string): Diagnostic[] {
    if (!raw || raw.trim().length === 0) {
      return [];
    }

    // Try JSON parse first.
    const jsonDiags = this.tryParseJson(raw);
    if (jsonDiags !== null) {
      return jsonDiags;
    }

    // Fall back to text-based parsing (Keil/armclang classic output).
    return this.parseTextOutput(raw);
  }

  /**
   * Attempt to parse the raw output as armclang JSON diagnostics.
   *
   * Returns `null` when the output is not valid JSON.
   */
  private tryParseJson(raw: string): Diagnostic[] | null {
    try {
      const parsed: unknown = JSON.parse(raw);

      // armclang wraps diagnostics in { "diagnostics": [...] }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'diagnostics' in parsed &&
        Array.isArray((parsed as ArmclangJsonOutput).diagnostics)
      ) {
        return (parsed as ArmclangJsonOutput).diagnostics.map((d) =>
          this.normalizeJsonDiagnostic(d),
        );
      }

      // Some versions may emit a bare array.
      if (Array.isArray(parsed)) {
        return (parsed as ArmclangJsonDiagnostic[]).map((d) =>
          this.normalizeJsonDiagnostic(d),
        );
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Normalize a single JSON diagnostic entry to our Diagnostic type.
   */
  private normalizeJsonDiagnostic(d: ArmclangJsonDiagnostic): Diagnostic {
    return {
      file: d.filename ?? '',
      line: Math.max(0, (d.line ?? 1) - 1), // armclang lines are 1-based
      column: Math.max(0, (d.column ?? 1) - 1), // armclang columns are 1-based
      message: d.message ?? '',
      severity: this.mapLevel(d.level),
    };
  }

  /**
   * Parse text-based armclang diagnostic output.
   *
   * armclang classic format:
   *   file.c:10:5: error: undeclared identifier 'x'
   *   file.c:15:1: warning: unused variable 'y'
   */
  private parseTextOutput(raw: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    // Pattern: <file>:<line>:<column>: <level>: <message>
    // Also handles "fatal error" as a level (armclang emits this).
    const lineRe = /^(.+?):(\d+):(\d+):\s*(error|warning|remark|note|fatal(?:\s+error)?)\s*:\s*(.+)$/gm;

    let match: RegExpExecArray | null;
    while ((match = lineRe.exec(raw)) !== null) {
      diagnostics.push({
        file: match[1],
        line: Math.max(0, parseInt(match[2], 10) - 1),
        column: Math.max(0, parseInt(match[3], 10) - 1),
        message: match[5].trim(),
        severity: this.mapLevel(match[4]),
      });
    }

    return diagnostics;
  }

  /**
   * Map an armclang severity level string to our DiagnosticSeverity.
   */
  private mapLevel(level: string): DiagnosticSeverity {
    switch (level) {
      case 'error':
      case 'fatal':
      case 'fatal error':
        return 'error';
      case 'warning':
        return 'warning';
      case 'remark':
      case 'note':
      default:
        return 'info';
    }
  }
}
