import { createHash } from 'crypto';

/**
 * Compute an MD5 hex digest of the given string content.
 *
 * Used by the symbol index to detect whether a file has changed since the
 * last indexing pass – if the hash matches, the stored symbols are still
 * valid and can be reused without re-parsing.
 */
export function hashContent(content: string): string {
  return createHash('md5').update(content).digest('hex');
}
