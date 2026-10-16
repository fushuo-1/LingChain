/**
 * Live-symbol integration.
 *
 * Providers must prefer symbols extracted from open documents (including
 * unsaved edits) over the persisted index, without duplicating entries that
 * appear in both.
 */
import { Position, TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { NavigationProvider } from './navigationProvider';
import { CompletionProvider } from './completionProvider';
import { SymbolListProvider } from './symbolListProvider';
import { SymbolIndex } from './symbolIndex';
import { LiveSymbolStore, Symbol } from './symbol';

// ── Helpers ──────────────────────────────────────────────────────────────

const MAIN_URI = 'file:///project/main.c';

function makeSymbol(overrides: Partial<Symbol> = {}): Symbol {
  return {
    name: 'main',
    kind: 'function',
    file: MAIN_URI,
    line: 0,
    column: 0,
    ...overrides,
  };
}

/** Duck-typed live store backed by a plain object. */
function makeLiveStore(entries: Record<string, Symbol[]>): LiveSymbolStore {
  return {
    get: (uri) => entries[uri],
    all: () => Object.values(entries).flat(),
  };
}

function makeDocuments(...docs: TextDocument[]): TextDocuments<TextDocument> {
  const map = new Map(docs.map((d) => [d.uri, d]));
  return {
    get: (uri: string) => map.get(uri),
  } as unknown as TextDocuments<TextDocument>;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('live symbol integration', () => {
  let tmpDir: string;
  let index: SymbolIndex;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-test-'));
    index = new SymbolIndex(path.join(tmpDir, 'test.db'));
    await index.init();
  });

  afterEach(async () => {
    await index.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── NavigationProvider ────────────────────────────────────────────────

  describe('NavigationProvider', () => {
    it('should resolve a symbol that only exists as a live (unsaved) symbol', async () => {
      const live = makeSymbol({ name: 'fresh', line: 12, column: 3 });
      const provider = new NavigationProvider(
        index,
        makeLiveStore({ [MAIN_URI]: [live] }),
      );

      const doc = TextDocument.create(
        MAIN_URI,
        'c',
        1,
        'int fresh(void) { return 0; }',
      );
      const locations = await provider.getDefinition(
        MAIN_URI,
        Position.create(0, 5),
        makeDocuments(doc),
      );

      expect(locations).toEqual([
        {
          uri: MAIN_URI,
          range: {
            start: { line: 12, character: 3 },
            end: { line: 12, character: 8 },
          },
        },
      ]);
    });

    it('should prefer the live position and de-duplicate identical entries', async () => {
      await index.upsertFile(MAIN_URI, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'main', line: 0, column: 0 }));

      const provider = new NavigationProvider(
        index,
        makeLiveStore({
          [MAIN_URI]: [
            makeSymbol({ name: 'main', line: 40, column: 0 }),
            // Identical to the indexed row: must not be returned twice.
            makeSymbol({ name: 'main', line: 0, column: 0 }),
          ],
        }),
      );

      const doc = TextDocument.create(MAIN_URI, 'c', 1, 'int main(void) {}');
      const locations = await provider.getDefinition(
        MAIN_URI,
        Position.create(0, 4),
        makeDocuments(doc),
      );

      expect(locations).toHaveLength(2);
      // Live symbols come first.
      expect(locations[0].range.start.line).toBe(40);
      expect(locations[1].range.start.line).toBe(0);
    });
  });

  // ── CompletionProvider ────────────────────────────────────────────────

  describe('CompletionProvider', () => {
    it('should complete identifiers typed but not yet saved', async () => {
      const provider = new CompletionProvider(
        index,
        makeLiveStore({
          [MAIN_URI]: [makeSymbol({ name: 'draft_helper', line: 3, column: 4 })],
        }),
      );

      const doc = TextDocument.create(MAIN_URI, 'c', 1, 'void f(void) { dra');
      const items = await provider.getCompletion(
        MAIN_URI,
        Position.create(0, 16),
        makeDocuments(doc),
      );

      expect(items.map((i) => i.label)).toContain('draft_helper');
    });

    it('should not list the same name twice when it is both live and indexed', async () => {
      await index.upsertFile(MAIN_URI, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'shared', line: 1 }));

      const provider = new CompletionProvider(
        index,
        makeLiveStore({ [MAIN_URI]: [makeSymbol({ name: 'shared', line: 9 })] }),
      );

      const doc = TextDocument.create(MAIN_URI, 'c', 1, 'void f(void) { sha');
      const items = await provider.getCompletion(
        MAIN_URI,
        Position.create(0, 16),
        makeDocuments(doc),
      );

      expect(items.filter((i) => i.label === 'shared')).toHaveLength(1);
    });
  });

  // ── SymbolListProvider ────────────────────────────────────────────────

  describe('SymbolListProvider', () => {
    it('should prefer live symbols for the Outline view', async () => {
      await index.upsertFile(MAIN_URI, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'old_name', line: 0 }));

      const provider = new SymbolListProvider(
        index,
        makeLiveStore({ [MAIN_URI]: [makeSymbol({ name: 'new_name', line: 5 })] }),
      );

      const symbols = await provider.getDocumentSymbols(MAIN_URI);

      expect(symbols.map((s) => s.name)).toEqual(['new_name']);
      expect(symbols[0].range.start.line).toBe(5);
    });

    it('should fall back to the index when no live symbols exist', async () => {
      await index.upsertFile(MAIN_URI, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'indexed', line: 2 }));

      const provider = new SymbolListProvider(index, makeLiveStore({}));
      const symbols = await provider.getDocumentSymbols(MAIN_URI);

      expect(symbols.map((s) => s.name)).toEqual(['indexed']);
    });

    it('should merge live and indexed symbols for workspace search', async () => {
      await index.upsertFile(MAIN_URI, 'hash');
      await index.insertSymbol(makeSymbol({ name: 'hal_indexed', line: 1 }));

      const provider = new SymbolListProvider(
        index,
        makeLiveStore({
          [MAIN_URI]: [makeSymbol({ name: 'hal_unsaved', line: 7 })],
          'file:///project/other.c': [makeSymbol({ name: 'unrelated', line: 0 })],
        }),
      );

      const names = (await provider.getWorkspaceSymbols('hal')).map(
        (s) => s.name,
      );

      expect(names).toContain('hal_indexed');
      expect(names).toContain('hal_unsaved');
      expect(names).not.toContain('unrelated');
    });
  });
});
