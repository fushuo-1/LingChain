/**
 * Line mapping for preprocessed C source.
 *
 * After `armclang -E` runs, the output contains `#line` directives (also
 * written as `# <number> "<file>"`) that record which original source file
 * and line number each preprocessed line corresponds to.
 *
 * This module parses those directives and provides a lookup from
 * preprocessed-line -> original {file, line}.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** An original source position before preprocessing. */
export interface OriginalPosition {
  /** Absolute or relative path as it appears in the #line directive. */
  file: string;
  /** 1-based line number in the original source file. */
  line: number;
}

// ---------------------------------------------------------------------------
// LineMap
// ---------------------------------------------------------------------------

/**
 * Parses `#line` / `# <n> "<file>"` directives out of preprocessed output
 * and answers position-lookup queries.
 *
 * Usage:
 *   const map = new LineMap(preprocessedContent);
 *   const pos = map.getOriginalPosition(42);
 */
export class LineMap {
  /**
   * Sparse map: preprocessed line number -> original position.
   * Only directive lines are stored; intermediate lines are resolved by
   * computing the offset from the most recent directive.
   */
  private directives: Array<{ preprocessedLine: number; file: string; originalLine: number }> = [];

  constructor(preprocessedContent: string) {
    this.parse(preprocessedContent);
  }

  /**
   * Return the original position for a 1-based preprocessed line number.
   * Returns `undefined` when no directive has been seen yet (i.e. the line
   * precedes the first `#line` directive).
   */
  getOriginalPosition(preprocessedLine: number): OriginalPosition | undefined {
    if (preprocessedLine < 1 || this.directives.length === 0) {
      return undefined;
    }

    // Find the last directive whose preprocessedLine <= the query line.
    let lo = 0;
    let hi = this.directives.length - 1;
    let idx = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.directives[mid].preprocessedLine <= preprocessedLine) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (idx < 0) {
      return undefined;
    }

    const directive = this.directives[idx];
    const offset = preprocessedLine - directive.preprocessedLine;
    return {
      file: directive.file,
      line: directive.originalLine + offset,
    };
  }

  /**
   * Return all files referenced by `#line` directives, in order of first
   * appearance.  Useful for knowing which original files are included in a
   * translation unit.
   */
  getIncludedFiles(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const d of this.directives) {
      if (!seen.has(d.file)) {
        seen.add(d.file);
        result.push(d.file);
      }
    }
    return result;
  }

  /** Number of parsed directives (exposed mainly for testing). */
  get directiveCount(): number {
    return this.directives.length;
  }

  // -- Internal -------------------------------------------------------------

  /**
   * Parse every `#line <n> "<file>"` or `# <n> "<file>"` directive.
   *
   * armclang emits the standard C preprocessor form:
   *   #line 42 "main.c"
   * or the GCC-style short form:
   *   # 42 "main.c"
   *
   * Both may optionally carry flags (e.g. `# 42 "main.c" 1`), which we
   * ignore for now.
   */
  private parse(content: string): void {
    // Matches: #line <digits> "<path>"  OR  # <digits> "<path>"
    // The path may contain escaped quotes (\\") but we rely on greedy match
    // within the quotes group.
    const directiveRe = /^#\s*(?:line\s+)?(\d+)\s+"((?:[^"\\]|\\.)*)"/gm;

    let match: RegExpExecArray | null;
    let lineNum = 1;

    for (const rawLine of content.split('\n')) {
      // Reset lastIndex for single-line matching
      directiveRe.lastIndex = 0;
      const m = directiveRe.exec(rawLine);
      if (m) {
        this.directives.push({
          preprocessedLine: lineNum,
          file: m[2],
          originalLine: parseInt(m[1], 10),
        });
      }
      lineNum++;
    }
  }
}
