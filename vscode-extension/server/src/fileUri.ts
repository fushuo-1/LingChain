/**
 * Conversion between `file://` URIs and filesystem paths.
 *
 * Windows drive letters are normalised to upper case.  The same file reaches
 * the server spelled two ways: the VS Code client reports it as
 * `file:///D:/…`, while an armclang `#line` directive spells it
 * `file:///d:/…`.  Windows does not care, but the symbol index compares URIs
 * as strings — so without normalisation one file gets stored twice and
 * "go to definition" offers a pick-list holding two copies of the same site.
 *
 * Only the drive letter is normalised.  The rest of the path stays verbatim:
 * it is case-sensitive elsewhere, and lower-casing it would be wrong.
 */

// ── Constants ────────────────────────────────────────────────────────────

/** Drive-letter prefix of a file URI, e.g. `file:///c:/`. */
const URI_DRIVE_LETTER = /^file:\/\/\/([A-Za-z]):/;

/** Drive-letter prefix of a filesystem path, e.g. `c:/`. */
const PATH_DRIVE_LETTER = /^([A-Za-z]):/;

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Convert a filesystem path to a `file://` URI.
 *
 * Separators are normalised and runs of slashes collapsed first: a path
 * taken from a `#line` directive can arrive as `C:\\dir\\file` or
 * `C://dir//file`, either of which would otherwise yield a URI no editor can
 * resolve.
 */
export function pathToFileUri(filePath: string): string {
  const normalised = filePath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return upperCaseDriveLetter(`file:///${normalised}`);
}

/**
 * Convert a `file://` URI to a filesystem path, with the drive letter upper
 * cased.  URIs with another scheme are returned unchanged.
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;

  const decoded = decodeURIComponent(uri.slice(7)).replace(
    /^\/([A-Za-z]:)/,
    '$1',
  );

  return decoded.replace(PATH_DRIVE_LETTER, (_, drive: string) =>
    `${drive.toUpperCase()}:`,
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Upper-case the drive letter of a file URI.  A no-op for URIs without one
 * (UNC paths, POSIX paths).
 */
export function upperCaseDriveLetter(uri: string): string {
  return uri.replace(
    URI_DRIVE_LETTER,
    (_, drive: string) => `file:///${drive.toUpperCase()}:`,
  );
}
