import { spawn } from 'child_process';
import { Symbol } from './symbol';

/**
 * Maps ctags "kind" fields to our Symbol kind taxonomy.
 *
 * See https://docs.ctags.io/en/latest/man/ctags.1.html#tag-entry for the
 * full list. We only care about the C-relevant subset.
 */
const CTAGS_KIND_MAP: Record<string, Symbol['kind']> = {
  f: 'function',  // function definitions
  v: 'variable',  // variable definitions
  d: 'macro',     // macro definitions
  t: 'type',      // typedefs
  s: 'type',      // struct names
  u: 'type',      // union names
  g: 'enum',      // enum names
  e: 'enum',      // enumerator values
};

/**
 * A single line of ctags `--output-format=json` output.
 */
interface CtagsJsonEntry {
  _type: string;
  name: string;
  path: string;
  pattern: string;
  kind?: string;
  line?: number;
}

/**
 * Extracts C symbols by invoking Universal Ctags as an external process.
 *
 * This is the fallback extractor used when tree-sitter (WASM) is unavailable
 * or fails to parse the input.
 */
export class CtagsExtractor {
  private ctagsPath: string;

  constructor(ctagsPath?: string) {
    this.ctagsPath = ctagsPath ?? 'ctags';
  }

  /**
   * Run ctags against `filePath` and return the extracted symbols.
   *
   * Rejects only when ctags itself cannot be executed (e.g. not found on
   * PATH). A non-zero exit code is treated as "no symbols" rather than an
   * error, because ctags is famously inconsistent about exit codes.
   */
  extractSymbols(filePath: string): Promise<Symbol[]> {
    return new Promise<Symbol[]>((resolve) => {
      const args = [
        '--output-format=json',
        '--fields=+n',        // include line numbers
        '--kinds-C=+fvdtsuge', // all C kinds
        '--language-force=C',
        '-f',
        '-',  // write to stdout
        filePath,
      ];

      const proc = spawn(this.ctagsPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', () => {
        // ctags binary not found or spawn failure – return empty.
        resolve([]);
      });

      proc.on('close', (code) => {
        if (code !== 0 && !stdout) {
          // Non-zero exit with no output – treat as "no symbols".
          if (stderr) {
            // Log for diagnostics but don't throw.
            console.warn(`[ctags] exited with code ${code}: ${stderr.trim()}`);
          }
          resolve([]);
          return;
        }

        resolve(this.parseOutput(stdout, filePath));
      });
    });
  }

  /**
   * Parse the newline-delimited JSON output from ctags.
   *
   * Each line is a standalone JSON object.
   */
  private parseOutput(output: string, filePath: string): Symbol[] {
    const symbols: Symbol[] = [];

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: CtagsJsonEntry;
      try {
        entry = JSON.parse(trimmed) as CtagsJsonEntry;
      } catch {
        // Skip malformed lines.
        continue;
      }

      if (entry._type !== 'tag') continue;

      const kind = entry.kind ? CTAGS_KIND_MAP[entry.kind] : undefined;
      if (!kind) continue;

      // ctags line numbers are 1-based; we store 0-based.
      const line0 = (entry.line ?? 1) - 1;

      symbols.push({
        name: entry.name,
        kind,
        file: filePath,
        line: line0,
        column: 0, // ctags doesn't provide column info in JSON mode
      });
    }

    return symbols;
  }
}
