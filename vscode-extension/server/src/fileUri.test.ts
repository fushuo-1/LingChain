import {
  pathToFileUri,
  fileUriToPath,
  upperCaseDriveLetter,
} from './fileUri';

describe('pathToFileUri', () => {
  it('should convert a Windows path to a file URI', () => {
    expect(pathToFileUri('D:/proj/src/main.c')).toBe(
      'file:///D:/proj/src/main.c',
    );
  });

  it('should upper-case a lower-case drive letter', () => {
    expect(pathToFileUri('d:/proj/src/main.c')).toBe(
      'file:///D:/proj/src/main.c',
    );
  });

  it('should normalise backslashes', () => {
    expect(pathToFileUri('D:\\proj\\src\\main.c')).toBe(
      'file:///D:/proj/src/main.c',
    );
  });

  it('should collapse doubled separators from escaped #line paths', () => {
    // ARM Compiler writes `C:\\dir\\file` inside a #line directive.
    expect(pathToFileUri('C://dir//Inc//util.h')).toBe(
      'file:///C:/dir/Inc/util.h',
    );
  });

  it('should upper-case the drive letter of an escaped #line path', () => {
    expect(pathToFileUri('d:\\proj\\Inc\\util.h')).toBe(
      'file:///D:/proj/Inc/util.h',
    );
  });

  it('should preserve the case of the rest of the path', () => {
    // Only the drive letter is case-insensitive on Windows; directory and
    // file names are not.
    expect(pathToFileUri('C:/Proj/STM32G0xx_HAL_Driver/Inc/util.h')).toBe(
      'file:///C:/Proj/STM32G0xx_HAL_Driver/Inc/util.h',
    );
  });

  it('should yield the same URI for both spellings of the same file', () => {
    const fromClient = pathToFileUri('D:\\proj\\Bsp\\bsp.h');
    const fromLineDirective = pathToFileUri('d:\\proj\\Bsp\\bsp.h');
    expect(fromClient).toBe(fromLineDirective);
  });
});

describe('fileUriToPath', () => {
  it('should convert a file URI to a Windows path', () => {
    expect(fileUriToPath('file:///D:/proj/src/main.c')).toBe(
      'D:/proj/src/main.c',
    );
  });

  it('should upper-case the drive letter', () => {
    expect(fileUriToPath('file:///d:/proj/src/main.c')).toBe(
      'D:/proj/src/main.c',
    );
  });

  it('should decode percent-encoded characters', () => {
    expect(fileUriToPath('file:///D:/my%20project/main.c')).toBe(
      'D:/my project/main.c',
    );
  });

  it('should return a non-file URI unchanged', () => {
    expect(fileUriToPath('untitled:Untitled-1')).toBe('untitled:Untitled-1');
  });

  it('should round-trip a path through a URI', () => {
    const path = 'C:/Proj/Inc/util.h';
    expect(fileUriToPath(pathToFileUri(path))).toBe(path);
  });
});

describe('upperCaseDriveLetter', () => {
  it('should upper-case a drive letter in a URI', () => {
    expect(upperCaseDriveLetter('file:///c:/x.c')).toBe('file:///C:/x.c');
  });

  it('should leave an already upper-case drive letter alone', () => {
    expect(upperCaseDriveLetter('file:///C:/x.c')).toBe('file:///C:/x.c');
  });

  it('should leave a drive-less URI alone', () => {
    expect(upperCaseDriveLetter('file:///home/me/x.c')).toBe(
      'file:///home/me/x.c',
    );
  });

  it('should not treat a path segment as a drive letter', () => {
    expect(upperCaseDriveLetter('file:///c/Users/x.c')).toBe(
      'file:///c/Users/x.c',
    );
  });
});
