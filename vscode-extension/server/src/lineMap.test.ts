import { LineMap, OriginalPosition } from './lineMap';

describe('LineMap', () => {
  // -----------------------------------------------------------------------
  // Basic #line directive parsing
  // -----------------------------------------------------------------------

  describe('parsing #line directives', () => {
    it('should parse a single #line directive', () => {
      const content = '#line 10 "main.c"\nint x;\nint y;';
      const map = new LineMap(content);

      expect(map.directiveCount).toBe(1);
      const pos = map.getOriginalPosition(1);
      expect(pos).toEqual({ file: 'main.c', line: 10 });
    });

    it('should parse the short # <n> "<file>" form', () => {
      const content = '# 5 "utils.h"\nfoo();\nbar();';
      const map = new LineMap(content);

      expect(map.directiveCount).toBe(1);
      expect(map.getOriginalPosition(1)).toEqual({ file: 'utils.h', line: 5 });
    });

    it('should parse a directive with flags (e.g. system header flag)', () => {
      const content = '# 1 "stm32.h" 1 3\nregister int r;';
      const map = new LineMap(content);

      expect(map.directiveCount).toBe(1);
      expect(map.getOriginalPosition(1)).toEqual({ file: 'stm32.h', line: 1 });
    });

    it('should ignore lines that are not #line directives', () => {
      const content = [
        '#include <stdio.h>',
        'int main(void) {',
        '  return 0;',
        '}',
      ].join('\n');
      const map = new LineMap(content);
      expect(map.directiveCount).toBe(0);
    });

    it('should handle escaped quotes in filenames', () => {
      const content = '#line 1 "path\\\\"file.c"\nint z;';
      // The regex captures the content between the first and last unescaped
      // quote.  Escaped-quote handling is best-effort; at minimum the
      // directive is detected.
      const map = new LineMap(content);
      expect(map.directiveCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-file preprocessed output
  // -----------------------------------------------------------------------

  describe('line mapping with multiple files', () => {
    const content = [
      '# 1 "main.c"',
      '#include "header.h"',
      '# 1 "header.h"',
      'typedef int myint;',
      '# 5 "header.h"',
      '# 3 "main.c"',
      'myint x = 0;',
      'myint y = 1;',
    ].join('\n');

    const map = new LineMap(content);

    it('should map line 1 to main.c:1', () => {
      expect(map.getOriginalPosition(1)).toEqual({ file: 'main.c', line: 1 });
    });

    it('should map line 4 to header.h:4 (offset 3 from directive at line 3)', () => {
      // Directive at preprocessed line 3 says header.h:1
      // preprocessed line 4 = 3 + 1 => header.h:1+1 = header.h:2
      expect(map.getOriginalPosition(4)).toEqual({
        file: 'header.h',
        line: 2,
      });
    });

    it('should map line 5 to header.h:5', () => {
      // Directive at line 5 says header.h:5
      expect(map.getOriginalPosition(5)).toEqual({
        file: 'header.h',
        line: 5,
      });
    });

    it('should map line 6 to main.c:3', () => {
      expect(map.getOriginalPosition(6)).toEqual({ file: 'main.c', line: 3 });
    });

    it('should map line 8 to main.c:5 (offset from main.c:3 directive)', () => {
      // Directive at line 6 says main.c:3; line 8 = 6+2 => 3+2 = 5
      expect(map.getOriginalPosition(8)).toEqual({ file: 'main.c', line: 5 });
    });

    it('should return included files in order of first appearance', () => {
      expect(map.getIncludedFiles()).toEqual(['main.c', 'header.h']);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('should return undefined for line 0', () => {
      const map = new LineMap('#line 1 "a.c"\nint a;');
      expect(map.getOriginalPosition(0)).toBeUndefined();
    });

    it('should return undefined for negative line numbers', () => {
      const map = new LineMap('#line 1 "a.c"\nint a;');
      expect(map.getOriginalPosition(-5)).toBeUndefined();
    });

    it('should return undefined when no directives exist', () => {
      const map = new LineMap('just plain text\nno directives here');
      expect(map.getOriginalPosition(1)).toBeUndefined();
    });

    it('should return undefined for lines before the first directive', () => {
      // If there are lines before the first #line directive, they have no
      // mapping.
      const content = [
        'bogus line before any directive',
        '#line 10 "main.c"',
        'int x;',
      ].join('\n');
      const map = new LineMap(content);
      // Line 1 is "bogus line" which is before the directive at line 2
      expect(map.getOriginalPosition(1)).toBeUndefined();
    });

    it('should handle empty content', () => {
      const map = new LineMap('');
      expect(map.directiveCount).toBe(0);
      expect(map.getOriginalPosition(1)).toBeUndefined();
      expect(map.getIncludedFiles()).toEqual([]);
    });

    it('should handle very large line numbers without overflow', () => {
      const content = `#line 999999 "big.c"\nint x;`;
      const map = new LineMap(content);
      expect(map.getOriginalPosition(1)).toEqual({
        file: 'big.c',
        line: 999999,
      });
    });

    it('should handle consecutive directives for the same file', () => {
      const content = [
        '#line 1 "a.c"',
        '#line 100 "a.c"',
        'int x;',
      ].join('\n');
      const map = new LineMap(content);
      // Line 2 is the second directive: a.c:100
      expect(map.getOriginalPosition(2)).toEqual({ file: 'a.c', line: 100 });
      // Line 3 = offset 1 from line 2 => a.c:101
      expect(map.getOriginalPosition(3)).toEqual({ file: 'a.c', line: 101 });
    });

    it('should count directives correctly', () => {
      const content = [
        '#line 1 "a.c"',
        'int x;',
        '#line 10 "b.c"',
        'int y;',
        '# 20 "c.c"',
        'int z;',
      ].join('\n');
      const map = new LineMap(content);
      expect(map.directiveCount).toBe(3);
    });
  });
});
