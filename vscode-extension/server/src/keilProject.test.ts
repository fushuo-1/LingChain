import * as path from 'path';
import { KeilProject, CompileContext } from './keilProject';

const FIXTURES = path.join(__dirname, '__fixtures__');

/** Normalize a platform-specific path to forward slashes for cross-platform tests. */
function n(p: string): string {
  return p.replace(/\\/g, '/');
}

describe('KeilProject', () => {
  // -----------------------------------------------------------------------
  // Full fixture with two targets, -I flags, and multiple groups
  // -----------------------------------------------------------------------
  describe('sample.uvprojx (multi-target)', () => {
    const project = new KeilProject(path.join(FIXTURES, 'sample.uvprojx'));

    beforeAll(() => {
      project.parse();
    });

    it('should list all target names', () => {
      const names = project.getTargetNames();
      expect(names).toEqual(['Target 1', 'Target 2']);
    });

    it('should extract device name for the first target', () => {
      const ctx = project.getCompileContext();
      expect(ctx.target).toBe('STM32G071RBTx');
    });

    it('should extract device name for the second target by name', () => {
      const ctx = project.getCompileContext('Target 2');
      expect(ctx.target).toBe('STM32F103C8Tx');
    });

    it('should extract include paths from <IncludePath> element', () => {
      const ctx = project.getCompileContext('Target 1');
      const basenames = ctx.includePaths.map((p) =>
        n(path.relative(project.projectDir, p))
      );
      // From <IncludePath>
      expect(basenames).toContain(n(path.join('Core', 'Inc')));
      expect(basenames).toContain(
        n(path.join('Drivers', 'STM32G0xx_HAL_Driver', 'Inc'))
      );
      expect(basenames).toContain(
        n(path.join('Drivers', 'CMSIS', 'Device', 'ST', 'STM32G0xx', 'Include'))
      );
    });

    it('should extract include paths from -I flags in MiscControls', () => {
      const ctx = project.getCompileContext('Target 1');
      const basenames = ctx.includePaths.map((p) =>
        n(path.relative(project.projectDir, p))
      );
      expect(basenames).toContain(
        n(path.join('Drivers', 'CMSIS', 'Include'))
      );
    });

    it('should extract preprocessor defines', () => {
      const ctx = project.getCompileContext('Target 1');
      expect(ctx.defines).toContain('USE_HAL_DRIVER');
      expect(ctx.defines).toContain('STM32G071xx');
      // Sorted
      expect(ctx.defines).toEqual([...ctx.defines].sort());
    });

    it('should extract source files from project groups', () => {
      const ctx = project.getCompileContext('Target 1');
      const basenames = ctx.sourceFiles.map((f) =>
        path.basename(f)
      );
      expect(basenames).toContain('main.c');
      expect(basenames).toContain('stm32g0xx_it.c');
      expect(basenames).toContain('stm32g0xx_hal.c');
    });

    it('should return 3 source files total', () => {
      const ctx = project.getCompileContext('Target 1');
      expect(ctx.sourceFiles).toHaveLength(3);
    });

    it('should resolve source file paths relative to project dir', () => {
      const ctx = project.getCompileContext('Target 1');
      const mainFile = ctx.sourceFiles.find((f) =>
        f.endsWith('main.c')
      );
      expect(mainFile).toBeDefined();
      expect(path.isAbsolute(mainFile!)).toBe(true);
      expect(mainFile!).toContain('Src');
    });
  });

  // -----------------------------------------------------------------------
  // Minimal fixture — single target, no -I flags
  // -----------------------------------------------------------------------
  describe('minimal.uvprojx (single target)', () => {
    const project = new KeilProject(path.join(FIXTURES, 'minimal.uvprojx'));

    beforeAll(() => {
      project.parse();
    });

    it('should list exactly one target', () => {
      expect(project.getTargetNames()).toEqual(['Debug']);
    });

    it('should extract device name', () => {
      const ctx = project.getCompileContext();
      expect(ctx.target).toBe('STM32F407VGTx');
    });

    it('should extract defines', () => {
      const ctx = project.getCompileContext();
      expect(ctx.defines).toContain('DEBUG');
      expect(ctx.defines).toContain('STM32F407xx');
    });

    it('should extract include paths', () => {
      const ctx = project.getCompileContext();
      const basenames = ctx.includePaths.map((p) =>
        n(path.relative(project.projectDir, p))
      );
      expect(basenames).toContain('Inc');
      expect(basenames).toContain(
        n(path.join('Drivers', 'CMSIS', 'Include'))
      );
    });

    it('should extract one source file', () => {
      const ctx = project.getCompileContext();
      expect(ctx.sourceFiles).toHaveLength(1);
      expect(ctx.sourceFiles[0]).toMatch(/main\.c$/);
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    it('should throw when parse() was not called', () => {
      const project = new KeilProject(path.join(FIXTURES, 'sample.uvprojx'));
      expect(() => project.getCompileContext()).toThrow('Call parse()');
    });

    it('should throw for a non-existent file', () => {
      const project = new KeilProject('/nonexistent/file.uvprojx');
      expect(() => project.parse()).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // CubeMX layout: <Groups> nested inside <Target>
  // -----------------------------------------------------------------------
  describe('cubeMX-target-groups.uvprojx (Groups inside <Target>)', () => {
    const project = new KeilProject(
      path.join(FIXTURES, 'cubeMX-target-groups.uvprojx')
    );

    beforeAll(() => {
      project.parse();
    });

    // Real CubeMX projects keep the file list under <Target>, not <Project>;
    // reading only the project level silently yields zero source files and no
    // indexing ever happens.
    it('should read the file list from the selected target', () => {
      const ctx = project.getCompileContext();
      const names = ctx.sourceFiles.map((f) => path.basename(f)).sort();

      expect(names).toEqual(['bsp_adc.c', 'main.c', 'startup_stm32g070xx.s']);
    });

    it('should resolve ../ paths against the project directory', () => {
      const ctx = project.getCompileContext();
      const main = ctx.sourceFiles.find((f) => f.endsWith('main.c'));

      // `..` is resolved against the project directory: the fixture lives in
      // __fixtures__, mirroring a real project whose .uvprojx sits in MDK-ARM/.
      expect(main).toBe(path.resolve(project.projectDir, '../Core/Src/main.c'));
    });

    it('should still expose device, defines and include paths', () => {
      const ctx = project.getCompileContext();

      expect(ctx.target).toBe('STM32G070CBTx');
      expect(ctx.defines).toEqual(['STM32G070xx', 'USE_HAL_DRIVER']);
      expect(
        ctx.includePaths.map((p) => n(path.basename(p)))
      ).toEqual(expect.arrayContaining(['Inc', 'Bsp']));
    });
  });
});
