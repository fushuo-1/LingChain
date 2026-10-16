import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as path from 'path';
import {
  ARMCLANG_EXECUTABLE,
  KEIL_RELATIVE_EXECUTABLE,
  locateArmclang,
  parseRegQueryPath,
} from './armclangLocator';

jest.mock('fs');
jest.mock('child_process');

const existsMock = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const statMock = fs.statSync as jest.MockedFunction<typeof fs.statSync>;
const execMock = execFileSync as jest.MockedFunction<typeof execFileSync>;

/** Normalise separators so assertions behave the same on both platforms. */
function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Make only the given paths "exist" as files. */
function onlyFilesExist(...paths: string[]): void {
  const set = new Set(paths.map(norm));
  existsMock.mockImplementation((p) => set.has(norm(String(p))));
  statMock.mockImplementation(
    () => ({ isFile: () => true }) as unknown as fs.Stats,
  );
}

const originalEnv = { ...process.env };

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...originalEnv };
  delete process.env.KEIL_ARMCLANG;
  delete process.env.ARMCLANG_PATH;
  delete process.env.KEIL_MDK;
  delete process.env.KEIL_UV4;
  delete process.env.PATH;
});

afterAll(() => {
  process.env = originalEnv;
});

// ── parseRegQueryPath ────────────────────────────────────────────────────

describe('parseRegQueryPath', () => {
  it('should extract the REG_SZ value', () => {
    const output = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Keil\\Products\\MDK',
      '    Path    REG_SZ    C:\\Keil_v5\\',
      '',
    ].join('\r\n');

    expect(parseRegQueryPath(output)).toBe('C:\\Keil_v5\\');
  });

  it('should return null when no REG_SZ line is present', () => {
    expect(parseRegQueryPath('ERROR: The system was unable to find the key')).toBeNull();
    expect(parseRegQueryPath('')).toBeNull();
  });
});

// ── locateArmclang ───────────────────────────────────────────────────────

describe('locateArmclang', () => {
  it('should use an explicit path that points at the executable', () => {
    onlyFilesExist('C:/tools/armclang.exe');

    expect(locateArmclang('C:/tools/armclang.exe')).toEqual({
      path: 'C:/tools/armclang.exe',
      source: 'configured',
    });
  });

  it('should accept a directory containing the executable', () => {
    const dir = 'C:/tools/armclang/bin';
    onlyFilesExist(path.join(dir, ARMCLANG_EXECUTABLE));

    expect(locateArmclang(dir)?.source).toBe('configured');
  });

  it('should accept a Keil installation root', () => {
    const root = 'C:/Keil_v5';
    onlyFilesExist(path.join(root, KEIL_RELATIVE_EXECUTABLE));

    expect(locateArmclang(root)).toEqual({
      path: path.join(root, KEIL_RELATIVE_EXECUTABLE),
      source: 'configured',
    });
  });

  it('should fall back to the environment when the configured path is invalid', () => {
    onlyFilesExist('D:/env/armclang.exe');
    process.env.KEIL_ARMCLANG = 'D:/env/armclang.exe';

    expect(locateArmclang('C:/does/not/exist')).toEqual({
      path: 'D:/env/armclang.exe',
      source: 'env',
    });
  });

  it('should derive the Keil root from KEIL_UV4', () => {
    const expected = path.join('C:/Keil_v5', KEIL_RELATIVE_EXECUTABLE);
    onlyFilesExist(expected);
    process.env.KEIL_UV4 = path.join('C:/Keil_v5', 'UV4', 'UV4.exe');

    expect(locateArmclang()).toEqual({ path: expected, source: 'env' });
  });

  it('should resolve the Keil registry key', () => {
    const expected = path.join('C:/Keil_v5', KEIL_RELATIVE_EXECUTABLE);
    onlyFilesExist(expected);
    execMock.mockReturnValue(
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Keil\\Products\\MDK\r\n    Path    REG_SZ    C:\\Keil_v5\\\r\n',
    );

    expect(locateArmclang()).toEqual({ path: expected, source: 'registry' });
    expect(execMock).toHaveBeenCalledWith(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Keil\\Products\\MDK', '/v', 'Path'],
      expect.anything(),
    );
  });

  it('should not fail when reg.exe errors', () => {
    execMock.mockImplementation(() => {
      throw new Error('reg not found');
    });
    onlyFilesExist();

    expect(locateArmclang()).toBeNull();
  });

  it('should scan common Keil install locations', () => {
    const expected = path.join('C:/Keil_v5', KEIL_RELATIVE_EXECUTABLE);
    onlyFilesExist(expected);
    process.env.PATH = '';

    expect(locateArmclang()).toEqual({ path: expected, source: 'common-path' });
  });

  it('should fall back to PATH', () => {
    const dir = 'C:/somewhere/bin';
    const expected = path.join(dir, ARMCLANG_EXECUTABLE);
    onlyFilesExist(expected);
    execMock.mockImplementation(() => {
      throw new Error('no registry');
    });
    process.env.PATH = ['C:/first', dir, 'C:/last'].join(path.delimiter);

    expect(locateArmclang()).toEqual({ path: expected, source: 'path' });
  });

  it('should return null when armclang is nowhere to be found', () => {
    execMock.mockImplementation(() => {
      throw new Error('no registry');
    });
    onlyFilesExist();
    process.env.PATH = 'C:/empty';

    expect(locateArmclang()).toBeNull();
  });
});
