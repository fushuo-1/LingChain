/**
 * Tests for DiagnosticsProvider.
 *
 * Covers:
 *   - JSON diagnostics parsing
 *   - Text-based diagnostics parsing
 *   - Debounce behaviour
 *   - Error handling (spawn failures, empty output)
 *   - Argument building
 */

import { DiagnosticsProvider, Diagnostic } from './diagnosticsProvider';
import { CompileContext } from './keilProject';

// ---------------------------------------------------------------------------
// Fixture compile context
// ---------------------------------------------------------------------------

const COMPILE_CONTEXT: CompileContext = {
  includePaths: ['/project/Core/Inc', '/project/Drivers/CMSIS/Include'],
  defines: ['USE_HAL_DRIVER', 'STM32G071xx'],
  sourceFiles: ['/project/Src/main.c'],
  target: 'STM32G071RBTx',
};

// ---------------------------------------------------------------------------
// JSON diagnostics
// ---------------------------------------------------------------------------

describe('DiagnosticsProvider — JSON parsing', () => {
  let provider: DiagnosticsProvider;

  beforeEach(() => {
    provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT);
  });

  it('should parse armclang JSON output with wrapper object', () => {
    const json = JSON.stringify({
      diagnostics: [
        {
          filename: '/project/Src/main.c',
          line: 10,
          column: 5,
          message: "use of undeclared identifier 'x'",
          level: 'error',
        },
        {
          filename: '/project/Src/main.c',
          line: 15,
          column: 1,
          message: "unused variable 'y'",
          level: 'warning',
        },
      ],
    });

    const result = provider.parseOutput(json, '/project/Src/main.c');

    expect(result).toHaveLength(2);

    // First diagnostic (error)
    expect(result[0].file).toBe('/project/Src/main.c');
    expect(result[0].line).toBe(9); // 0-based
    expect(result[0].column).toBe(4); // 0-based
    expect(result[0].message).toBe("use of undeclared identifier 'x'");
    expect(result[0].severity).toBe('error');

    // Second diagnostic (warning)
    expect(result[1].line).toBe(14); // 0-based
    expect(result[1].column).toBe(0); // 0-based
    expect(result[1].severity).toBe('warning');
  });

  it('should parse bare JSON array output', () => {
    const json = JSON.stringify([
      {
        filename: '/project/Src/stm32g0xx_it.c',
        line: 42,
        column: 3,
        message: 'implicit function declaration',
        level: 'warning',
      },
    ]);

    const result = provider.parseOutput(json, '/project/Src/stm32g0xx_it.c');

    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warning');
    expect(result[0].line).toBe(41); // 0-based
  });

  it('should map fatal level to error severity', () => {
    const json = JSON.stringify({
      diagnostics: [
        {
          filename: 'test.c',
          line: 1,
          column: 1,
          message: 'fatal error: cannot open source file',
          level: 'fatal',
        },
      ],
    });

    const result = provider.parseOutput(json, 'test.c');
    expect(result[0].severity).toBe('error');
  });

  it('should map remark/note levels to info severity', () => {
    const json = JSON.stringify({
      diagnostics: [
        {
          filename: 'test.c',
          line: 5,
          column: 1,
          message: 'expanded from macro',
          level: 'note',
        },
        {
          filename: 'test.c',
          line: 8,
          column: 1,
          message: 'consider using const',
          level: 'remark',
        },
      ],
    });

    const result = provider.parseOutput(json, 'test.c');
    expect(result[0].severity).toBe('info');
    expect(result[1].severity).toBe('info');
  });

  it('should handle missing fields with defaults', () => {
    const json = JSON.stringify({
      diagnostics: [
        {
          message: 'some error',
          level: 'error',
          // filename, line, column missing
        },
      ],
    });

    const result = provider.parseOutput(json, 'test.c');
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('');
    expect(result[0].line).toBe(0); // max(0, 1-1)
    expect(result[0].column).toBe(0); // max(0, 1-1)
    expect(result[0].message).toBe('some error');
  });
});

// ---------------------------------------------------------------------------
// Text-based diagnostics (fallback)
// ---------------------------------------------------------------------------

describe('DiagnosticsProvider — text parsing fallback', () => {
  let provider: DiagnosticsProvider;

  beforeEach(() => {
    provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT);
  });

  it('should parse classic armclang text output', () => {
    const text = [
      '/project/Src/main.c:10:5: error: use of undeclared identifier \'x\'',
      '/project/Src/main.c:15:1: warning: unused variable \'y\'',
    ].join('\n');

    const result = provider.parseOutput(text, '/project/Src/main.c');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      file: '/project/Src/main.c',
      line: 9,
      column: 4,
      message: "use of undeclared identifier 'x'",
      severity: 'error',
    });
    expect(result[1]).toEqual({
      file: '/project/Src/main.c',
      line: 14,
      column: 0,
      message: "unused variable 'y'",
      severity: 'warning',
    });
  });

  it('should parse remark and note from text output', () => {
    const text = [
      'test.c:3:1: remark: consider using \'const\' qualifier',
      'test.c:7:5: note: expanded from macro \'MAX\'',
    ].join('\n');

    const result = provider.parseOutput(text, 'test.c');
    expect(result).toHaveLength(2);
    expect(result[0].severity).toBe('info');
    expect(result[1].severity).toBe('info');
  });

  it('should parse fatal from text output', () => {
    const text = 'test.c:1:1: fatal error: cannot open source input file \'missing.h\': No such file or directory';
    const result = provider.parseOutput(text, 'test.c');
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('error');
    expect(result[0].line).toBe(0);
  });

  it('should return empty array for unrecognised text', () => {
    const text = 'armclang: some random output without diagnostics';
    const result = provider.parseOutput(text, 'test.c');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('DiagnosticsProvider — edge cases', () => {
  let provider: DiagnosticsProvider;

  beforeEach(() => {
    provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT);
  });

  it('should return empty array for empty string', () => {
    expect(provider.parseOutput('', 'test.c')).toEqual([]);
  });

  it('should return empty array for whitespace-only string', () => {
    expect(provider.parseOutput('   \n  \n  ', 'test.c')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Argument building
// ---------------------------------------------------------------------------

describe('DiagnosticsProvider — buildArgs', () => {
  it('should produce correct armclang -c arguments', () => {
    const provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT);
    const args = provider.buildArgs('/project/Src/main.c');

    expect(args).toContain('-c');
    expect(args).toContain('--format=json');
    expect(args).toContain('-I');
    expect(args).toContain('/project/Core/Inc');
    expect(args).toContain('/project/Drivers/CMSIS/Include');
    expect(args).toContain('-DUSE_HAL_DRIVER');
    expect(args).toContain('-DSTM32G071xx');
    expect(args).toContain('/project/Src/main.c');
  });

  it('should place -c and --format=json before include paths', () => {
    const provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT);
    const args = provider.buildArgs('/project/Src/main.c');

    const cIdx = args.indexOf('-c');
    const jsonIdx = args.indexOf('--format=json');
    const firstIIdx = args.indexOf('-I');

    expect(cIdx).toBe(0);
    expect(jsonIdx).toBe(1);
    expect(firstIIdx).toBe(2);
  });

  it('should handle empty compile context', () => {
    const emptyCtx: CompileContext = {
      includePaths: [],
      defines: [],
      sourceFiles: [],
      target: '',
    };
    const provider = new DiagnosticsProvider('armclang', emptyCtx);
    const args = provider.buildArgs('test.c');

    expect(args).toEqual(['-c', '--format=json', 'test.c']);
  });
});

// ---------------------------------------------------------------------------
// Debouncing
// ---------------------------------------------------------------------------

describe('DiagnosticsProvider — debouncing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should debounce rapid calls for the same file', () => {
    const provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT, 300);

    // Spy on invokeCompiler to track calls
    const invokeSpy = jest.spyOn(provider, 'invokeCompiler');
    invokeSpy.mockResolvedValue([]);

    // Fire three rapid calls for the same file
    provider.runDiagnostics('test.c');
    provider.runDiagnostics('test.c');
    provider.runDiagnostics('test.c');

    // No timer has fired yet
    expect(invokeSpy).not.toHaveBeenCalled();

    // Advance past debounce window
    jest.advanceTimersByTime(300);

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenCalledWith('test.c');

    invokeSpy.mockRestore();
  });

  it('should not debounce calls for different files', () => {
    const provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT, 300);

    const invokeSpy = jest.spyOn(provider, 'invokeCompiler');
    invokeSpy.mockResolvedValue([]);

    provider.runDiagnostics('file1.c');
    provider.runDiagnostics('file2.c');

    jest.advanceTimersByTime(300);

    expect(invokeSpy).toHaveBeenCalledTimes(2);

    invokeSpy.mockRestore();
  });

  it('should use custom debounce delay', () => {
    const provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT, 500);

    const invokeSpy = jest.spyOn(provider, 'invokeCompiler');
    invokeSpy.mockResolvedValue([]);

    provider.runDiagnostics('test.c');

    // At 300ms, the default delay, nothing should have happened
    jest.advanceTimersByTime(300);
    expect(invokeSpy).not.toHaveBeenCalled();

    // At 500ms the custom delay fires
    jest.advanceTimersByTime(200);
    expect(invokeSpy).toHaveBeenCalledTimes(1);

    invokeSpy.mockRestore();
  });

  it('cancelAll should prevent pending invocations', () => {
    const provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT, 300);

    const invokeSpy = jest.spyOn(provider, 'invokeCompiler');
    invokeSpy.mockResolvedValue([]);

    provider.runDiagnostics('test.c');
    provider.cancelAll();

    jest.advanceTimersByTime(300);

    expect(invokeSpy).not.toHaveBeenCalled();

    invokeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('DiagnosticsProvider — error handling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should resolve with empty array when invokeCompiler rejects', async () => {
    const provider = new DiagnosticsProvider('armclang', COMPILE_CONTEXT, 0);

    const invokeSpy = jest.spyOn(provider, 'invokeCompiler');
    invokeSpy.mockRejectedValue(new Error('armclang not found'));

    const promise = provider.runDiagnostics('test.c');
    jest.advanceTimersByTime(0);

    const result = await promise;
    expect(result).toEqual([]);

    invokeSpy.mockRestore();
  });
});
