import { Database } from 'node-sqlite3-wasm';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Symbol, Usage } from './symbol';
import { hashContent } from './fileHasher';

// ── Types ────────────────────────────────────────────────────────────────

/** A symbol with its database row id and the hash of the source file. */
export interface IndexedSymbol extends Symbol {
  id: number;
  hash: string;
}

/**
 * Schema version.  Bumped when a change requires re-indexing: an older
 * database is dropped and recreated (the index is a cache, never a source of
 * truth).
 *
 * Version 3 stores normalised file URIs (upper-case drive letter, see
 * `fileUri.ts`).  Rows written by version 2 may hold the same file under two
 * spellings, so the index is rebuilt rather than left to resolve the same
 * definition twice.
 *
 * Version 4 records the column of a symbol's *name* rather than of the
 * declaration holding it.  A `symbols` row from version 3 points at the
 * return type, which puts "go to definition" at the start of the line; a
 * content hash cannot detect that, so the index is rebuilt.
 *
 * Version 5 adds struct / union members.  Without them a member used outside
 * its struct (`motor.set_direction(…)`) has no definition to jump to.  A
 * rebuild is the only way to pick them up: the files themselves are unchanged.
 *
 * Version 6 adds declarations without an initialiser (`extern sixstep_t
 * motor;`).  Version 5 and earlier recorded only initialised definitions, so
 * most globals had uses but no definition to jump to.
 */
const SCHEMA_VERSION = 6;

/**
 * Delete a lock directory left behind by an earlier process.
 *
 * `node-sqlite3-wasm` implements SQLite's file lock as a `<db>.lock`
 * directory: created when the lock is taken, removed when it is released.
 * A process that is killed rather than shut down therefore leaves it behind,
 * and every later write fails with "database is locked" — the index would
 * stop updating for good.  A project's database is written by one server at
 * a time, so clearing the directory on open is the safe recovery.
 *
 * @returns whether a leftover lock was removed.
 */
export function removeStaleLock(dbPath: string): boolean {
  const lockDir = `${dbPath}.lock`;
  if (!fs.existsSync(lockDir)) return false;

  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Sync folders (OneDrive) make `rmSync` fail silently.
  }

  if (fs.existsSync(lockDir)) {
    try {
      // A lock directory is always empty, so the plain directory call works
      // where the recursive one does not.
      fs.rmdirSync(lockDir);
    } catch {
      // Still busy — leave it to the next open.
    }
  }

  return !fs.existsSync(lockDir);
}

// ── Database location ────────────────────────────────────────────────────

/**
 * Longest directory that contains every path in `paths`, or `null`.
 *
 * Used to work out a project's root from its source files.
 */
export function commonDirectory(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;

  let common = path.dirname(path.resolve(paths[0])).split(path.sep);

  for (const candidate of paths.slice(1)) {
    const parts = path.dirname(path.resolve(candidate)).split(path.sep);
    let i = 0;
    while (
      i < common.length &&
      i < parts.length &&
      common[i].toLowerCase() === parts[i].toLowerCase()
    ) {
      i++;
    }

    common = common.slice(0, i);
    if (common.length === 0) return null;
  }

  return common.join(path.sep) || null;
}

/**
 * Directory that holds a project's cache.
 *
 * CubeMX keeps the project file in `MDK-ARM/` while the sources live one
 * level up, so the directory containing the `.uvprojx` is not always the
 * project root.  The common ancestor of the project's source files is used
 * when it is an ancestor of the project file; otherwise the project file's
 * own directory wins (sources can legitimately live outside the project).
 */
export function resolveProjectRoot(
  projectPath: string,
  sourceFiles: readonly string[],
): string {
  const projectDir = path.dirname(path.resolve(projectPath));
  const common = commonDirectory(sourceFiles);
  if (!common) return projectDir;

  const projectDirLower = projectDir.toLowerCase();
  const commonLower = common.toLowerCase();

  if (
    projectDirLower === commonLower ||
    projectDirLower.startsWith(commonLower + path.sep)
  ) {
    return common;
  }

  return projectDir;
}

/**
 * Database path for one Keil project.
 *
 * One database per project: a workspace can contain several Keil projects
 * (a CubeMX repository often does), and merging their symbols would send
 * "go to definition" to the wrong project.  The cache sits in a
 * `.lingchain/` directory inside the project, next to the sources it
 * describes.
 */
export function projectDatabasePath(
  projectRoot: string,
  projectPath: string,
): string {
  const base =
    path
      .basename(projectPath, path.extname(projectPath))
      .toLowerCase()
      .replace(/[^\w.-]+/g, '_') || 'project';
  const hash = createHash('md5')
    .update(path.resolve(projectPath).toLowerCase())
    .digest('hex')
    .slice(0, 8);

  return path.join(projectRoot, '.lingchain', `${base}-${hash}.db`);
}

// ── SymbolIndex ──────────────────────────────────────────────────────────

/**
 * Persistent SQLite-backed index of C symbols.
 *
 * Schema:
 *  - **files** – one row per source file, keyed by URI.  The `hash` column
 *    stores the MD5 of the file content at the time of indexing; callers use
 *    this to skip re-indexing unchanged files.  Files that were only pulled
 *    in by a `#include` get a placeholder hash.
 *  - **symbols** – one row per extracted symbol (definition).  `origin` names
 *    the file whose indexing produced the row: with `armclang -E` a symbol is
 *    attributed to the header it was declared in, which may not be the file
 *    being indexed.  References `files` via foreign key so that deleting a
 *    file cascades to its symbols.
 *  - **usages** – one row per identifier occurrence (definitions included),
 *    backing "Find All References".  Also cascades from `files`.
 *
 * The `origin` column lets a re-index of one translation unit remove all the
 * rows it contributed, including those attributed to its headers.
 *
 * All public methods are async for consistency – the WASM SQLite driver is
 * synchronous under the hood, but async gives us the freedom to swap in a
 * native driver later without changing the call-sites.
 */
export class SymbolIndex {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Switch to another database file and open it.
   *
   * Each Keil project gets its own database, so symbols from different
   * projects in one workspace cannot mix.  A no-op when the path is
   * unchanged, which keeps re-selecting the same project cheap.
   */
  async reopen(dbPath: string): Promise<void> {
    if (this.db && path.resolve(dbPath) === path.resolve(this.dbPath)) {
      return;
    }

    await this.close();
    this.dbPath = dbPath;
    await this.init();
  }

  /** Path of the database currently in use (for logging and tests). */
  get currentPath(): string {
    return this.dbPath;
  }

  /**
   * Open (or create) the database and ensure the schema exists.
   */
  async init(): Promise<void> {
    removeStaleLock(this.dbPath);
    this.db = new Database(this.dbPath);

    // WAL keeps indexing from blocking concurrent readers; foreign keys carry
    // the cascade from `files` to `symbols` and `usages`.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    this.createSchema();
    this.migrate();
  }

  /**
   * Create the tables and indexes when they do not exist yet.
   */
  private createSchema(): void {
    const db = this.requireDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        uri   TEXT PRIMARY KEY,
        hash  TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        name   TEXT    NOT NULL,
        kind   TEXT    NOT NULL,
        file   TEXT    NOT NULL,
        line   INTEGER NOT NULL,
        column INTEGER NOT NULL,
        origin TEXT    NOT NULL DEFAULT '',
        FOREIGN KEY (file) REFERENCES files(uri) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS usages (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        name   TEXT    NOT NULL,
        file   TEXT    NOT NULL,
        line   INTEGER NOT NULL,
        column INTEGER NOT NULL,
        origin TEXT    NOT NULL DEFAULT '',
        FOREIGN KEY (file) REFERENCES files(uri) ON DELETE CASCADE
      );
    `);

    // Index the name so exact lookups (findByName) and prefix lookups
    // (findByPrefix via LIKE 'x%') use the B-tree instead of a full table
    // scan.  Substring search (findBySubstring) cannot use a B-tree and
    // remains a scan — acceptable for the target project sizes; FTS5 (with
    // the trigram tokenizer) is available in the WASM build if we ever need
    // fast substring search at scale.
    db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_usages_name ON usages(name);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_origin ON symbols(origin);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_usages_origin ON usages(origin);');
  }

  /**
   * Recreate the schema when the stored version is older.
   *
   * The index is derived data: dropping the tables just forces the next
   * indexing pass to rebuild them (with the current column set).
   */
  private migrate(): void {
    const db = this.requireDb();
    const row = db.get('PRAGMA user_version') as
      | { user_version?: number }
      | undefined;
    const current = row?.user_version ?? 0;

    if (current < SCHEMA_VERSION) {
      // Children first: the foreign keys reference `files`.
      db.exec('DROP TABLE IF EXISTS usages');
      db.exec('DROP TABLE IF EXISTS symbols');
      db.exec('DROP TABLE IF EXISTS files');
      this.createSchema();
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.reclaimSpace();
    }
  }

  /**
   * Return the pages freed by a rebuild to the filesystem.
   *
   * `DROP TABLE` marks pages free but leaves the file at its previous size, so
   * a rebuilt index keeps occupying whatever the old schema needed — a HAL
   * project's 75 MB stays 75 MB with almost nothing in it.  `VACUUM` rewrites
   * the file; the schema and `user_version` survive it.
   *
   * A failure here is not fatal: the index is valid either way, and re-aborting
   * `init` would take navigation down to save disk space.  Space is reclaimed
   * on the next rebuild instead.
   */
  private reclaimSpace(): void {
    try {
      this.requireDb().exec('VACUUM');
    } catch {
      // Another process holds the database – keep the index, skip the shrink.
    }
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      // Closing releases the lock; drop the directory as well in case the
      // runtime left it behind.
      removeStaleLock(this.dbPath);
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
   *
   * @param origin File whose indexing produced these rows (see the schema
   *               notes); empty when the caller has no such notion.
   */
  async insertSymbols(symbols: Symbol[], origin: string = ''): Promise<void> {
    if (symbols.length === 0) return;
    const db = this.requireDb();
    db.exec('BEGIN');
    try {
      for (const s of symbols) {
        db.run(
          'INSERT INTO symbols (name, kind, file, line, column, origin) VALUES (?, ?, ?, ?, ?, ?)',
          [s.name, s.kind, s.file, s.line, s.column, origin],
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
    return this.querySymbols('s.name = ?', [name]);
  }

  /**
   * Insert many identifier usages in one call.
   *
   * Wraps all inserts in a transaction.  The file must already exist in
   * `files` (insert it with `upsertFile` first) or the foreign key fails.
   */
  async insertUsages(usages: Usage[], origin: string = ''): Promise<void> {
    if (usages.length === 0) return;
    const db = this.requireDb();
    db.exec('BEGIN');
    try {
      for (const u of usages) {
        db.run(
          'INSERT INTO usages (name, file, line, column, origin) VALUES (?, ?, ?, ?, ?)',
          [u.name, u.file, u.line, u.column, origin],
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Remove every row contributed by indexing `origin`.
   *
   * Complements `deleteByFile`: rows attributed to headers pulled in by this
   * translation unit live under the header's `files` row, so the cascade from
   * `files` alone would leave them behind and they would accumulate on every
   * re-index.
   */
  async deleteContribution(origin: string): Promise<void> {
    if (!origin) return;
    const db = this.requireDb();
    db.run('DELETE FROM symbols WHERE origin = ?', [origin]);
    db.run('DELETE FROM usages WHERE origin = ?', [origin]);
  }

  /**
   * Return every recorded occurrence of `name` (definitions included),
   * ordered by file and position.
   *
   * @param limit Maximum number of results (default 500); references can be
   *              very numerous in generated or macro-heavy code.
   */
  async findUsagesByName(name: string, limit: number = 500): Promise<Usage[]> {
    const db = this.requireDb();
    const rows = db.all(
      `SELECT DISTINCT name, file, line, column
       FROM usages
       WHERE name = ?
       ORDER BY file, line, column
       LIMIT ?`,
      [name, limit],
    ) as Array<{ name: string; file: string; line: number; column: number }>;

    return rows.map((r) => ({
      name: r.name,
      file: r.file,
      line: r.line,
      column: r.column,
    }));
  }

  /**
   * Return every symbol that belongs to a given file.
   */
  async findByFile(uri: string): Promise<IndexedSymbol[]> {
    return this.querySymbols('s.file = ?', [uri]);
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
    // INSTR gives case-sensitive substring matching (SQLite LIKE is
    // case-insensitive for ASCII by default).
    return this.querySymbols('INSTR(s.name, ?) > 0', [query], 'LIMIT ?', [limit]);
  }

  /**
   * Search for symbols whose name starts with `prefix` (case-sensitive).
   *
   * Returns at most `limit` results (default 200), ordered by name.
   */
  async findByPrefix(
    prefix: string,
    limit: number = 200,
  ): Promise<IndexedSymbol[]> {
    return this.querySymbols(
      "s.name LIKE ? || '%'",
      [prefix],
      'ORDER BY s.name LIMIT ?',
      [limit],
    );
  }

  /**
   * Shared symbol query.
   *
   * Results are grouped by position: with `armclang -E` preprocessing a
   * header's declaration is re-observed in every translation unit that
   * includes it, so the same declaration is stored once per including file
   * (distinguished by `origin`).  Callers want one entry per definition.
   */
  private querySymbols(
    whereClause: string,
    whereParams: (string | number)[],
    tail = '',
    tailParams: (string | number)[] = [],
  ): IndexedSymbol[] {
    const db = this.requireDb();
    const rows = db.all(
      `SELECT MIN(s.id) AS id, s.name, s.kind, s.file, s.line, s.column, MIN(f.hash) AS hash
       FROM symbols s
       JOIN files f ON f.uri = s.file
       WHERE ${whereClause}
       GROUP BY s.name, s.kind, s.file, s.line, s.column
       ${tail}`,
      [...whereParams, ...tailParams],
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
