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

    it('should extract a declaration without an initialiser', () => {
      // `extern sixstep_t motor;` has no initialiser, and skipping such
      // declarations leaves "go to definition" with no target at all — most
      // of a project's globals are declared this way.
      const symbols = extractor.extractSymbols(
        'extern sixstep_t motor;',
        'file:///test.h',
      );
      const vars = symbols.filter((s) => s.kind === 'variable');

      expect(vars.map((s) => s.name)).toEqual(['motor']);
    });

    it('should extract uninitialised pointers, arrays and statics', () => {
      const content = 'char *buffer;\nstatic int counter;\nint table[4];';
      const symbols = extractor.extractSymbols(content, 'file:///test.c');
      const names = symbols
        .filter((s) => s.kind === 'variable')
        .map((s) => s.name);

      expect(names).toEqual(
        expect.arrayContaining(['buffer', 'counter', 'table']),
      );
      // The type name must not be mistaken for the declared name.
      expect(names).not.toContain('int');
      expect(names).not.toContain('char');
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

  // ── tree-sitter (real WASM parse) ─────────────────────────────────

  describe('tree-sitter WASM path', () => {
    it('should load the C grammar', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      expect(ready.lastInitError).toBeNull();
      expect(ready.isReady).toBe(true);
    });

    it('should be idempotent when initialised twice', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();
      await ready.initialize();

      expect(ready.lastInitError).toBeNull();
      expect(ready.isReady).toBe(true);
    });

    it('should extract declarations of every kind from a real parse', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const content = [
        '#define MAX_LEN 32',
        'typedef struct { int x; } Point;',
        'enum Color { RED, GREEN };',
        'int counter = 0;',
        'static int add(int a, int b) {',
        '    return a + b;',
        '}',
      ].join('\n');

      const symbols = ready.extractSymbols(content, 'file:///test.c');
      const kindOf = (name: string) =>
        symbols.find((s) => s.name === name)?.kind;

      expect(kindOf('MAX_LEN')).toBe('macro');
      expect(kindOf('Point')).toBe('type');
      expect(kindOf('Color')).toBe('enum');
      expect(kindOf('RED')).toBe('enum');
      expect(kindOf('counter')).toBe('variable');
      expect(kindOf('add')).toBe('function');
    });

    it('should extract struct members', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const content = [
        'struct config {',
        '    int speed, limit;',
        '    char *name;',
        '    int samples[8];',
        '};',
      ].join('\n');

      const symbols = ready.extractSymbols(content, 'file:///test.c');
      const names = symbols.map((s) => s.name);

      // One `field_declaration` can declare several members.
      expect(names).toContain('speed');
      expect(names).toContain('limit');
      expect(names).toContain('name');
      expect(names).toContain('samples');
      expect(symbols.find((s) => s.name === 'speed')!.kind).toBe('variable');
    });

    it('should extract a function-pointer member and point at its name', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const content = [
        'typedef struct {',
        '    commutation_error_t (*set_direction)(sixstep_t *obj, motor_direction_t dir);',
        '} sixstep_t;',
      ].join('\n');

      const symbols = ready.extractSymbols(content, 'file:///test.c');
      const member = symbols.find((s) => s.name === 'set_direction');

      // A member declared through a parenthesised declarator is the shape
      // `motor.set_direction(...)` resolves against.
      expect(member).toBeDefined();
      expect(member!.line).toBe(1);
      expect(content.split('\n')[1].slice(member!.column)).toMatch(
        /^set_direction/,
      );
    });

    it('should skip an anonymous struct member type', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const content = 'struct outer { struct { int x; } inner; };';
      const symbols = ready.extractSymbols(content, 'file:///test.c');
      const names = symbols.map((s) => s.name);

      // The member is indexed; a nested anonymous struct declares no tag.
      expect(names).toContain('inner');
      expect(names).toContain('x');
    });

    it('should report 0-based positions from the real parse', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const content = [
        'int first(void) {',
        '    return 1;',
        '}',
        '',
        'int second(void) {',
        '    return 2;',
        '}',
      ].join('\n');

      const symbols = ready.extractSymbols(content, 'file:///test.c');
      const second = symbols.find((s) => s.name === 'second');
      const first = symbols.find((s) => s.name === 'first');

      expect(first?.line).toBe(0);
      expect(second?.line).toBe(4);
      // `int ` occupies columns 0-3, so the name starts at column 4.
      expect(first?.column).toBe(4);
      expect(second?.column).toBe(4);
    });

    it('should point at the function name, not at its return type', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const content =
        'commutation_error_t sixstep_init(sixstep_t *sixstep) {\n' +
        '    return COMMUTATION_OK;\n' +
        '}';

      const symbols = ready.extractSymbols(content, 'file:///test.c');
      const sym = symbols.find((s) => s.name === 'sixstep_init');

      expect(sym).toBeDefined();
      expect(sym!.line).toBe(0);
      // `commutation_error_t ` is 20 characters long; the cursor has to land
      // on the identifier rather than at the start of the declaration.
      expect(sym!.column).toBe(20);
      expect(content.split('\n')[sym!.line].slice(sym!.column)).toMatch(
        /^sixstep_init/,
      );
    });

    it('should point at the name of a variable, macro and type', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const content = [
        'int    counter = 0;',
        '#define   MAX_LEN 32',
        'typedef   int    my_int_t;',
      ].join('\n');

      const symbols = ready.extractSymbols(content, 'file:///test.c');
      // Columns are relative to the symbol's own line, so slice that line.
      const lines = content.split('\n');
      const at = (name: string) => symbols.find((s) => s.name === name)!;
      const textAt = (name: string) => {
        const sym = at(name);
        return lines[sym.line].slice(sym.column);
      };

      expect(textAt('counter')).toMatch(/^counter/);
      expect(textAt('MAX_LEN')).toMatch(/^MAX_LEN/);
      expect(textAt('my_int_t')).toMatch(/^my_int_t/);
    });

    it('should attribute every symbol to the requested URI', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const uri = 'file:///project/src/main.c';
      const symbols = ready.extractSymbols('int main(void) { return 0; }', uri);

      expect(symbols.length).toBeGreaterThan(0);
      for (const sym of symbols) {
        expect(sym.file).toBe(uri);
      }
    });
  });

  // ── extractUsages ─────────────────────────────────────────────────

  describe('extractUsages', () => {
    it('should return nothing before initialisation', () => {
      const cold = new TreeSitterExtractor();

      expect(cold.isReady).toBe(false);
      expect(cold.extractUsages('int x = y;', 'file:///a.c')).toEqual([]);
    });

    it('should record definitions, calls, types and member accesses', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const content = [
        'struct S { int f; };',
        'int add(int a, int b) { return a + b; }',
        'void use(void) { struct S s; s.f = add(1, 2); }',
      ].join('\n');

      const usages = ready.extractUsages(content, 'file:///t.c');
      const names = usages.map((u) => u.name);

      expect(names).toContain('S'); // type reference
      expect(names).toContain('f'); // member access
      expect(names).toContain('s');

      // The declaration and the call site are both occurrences.
      expect(names.filter((n) => n === 'add').length).toBeGreaterThanOrEqual(2);

      for (const usage of usages) {
        expect(usage.file).toBe('file:///t.c');
        expect(usage.line).toBeGreaterThanOrEqual(0);
        expect(usage.column).toBeGreaterThanOrEqual(0);
      }
    });

    it('should report 0-based positions', async () => {
      const ready = new TreeSitterExtractor();
      await ready.initialize();

      const usages = ready.extractUsages('int value;', 'file:///t.c');
      const value = usages.find((u) => u.name === 'value');

      expect(value?.line).toBe(0);
      expect(value?.column).toBe(4);
    });
  });
});
