/**
 * armclang preprocessor wrapper.
 *
 * Runs `armclang -E` against a source file using the compile context
 * extracted from a Keil project, then builds a `LineMap` so that
 * positions in the preprocessed output can be traced back to the original
 * source.
 */

import { execFile, ExecFileException } from 'child_process';
import * as path from 'path';
import { CompileContext } from './keilProject';
import { LineMap } from './lineMap';
import { armclangTargetFlags } from './armclangArgs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of preprocessing a single translation unit. */
export interface PreprocessedFile {
  /** URI / path of the original source file. */
  originalUri: string;
  /** Full preprocessor output (after macro expansion and include inlining). */
  preprocessedContent: string;
  /**
   * Back-mapping from preprocessed line numbers to original positions.
   * Kept as a raw Map for compatibility; use `getOriginalPosition()` to
   * query it.
   */
  lineMap: LineMap;
}

// ---------------------------------------------------------------------------
// ArmclangPreprocessor
// ---------------------------------------------------------------------------

export class ArmclangPreprocessor {
  private readonly armclangPath: string;
  private readonly compileContext: CompileContext;

  constructor(armclangPath: string, compileContext: CompileContext) {
    this.armclangPath = armclangPath;
    this.compileContext = compileContext;
  }

  /**
   * Preprocess a single source file through armclang -E.
   *
   * @param filePath Absolute path to the .c / .h file.
   * @returns A `PreprocessedFile` with the preprocessed text and a line map.
   * @throws When armclang exits with a non-zero code or cannot be spawned.
   */
  async preprocessFile(filePath: string): Promise<PreprocessedFile> {
    const args = this.buildArgs(filePath);

    const preprocessedContent = await this.runArmclang(args);

    const lineMap = new LineMap(preprocessedContent);

    return {
      originalUri: filePath,
      preprocessedContent,
      lineMap,
    };
  }

  // -- Internal -------------------------------------------------------------

  /**
   * Build the argument list for `armclang -E`.
   *
   * Includes:
   *   - `-E`            : stop after preprocessing
   *   - target flags    : `--target` (and `-mcpu` when known) so that the
   *                       target-dependent built-in macros resolve correctly
   *   - `-I <dir>`      : one per include path
   *   - `-D <macro>`    : one per define
   *   - The source file itself
   */
  buildArgs(filePath: string): string[] {
    const args: string[] = [
      '-E',
      ...armclangTargetFlags(this.compileContext.target),
    ];

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
   * Spawn armclang and return stdout.
   *
   * Rejects on spawn errors (armclang not found) or non-zero exit codes.
   */
  private runArmclang(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        this.armclangPath,
        args,
        { maxBuffer: 50 * 1024 * 1024, timeout: 30_000 },
        (error: ExecFileException | null, stdout: string, stderr: string) => {
          if (error) {
            const msg = stderr?.trim() || error.message;
            reject(
              new Error(
                `armclang preprocessing failed (exit ${error.code ?? 'unknown'}): ${msg}`
              )
            );
            return;
          }
          resolve(stdout);
        }
      );
    });
  }
}
