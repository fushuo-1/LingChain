#!/usr/bin/env node
/**
 * End-to-end LSP verification.
 *
 * Spins up a throwaway Keil-style project in a temp directory, starts the
 * language server over stdio, and drives it through the real request flow:
 *
 *   initialize → initialized → lingchain/selectProject → indexing
 *   → didOpen → definition / references / hover / documentSymbol
 *              / workspaceSymbol / completion
 *
 * Every step is asserted, so a regression in a provider shows up here
 * without needing VS Code, Keil, or armclang.
 *
 * Usage:
 *   node lsp_e2e_test.js [path/to/server.js]
 *
 * Defaults to `server/out/server.js`; pass `extension/server/out/server.js`
 * to verify a packaged bundle.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const serverPath =
  process.argv[2] || path.join(__dirname, 'server', 'out', 'server.js');

if (!fs.existsSync(serverPath)) {
  console.error(`Server not found: ${serverPath}\nRun "npm run build" first.`);
  process.exit(1);
}

// ── Fixture project ──────────────────────────────────────────────────────

const MAIN_C = [
  '#include "util.h"',
  '',
  'int main(void) {',
  '    int total = util_add(1, 2);',
  '    util_counter = total;',
  '    return util_clamp(total, 0, 10);',
  '}',
].join('\n');

const UTIL_H = [
  '#ifndef UTIL_H',
  '#define UTIL_H',
  '',
  'extern int util_counter;',
  'int util_add(int a, int b);',
  'int util_clamp(int value, int lo, int hi);',
  '',
  '#endif',
].join('\n');

const UTIL_C = [
  '#include "util.h"',
  '',
  // Deliberately without an initialiser: a declaration like this used to be
  // skipped, leaving the name with uses but no definition to jump to.
  'int util_counter;',
  '',
  'int util_add(int a, int b) {',
  '    return a + b;',
  '}',
  '',
  'int util_clamp(int value, int lo, int hi) {',
  '    if (value < lo) return lo;',
  '    if (value > hi) return hi;',
  '    return value;',
  '}',
].join('\n');

const UVPROJX = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<Project>
  <SchemaVersion>2.1</SchemaVersion>
  <Targets>
    <Target>
      <TargetName>Debug</TargetName>
      <TargetOption>
        <TargetCommonOption>
          <Device>STM32G071RBTx</Device>
          <Vendor>STMicroelectronics</Vendor>
        </TargetCommonOption>
        <TargetArmAds>
          <Cads>
            <VariousControls>
              <Define>USE_HAL_DRIVER,STM32G071xx</Define>
              <IncludePath>./Inc</IncludePath>
            </VariousControls>
          </Cads>
        </TargetArmAds>
      </TargetOption>
    </Target>
  </Targets>
  <Groups>
    <Group>
      <GroupName>Application</GroupName>
      <Files>
        <File><FileName>main.c</FileName><FileType>1</FileType><FilePath>.\\Src\\main.c</FilePath></File>
        <File><FileName>util.c</FileName><FileType>1</FileType><FilePath>.\\Src\\util.c</FilePath></File>
      </Files>
    </Group>
  </Groups>
</Project>
`;

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingchain-e2e-'));
writeFile(path.join(rootDir, 'Demo.uvprojx'), UVPROJX);
writeFile(path.join(rootDir, 'Src', 'main.c'), MAIN_C);
writeFile(path.join(rootDir, 'Src', 'util.c'), UTIL_C);
writeFile(path.join(rootDir, 'Inc', 'util.h'), UTIL_H);

const toUri = (p) => `file:///${p.replace(/\\/g, '/')}`;
const mainUri = toUri(path.join(rootDir, 'Src', 'main.c'));
const utilCUri = toUri(path.join(rootDir, 'Src', 'util.c'));

/** Locate `needle` in `content` and return a 0-based LSP position. */
function positionOf(content, needle, occurrence = 1) {
  let index = -1;
  for (let i = 0; i < occurrence; i++) {
    index = content.indexOf(needle, index + 1);
    if (index < 0) throw new Error(`"${needle}" not found in fixture`);
  }
  const before = content.slice(0, index);
  const line = before.split('\n').length - 1;
  const character = index - (before.lastIndexOf('\n') + 1);
  return { line, character };
}

// ── Minimal LSP client ───────────────────────────────────────────────────

function createClient(proc) {
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  const logs = [];
  const notifications = [];

  proc.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = buffer.slice(0, headerEnd).toString('utf-8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;

      const body = buffer.slice(bodyStart, bodyStart + length).toString('utf-8');
      buffer = buffer.slice(bodyStart + length);

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }

      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method) {
        notifications.push(message);
        if (message.method === 'window/logMessage') {
          logs.push(message.params.message);
        }
      }
    }
  });

  function send(message) {
    const body = JSON.stringify(message);
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  return {
    logs,
    notifications,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params });
    },
    async waitForLog(regex, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = logs.find((l) => regex.test(l));
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    },
  };
}

// ── Assertions ───────────────────────────────────────────────────────────

const results = [];

function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Locate the index database the server wrote: one per project, inside the
 * project's own `.lingchain/` directory.
 */
function findIndexDatabase(root) {
  const cacheDir = path.join(root, '.lingchain');
  if (!fs.existsSync(cacheDir)) return null;

  const candidates = fs
    .readdirSync(cacheDir)
    .filter((name) => name.endsWith('.db'))
    .map((name) => path.join(cacheDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return candidates[0] ?? null;
}

// ── Flow ─────────────────────────────────────────────────────────────────

async function main() {
  const proc = spawn(process.execPath, [serverPath, '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => (stderr += c.toString()));

  const client = createClient(proc);

  const init = await client.request('initialize', {
    processId: process.pid,
    rootUri: toUri(rootDir),
    capabilities: { textDocument: { synchronization: {} } },
  });

  const caps = init.result?.capabilities ?? {};
  check(
    'initialize handshake',
    !!caps.definitionProvider && !!caps.completionProvider,
    `textDocumentSync=${caps.textDocumentSync} completion=${!!caps.completionProvider}`,
  );

  client.notify('initialized', {});

  // Select the project immediately: a real client does not wait for the
  // server to finish loading its grammar and index, so the server must queue
  // this notification until it is ready (otherwise indexing never starts and
  // navigation stays empty).
  client.notify('lingchain/selectProject', {
    projectPath: path.join(rootDir, 'Demo.uvprojx'),
  });

  const grammarLoaded = await client.waitForLog(/tree-sitter C grammar loaded/);
  check('tree-sitter grammar loaded', !!grammarLoaded, grammarLoaded ?? 'no log line');

  const indexed = await client.waitForLog(/Indexing complete/);
  check('project indexed', !!indexed, indexed ?? 'indexing never completed');

  // Surface per-file indexing failures verbatim: they are the usual cause of
  // empty navigation/completion results further down.
  for (const line of client.logs.filter((l) => /Error indexing/.test(l))) {
    console.log(`      ${line}`);
  }

  // Inspect what the server actually persisted (WAL allows a second reader).
  try {
    const dbFile = findIndexDatabase(rootDir);
    if (!dbFile) throw new Error('no index database found');

    check(
      'index database is per project',
      /demo-[0-9a-f]{8}\.db$/i.test(dbFile),
      path.relative(rootDir, dbFile),
    );

    // The workspace root must stay clean: before a project is selected the
    // index is in memory, so only the project's own database may exist.
    const cacheNames = fs
      .readdirSync(path.join(rootDir, '.lingchain'))
      .sort();
    check(
      'no extra database is left in the workspace root',
      cacheNames.every((name) => /^demo-[0-9a-f]{8}\.db$/i.test(name)),
      cacheNames.join(', '),
    );

    const { Database } = require('node-sqlite3-wasm');
    const db = new Database(dbFile);
    const files = db.all('SELECT uri FROM files');
    console.log(`      db files   = ${files.length} row(s)`);
    console.log(`      db symbols = ${db.all('SELECT COUNT(*) AS c FROM symbols')[0].c}`);
    for (const row of files.slice(0, 3)) console.log(`        ${row.uri}`);
    db.close();
  } catch (err) {
    console.log(`      db inspection failed: ${err.message}`);
  }

  check(
    'indexing produced no errors',
    /Indexing complete: \d+ indexed, \d+ unchanged, 0 errors/.test(indexed ?? ''),
    indexed ?? 'indexing never completed',
  );

  // armclang may or may not be installed on the machine running this test;
  // both the preprocessed and the direct-parse path must index successfully.
  const armclangLog = client.logs.find((l) =>
    /armclang (resolved|not found)/.test(l),
  );
  console.log(`      ${armclangLog ?? 'no armclang log line'}`);

  // Open main.c so the providers can read the text under the cursor.
  client.notify('textDocument/didOpen', {
    textDocument: { uri: mainUri, languageId: 'c', version: 1, text: MAIN_C },
  });
  await new Promise((r) => setTimeout(r, 300));

  const callSite = positionOf(MAIN_C, 'util_add(1, 2)');

  // 1. documentSymbol
  const docSymbols = await client.request('textDocument/documentSymbol', {
    textDocument: { uri: mainUri },
  });
  const docNames = (docSymbols.result ?? []).map((s) => s.name);
  check(
    'textDocument/documentSymbol',
    docNames.includes('main'),
    `symbols: [${docNames.join(', ')}]`,
  );

  // 2. definition — call site jumps to util.c
  const definition = await client.request('textDocument/definition', {
    textDocument: { uri: mainUri },
    position: callSite,
  });
  const defs = definition.result ?? [];
  check(
    'textDocument/definition',
    defs.some((d) => d.uri === utilCUri),
    defs.map((d) => `${d.uri.split('/').pop()}:${d.range.start.line}`).join(', ') || 'no result',
  );

  // 3. definition of a variable declared without an initialiser — the
  // declaration in util.h and the definition in util.c are both valid
  // targets; what matters is that one is found at all.
  const counterUse = positionOf(MAIN_C, 'util_counter = total');
  const varDefinition = await client.request('textDocument/definition', {
    textDocument: { uri: mainUri },
    position: counterUse,
  });
  const varDefs = varDefinition.result ?? [];
  check(
    'definition of an uninitialised variable',
    varDefs.length > 0,
    varDefs.map((d) => `${d.uri.split('/').pop()}:${d.range.start.line}`).join(', ') || 'no result',
  );

  // 4. references — definition plus call site
  const references = await client.request('textDocument/references', {
    textDocument: { uri: mainUri },
    position: callSite,
    context: { includeDeclaration: true },
  });
  const refs = references.result ?? [];
  check(
    'textDocument/references',
    refs.length >= 2,
    `${refs.length} occurrence(s): ` +
      refs.map((r) => `${r.uri.split('/').pop()}:${r.range.start.line}:${r.range.start.character}`).join(', '),
  );

  // The same header position is observed once per including translation unit;
  // the index must collapse those duplicates.
  const uniqueRefs = new Set(
    refs.map((r) => `${r.uri}:${r.range.start.line}:${r.range.start.character}`),
  );
  check(
    'references contain no duplicates',
    uniqueRefs.size === refs.length,
    `${refs.length} result(s), ${uniqueRefs.size} unique`,
  );

  // 5. hover
  const hover = await client.request('textDocument/hover', {
    textDocument: { uri: mainUri },
    position: callSite,
  });
  const hoverText = hover.result?.contents?.value ?? '';
  check('textDocument/hover', hoverText.length > 0, hoverText.split('\n')[0] ?? 'empty');

  // 6. completion after a typed prefix
  const prefix = positionOf(MAIN_C, 'util_clamp(total');
  const completion = await client.request('textDocument/completion', {
    textDocument: { uri: mainUri },
    position: { line: prefix.line, character: prefix.character + 'util_'.length },
  });
  const labels = (completion.result ?? []).map((i) => i.label);
  check(
    'textDocument/completion',
    labels.includes('util_add') || labels.includes('util_clamp'),
    `labels: [${labels.slice(0, 6).join(', ')}]`,
  );

  // 6. workspace symbol search
  const workspaceSymbols = await client.request('workspace/symbol', {
    query: 'util_',
  });
  const wsNames = (workspaceSymbols.result ?? []).map((s) => s.name);
  check(
    'workspace/symbol',
    wsNames.includes('util_add'),
    `symbols: [${wsNames.slice(0, 6).join(', ')}]`,
  );

  const wsPositions = new Set(
    (workspaceSymbols.result ?? []).map(
      (s) => `${s.location.uri}:${s.location.range.start.line}`,
    ),
  );
  check(
    'workspace symbols contain no duplicate positions',
    wsPositions.size === (workspaceSymbols.result ?? []).length,
    `${(workspaceSymbols.result ?? []).length} result(s), ${wsPositions.size} unique`,
  );

  // 7. Diagnostics on save.  These need a working armclang; when it is not
  //    installed, nothing must be published (and no error logged).
  const armclangFound = /armclang resolved/.test(armclangLog ?? '');
  if (armclangFound) {
    client.notify('textDocument/didSave', {
      textDocument: { uri: mainUri },
    });

    const deadline = Date.now() + 20000;
    while (
      !client.notifications.some(
        (n) => n.method === 'textDocument/publishDiagnostics',
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 200));
    }

    const published = client.notifications.filter(
      (n) => n.method === 'textDocument/publishDiagnostics',
    );
    const last = published.at(-1)?.params;
    check(
      'textDocument/publishDiagnostics after save',
      published.length > 0,
      last
        ? `${last.diagnostics.length} diagnostic(s) for ${last.uri.split('/').pop()}`
        : 'no publishDiagnostics notification',
    );

    // A clean file publishing nothing could also mean the pipeline is dead.
    // Break the file on disk and require a real error to come back.
    fs.writeFileSync(
      path.join(rootDir, 'Src', 'main.c'),
      `${MAIN_C}\nint broken(void) { return 1 }\n`,
      'utf-8',
    );
    client.notify('textDocument/didSave', {
      textDocument: { uri: mainUri },
    });

    const errorDeadline = Date.now() + 20000;
    const hasError = () =>
      client.notifications.some(
        (n) =>
          n.method === 'textDocument/publishDiagnostics' &&
          n.params.diagnostics.length > 0,
      );
    while (!hasError() && Date.now() < errorDeadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    const errorPublish = client.notifications
      .filter((n) => n.method === 'textDocument/publishDiagnostics')
      .at(-1)?.params;
    check(
      'diagnostics report a real compile error',
      hasError(),
      errorPublish
        ? `${errorPublish.diagnostics.length} diagnostic(s): ${errorPublish.diagnostics
            .map((d) => `${d.severity}:${d.message}`)
            .join(' | ')
            .slice(0, 160)}`
        : 'no diagnostics for a file with a syntax error',
    );
  } else {
    console.log('SKIP  textDocument/publishDiagnostics (armclang not installed)');
  }

  // 8. No diagnostics path must never log internal failures.
  const diagnosticLogs = client.logs.filter((l) => /Diagnostics failed/.test(l));
  check('no spurious diagnostics', diagnosticLogs.length === 0, 'no internal failures logged');

  proc.kill();

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(', ')}` : ''),
  );
  if (stderr.trim()) console.log(`server stderr:\n${stderr.trim()}`);

  fs.rmSync(rootDir, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`e2e run failed: ${err.message}`);
  fs.rmSync(rootDir, { recursive: true, force: true });
  process.exit(1);
});
