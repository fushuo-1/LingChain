import { Database } from 'node-sqlite3-wasm';
import { Symbol } from './symbol';
import { hashContent } from './fileHasher';

// ── Types ────────────────────────────────────────────────────────────────

/** A symbol with its database row id and the hash of the source file. */
export interface IndexedSymbol extends Symbol {
  id: number;
  hash: string;
}

// ── SymbolIndex ──────────────────────────────────────────────────────────

/**
 * Persistent SQLite-backed index of C symbols.
 *
 * Schema:
 *  - **files** – one row per source file, keyed by URI.  The `hash` column
 *    stores the MD5 of the file content at the time of indexing; callers use
 *    this to skip re-indexing unchanged files.
 *  - **symbols** – one row per extracted symbol.  References `files` via
 *    foreign key so that deleting a file cascades to its symbols.
 *
 * All public methods are async for consistency – the WASM SQLite driver is
 * synchronous under the hood, but async gives us the freedom to swap in a
 * native driver later without changing the call-sites.
 */
export class SymbolIndex {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Open (or create) the database and ensure the schema exists.
   */
  async init(): Promise<void> {
    this.db = new Database(this.dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        uri   TEXT PRIMARY KEY,
        hash  TEXT NOT NULL
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        name   TEXT    NOT NULL,
        kind   TEXT    NOT NULL,
        file   TEXT    NOT NULL,
        line   INTEGER NOT NULL,
        column INTEGER NOT NULL,
        FOREIGN KEY (file) REFERENCES files(uri) ON DELETE CASCADE
      );
    `);

    // Speed up bulk inserts / deletes that happen during indexing.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ── File management ────────────────────────────────────────────────────

  /**
   * Insert or update a file record.
   *
   * If the URI already exists the hash is updated (upsert semantics).
   */
  async upsertFile(uri: string, hash: string): Promise<void> {
    const db = this.requireDb();
    db.run(
      'INSERT INTO files (uri, hash) VALUES (?, ?) ON CONFLICT(uri) DO UPDATE SET hash = excluded.hash',
      [uri, hash],
    );
  }

  // ── Symbol CRUD ────────────────────────────────────────────────────────

  /**
   * Insert a single symbol into the index.
   */
  async insertSymbol(symbol: Symbol): Promise<void> {
    const db = this.requireDb();
    db.run(
      'INSERT INTO symbols (name, kind, file, line, column) VALUES (?, ?, ?, ?, ?)',
      [symbol.name, symbol.kind, symbol.file, symbol.line, symbol.column],
    );
  }

  /**
   * Insert many symbols in one call.
   *
   * Wraps all inserts in a transaction for performance.
   */
  async insertSymbols(symbols: Symbol[]): Promise<void> {
    if (symbols.length === 0) return;
    const db = this.requireDb();
    db.exec('BEGIN');
    try {
      for (const s of symbols) {
        db.run(
          'INSERT INTO symbols (name, kind, file, line, column) VALUES (?, ?, ?, ?, ?)',
          [s.name, s.kind, s.file, s.line, s.column],
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Look up all symbols whose name matches exactly.
   */
  async findByName(name: string): Promise<IndexedSymbol[]> {
    const db = this.requireDb();
    const rows = db.all(
      `SELECT s.id, s.name, s.kind, s.file, s.line, s.column, f.hash
       FROM symbols s
       JOIN files f ON f.uri = s.file
       WHERE s.name = ?`,
      [name],
    ) as Array<{
      id: number;
      name: string;
      kind: Symbol['kind'];
      file: string;
      line: number;
      column: number;
      hash: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      column: r.column,
      hash: r.hash,
    }));
  }

  /**
   * Return every symbol that belongs to a given file.
   */
  async findByFile(uri: string): Promise<IndexedSymbol[]> {
    const db = this.requireDb();
    const rows = db.all(
      `SELECT s.id, s.name, s.kind, s.file, s.line, s.column, f.hash
       FROM symbols s
       JOIN files f ON f.uri = s.file
       WHERE s.file = ?`,
      [uri],
    ) as Array<{
      id: number;
      name: string;
      kind: Symbol['kind'];
      file: string;
      line: number;
      column: number;
      hash: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      column: r.column,
      hash: r.hash,
    }));
  }

  /**
   * Search for symbols whose name contains `query` as a substring
   * (case-sensitive).
   *
   * Returns at most `limit` results (default 50).
   */
  async findBySubstring(
    query: string,
    limit: number = 50,
  ): Promise<IndexedSymbol[]> {
    const db = this.requireDb();
    // Use INSTR for case-sensitive substring matching (SQLite LIKE is
    // case-insensitive for ASCII by default).
    const rows = db.all(
      `SELECT s.id, s.name, s.kind, s.file, s.line, s.column, f.hash
       FROM symbols s
       JOIN files f ON f.uri = s.file
       WHERE INSTR(s.name, ?) > 0
       LIMIT ?`,
      [query, limit],
    ) as Array<{
      id: number;
      name: string;
      kind: Symbol['kind'];
      file: string;
      line: number;
      column: number;
      hash: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      column: r.column,
      hash: r.hash,
    }));
  }

  /**
   * Search for symbols whose name starts with `prefix` (case-sensitive).
   *
   * This is used by the completion provider to offer prefix-filtered
   * suggestions as the user types.
   *
   * Returns at most `limit` results (default 200).
   */
  async findByPrefix(
    prefix: string,
    limit: number = 200,
  ): Promise<IndexedSymbol[]> {
    const db = this.requireDb();
    const rows = db.all(
      `SELECT s.id, s.name, s.kind, s.file, s.line, s.column, f.hash
       FROM symbols s
       JOIN files f ON f.uri = s.file
       WHERE s.name LIKE ? || '%'
       ORDER BY s.name
       LIMIT ?`,
      [prefix, limit],
    ) as Array<{
      id: number;
      name: string;
      kind: Symbol['kind'];
      file: string;
      line: number;
      column: number;
      hash: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      column: r.column,
      hash: r.hash,
    }));
  }

  /**
   * Delete all symbols (and the file record) for the given URI.
   */
  async deleteByFile(uri: string): Promise<void> {
    const db = this.requireDb();
    db.run('DELETE FROM files WHERE uri = ?', [uri]);
  }

  /**
   * Return the stored hash for a file, or `undefined` if the file is not
   * in the index.
   */
  async getFileHash(uri: string): Promise<string | undefined> {
    const db = this.requireDb();
    const row = db.get('SELECT hash FROM files WHERE uri = ?', [uri]) as
      | { hash: string }
      | undefined;
    return row?.hash;
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private requireDb(): Database {
    if (!this.db) {
      throw new Error('SymbolIndex not initialised – call init() first');
    }
    return this.db;
  }
}

// Re-export for convenience so callers can do `import { hashContent } from './symbolIndex'`
export { hashContent };
