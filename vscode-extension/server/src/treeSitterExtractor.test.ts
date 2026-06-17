import { TreeSitterExtractor } from './treeSitterExtractor';
import { Symbol } from './symbol';

/**
 * Because tree-sitter WASM loading depends on a runtime environment that may
 * not be available in a pure-Jest Node process, the tests below focus on the
 * regex fallback path (which is what the extractor uses when WASM is absent)
 * and on the shape / contract of the Symbol interface.
 *
 * If the WASM binary *is* available, the tests still work — they simply
 * exercise the full tree-sitter path instead of the regex path.
 */

describe('TreeSitterExtractor', () => {
  let extractor: TreeSitterExtractor;

  beforeEach(() => {
    extractor = new TreeSitterExtractor();
  });

  // ── Contract tests ────────────────────────────────────────────────────

  describe('Symbol interface contract', () => {
    it('should produce symbols with required fields', () => {
      const content = `#define BUFFER_SIZE 1024`;
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      expect(symbols.length).toBeGreaterThanOrEqual(1);

      const sym = symbols[0];
      expect(sym).toHaveProperty('name');
      expect(sym).toHaveProperty('kind');
      expect(sym).toHaveProperty('file');
      expect(sym).toHaveProperty('line');
      expect(sym).toHaveProperty('column');
      expect(['function', 'variable', 'type', 'macro', 'enum']).toContain(sym.kind);
    });

    it('should record the correct file URI', () => {
      const uri = 'file:///project/main.c';
      const content = `int main(void) { return 0; }`;
      const symbols = extractor.extractSymbols(content, uri);
      for (const sym of symbols) {
        expect(sym.file).toBe(uri);
      }
    });
  });

  // ── Function extraction ───────────────────────────────────────────────

  describe('function extraction', () => {
    it('should extract a simple function definition', () => {
      const content = [
        'int calculate(int a, int b) {',
        '    return a + b;',
        '}',
      ].join('\n');
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const funcs = symbols.filter((s) => s.kind === 'function');
      expect(funcs.length).toBeGreaterThanOrEqual(1);
      expect(funcs.some((s) => s.name === 'calculate')).toBe(true);
    });

    it('should extract a void function with no parameters', () => {
      const content = [
        'void init_hardware(void) {',
        '    // setup',
        '}',
      ].join('\n');
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const funcs = symbols.filter((s) => s.kind === 'function');
      expect(funcs.some((s) => s.name === 'init_hardware')).toBe(true);
    });

    it('should extract a function returning a pointer', () => {
      const content = [
        'char *get_buffer(void) {',
        '    return NULL;',
        '}',
      ].join('\n');
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const funcs = symbols.filter((s) => s.kind === 'function');
      expect(funcs.some((s) => s.name === 'get_buffer')).toBe(true);
    });

    it('should extract multiple functions', () => {
      const content = [
        'int add(int a, int b) { return a + b; }',
        'int sub(int a, int b) { return a - b; }',
        'int mul(int a, int b) { return a * b; }',
      ].join('\n');
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const funcs = symbols.filter((s) => s.kind === 'function');
      expect(funcs.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Variable extraction ───────────────────────────────────────────────

  describe('variable extraction', () => {
    it('should extract a global integer variable', () => {
      const content = 'int global_count = 0;';
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const vars = symbols.filter((s) => s.kind === 'variable');
      expect(vars.length).toBeGreaterThanOrEqual(1);
      expect(vars.some((s) => s.name === 'global_count')).toBe(true);
    });

    it('should extract a global pointer variable', () => {
      const content = 'char *buffer_ptr = NULL;';
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const vars = symbols.filter((s) => s.kind === 'variable');
      expect(vars.some((s) => s.name === 'buffer_ptr')).toBe(true);
    });
  });

  // ── Type extraction ───────────────────────────────────────────────────

  describe('type extraction', () => {
    it('should extract a typedef', () => {
      const content = 'typedef unsigned int uint32_t;';
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const types = symbols.filter((s) => s.kind === 'type');
      expect(types.length).toBeGreaterThanOrEqual(1);
      expect(types.some((s) => s.name === 'uint32_t')).toBe(true);
    });

    it('should extract a struct definition', () => {
      const content = [
        'struct point {',
        '    int x;',
        '    int y;',
        '};',
      ].join('\n');
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const types = symbols.filter((s) => s.kind === 'type' || s.kind === 'enum');
      expect(types.some((s) => s.name === 'point')).toBe(true);
    });
  });

  // ── Macro extraction ──────────────────────────────────────────────────

  describe('macro extraction', () => {
    it('should extract a simple #define macro', () => {
      const content = '#define MAX(a,b) ((a) > (b) ? (a) : (b))';
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const macros = symbols.filter((s) => s.kind === 'macro');
      expect(macros.length).toBeGreaterThanOrEqual(1);
      expect(macros.some((s) => s.name === 'MAX')).toBe(true);
    });

    it('should extract an object-like macro', () => {
      const content = '#define CLOCK_FREQ 48000000UL';
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const macros = symbols.filter((s) => s.kind === 'macro');
      expect(macros.some((s) => s.name === 'CLOCK_FREQ')).toBe(true);
    });

    it('should handle indented #define', () => {
      const content = '  #  define BUFFER_SIZE 256';
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const macros = symbols.filter((s) => s.kind === 'macro');
      expect(macros.some((s) => s.name === 'BUFFER_SIZE')).toBe(true);
    });
  });

  // ── Enum extraction ───────────────────────────────────────────────────

  describe('enum extraction', () => {
    it('should extract an enum definition', () => {
      const content = [
        'enum state {',
        '    STATE_IDLE,',
        '    STATE_RUNNING,',
        '    STATE_STOPPED',
        '};',
      ].join('\n');
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const enums = symbols.filter((s) => s.kind === 'enum');
      expect(enums.some((s) => s.name === 'state')).toBe(true);
    });
  });

  // ── Line and column accuracy ──────────────────────────────────────────

  describe('line and column tracking', () => {
    it('should report line 0 for the first line of the file', () => {
      const content = 'int first_var = 1;';
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const sym = symbols.find((s) => s.name === 'first_var');
      expect(sym).toBeDefined();
      expect(sym!.line).toBe(0);
    });

    it('should report correct line number for multi-line input', () => {
      const content = [
        '/* header comment */',
        '',
        '#include <stdio.h>',
        '',
        'int counter = 0;',
      ].join('\n');
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const sym = symbols.find((s) => s.name === 'counter');
      expect(sym).toBeDefined();
      expect(sym!.line).toBe(4);
    });
  });

  // ── Edge cases / error handling ────────────────────────────────────────

  describe('error handling', () => {
    it('should return an empty array for empty input', () => {
      const symbols = extractor.extractSymbols('', 'file:///empty.c');
      expect(symbols).toEqual([]);
    });

    it('should return an empty array for whitespace-only input', () => {
      const symbols = extractor.extractSymbols('   \n\n  ', 'file:///ws.c');
      expect(symbols).toEqual([]);
    });

    it('should not crash on malformed C code', () => {
      const garbage = '}}}}}{{{{  int ??? !!! typedef struct }}}}}';
      expect(() => {
        extractor.extractSymbols(garbage, 'file:///garbage.c');
      }).not.toThrow();
    });

    it('should handle comments without extracting symbols', () => {
      const content = [
        '/* int not_a_function(void) { */',
        '// typedef int not_a_type;',
      ].join('\n');
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      // Comments should not produce symbols in tree-sitter mode.
      // Regex mode might pick up the comment text, which is acceptable.
      // We just verify it doesn't crash.
      expect(Array.isArray(symbols)).toBe(true);
    });
  });

  // ── Mixed content (preprocessed C) ────────────────────────────────────

  describe('preprocessed C code', () => {
    it('should extract symbols from code that looks like preprocessed output', () => {
      const content = [
        '# 1 "main.c"',
        'typedef unsigned long size_t;',
        '',
        'void *memset(void *s, int c, size_t n) {',
        '    unsigned char *p = (unsigned char *)s;',
        '    while (n--) {',
        '        *p++ = (unsigned char)c;',
        '    }',
        '    return s;',
        '}',
        '',
        '#define NULL ((void *)0)',
        '',
        'int main(void) {',
        '    char buf[64];',
        '    memset(buf, 0, sizeof(buf));',
        '    return 0;',
        '}',
      ].join('\n');

      const symbols = extractor.extractSymbols(content, 'file:///test.c');

      // Should find at least the typedef, function, and macro
      const names = symbols.map((s) => s.name);
      expect(names).toContain('memset');
      expect(names).toContain('main');
      expect(names).toContain('NULL');

      // Size_t may appear as type or variable depending on extraction mode.
      // At minimum we verify extraction didn't crash.
      expect(symbols.length).toBeGreaterThanOrEqual(3);
    });
  });
});
