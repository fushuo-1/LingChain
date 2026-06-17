import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { addToGitignore, addToFilesExclude, ensureCacheExclusion } from './cacheExclusion';

let tmpDir: string;
let mockUpdate: jest.Mock;
let mockGet: jest.Mock;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingchain-test-'));
  mockUpdate = jest.fn().mockResolvedValue(undefined);
  mockGet = jest.fn().mockReturnValue({});
  (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
    get: mockGet,
    update: mockUpdate,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('addToGitignore', () => {
  it('creates .gitignore and adds entry when no file exists', async () => {
    const modified = await addToGitignore(tmpDir);
    expect(modified).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toContain('.lingµchain/');
  });

  it('appends entry to existing .gitignore', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n', 'utf-8');
    const modified = await addToGitignore(tmpDir);
    expect(modified).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toContain('.lingµchain/');
  });

  it('does NOT modify when entry exists (exact)', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.lingµchain\n', 'utf-8');
    const modified = await addToGitignore(tmpDir);
    expect(modified).toBe(false);
  });

  it('does NOT modify when entry exists (with slash)', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.lingµchain/\n', 'utf-8');
    const modified = await addToGitignore(tmpDir);
    expect(modified).toBe(false);
  });

  it('is idempotent', async () => {
    await addToGitignore(tmpDir);
    const modified = await addToGitignore(tmpDir);
    expect(modified).toBe(false);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    const matches = content.match(/\.lingµchain\//g);
    expect(matches).toHaveLength(1);
  });
});

describe('addToFilesExclude', () => {
  it('adds .lingµchain to files.exclude when not present', async () => {
    const modified = await addToFilesExclude();
    expect(modified).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith('files.exclude', { '.lingµchain': true }, 2);
  });

  it('does NOT modify when already present', async () => {
    mockGet.mockReturnValue({ '.lingµchain': true });
    const modified = await addToFilesExclude();
    expect(modified).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('preserves existing entries', async () => {
    mockGet.mockReturnValue({ 'node_modules': true });
    const modified = await addToFilesExclude();
    expect(modified).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(
      'files.exclude',
      { 'node_modules': true, '.lingµchain': true },
      2
    );
  });

  it('is idempotent', async () => {
    mockGet.mockReturnValueOnce({});
    mockGet.mockReturnValueOnce({ '.lingµchain': true });
    const first = await addToFilesExclude();
    expect(first).toBe(true);
    const second = await addToFilesExclude();
    expect(second).toBe(false);
  });
});

describe('ensureCacheExclusion', () => {
  it('calls both addToGitignore and addToFilesExclude', async () => {
    await ensureCacheExclusion(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(content).toContain('.lingµchain/');
    expect(mockUpdate).toHaveBeenCalled();
  });
});
