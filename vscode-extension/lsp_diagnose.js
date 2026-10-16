#!/usr/bin/env node
/**
 * Diagnose indexing for a real Keil project.
 *
 * Answers "why doesn't navigation work?" by running the same flow the VS Code
 * extension does — parse the .uvprojx, start the server, select the project,
 * wait for indexing — and then reporting what actually landed in the index.
 *
 * Usage:
 *   node lsp_diagnose.js <project-dir-or-uvprojx> [server.js] [--timeout-ms N]
 *
 * Examples:
 *   node lsp_diagnose.js "D:\proj\FOC-stm32g070"
 *   node lsp_diagnose.js "D:\proj\FOC-stm32g070\MDK-ARM\FOC.uvprojx" server/out/server.js
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Arguments ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const timeoutFlag = argv.indexOf('--timeout-ms');
const timeoutMs = timeoutFlag >= 0 ? parseInt(argv[timeoutFlag + 1], 10) : 300000;
const positional = argv.filter(
  (a, i) => !a.startsWith('--') && !(timeoutFlag >= 0 && i === timeoutFlag + 1),
);

const inputPath = positional[0];
const serverPath =
  positional[1] || path.join(__dirname, 'server', 'out', 'server.js');
if (!inputPath) {
  console.error(
    'Usage: node lsp_diagnose.js <project-dir-or-uvprojx> [server.js] [--timeout-ms N]',
  );
  process.exit(2);
}

if (!fs.existsSync(serverPath)) {
  console.error(`Server not found: ${serverPath}\nRun "npm run build" first.`);
  process.exit(2);
}

/** Find .uvprojx files under `dir`, skipping build/vendor directories. */
function findProjects(dir, depth = 0) {
  if (depth > 4) return [];
  const skip = new Set(['node_modules', '.git', 'Objects', 'Listings', 'out']);
  const found = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      found.push(...findProjects(path.join(dir, entry.name), depth + 1));
    } else if (entry.name.toLowerCase().endsWith('.uvprojx')) {
      found.push(path.join(dir, entry.name));
    }
  }

  return found;
}

const stats = fs.statSync(inputPath);
let projectFile;
let rootDir;

if (stats.isDirectory()) {
  rootDir = inputPath;
  const candidates = findProjects(inputPath);
  if (candidates.length === 0) {
    console.error(`No .uvprojx found under ${inputPath}`);
    process.exit(2);
  }
  if (candidates.length > 1) {
    console.error(
      `Multiple .uvprojx found — pass the one you mean:\n  ${candidates.join('\n  ')}`,
    );
    process.exit(2);
  }
  projectFile = candidates[0];
} else {
  projectFile = inputPath;
  rootDir = path.dirname(inputPath);
}

const toUri = (p) => `file:///${p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')}`;

/**
 * Locate the index database for the project: one per project, inside the
 * project's own `.lingchain/` directory.
 */
function findIndexDatabase(projectFile, sourceFiles) {
  const projectRoot = resolveProjectRoot(projectFile, sourceFiles ?? []);
  const dbFile = projectDatabasePath(projectRoot, projectFile);
  return fs.existsSync(dbFile) ? dbFile : null;
}

// ── Step 1: project parsing (no server involved) ──────────────────────────

console.log(`project : ${projectFile}`);
console.log(`root    : ${rootDir}\n`);

const serverDir = path.dirname(path.resolve(serverPath));

const { KeilProject } = require(path.join(serverDir, 'keilProject.js'));
const {
  projectDatabasePath,
  resolveProjectRoot,
} = require(path.join(serverDir, 'symbolIndex.js'));

const project = new KeilProject(projectFile);
project.parse();
const targets = project.getTargetNames();
const ctx = project.getCompileContext();
const cSources = ctx.sourceFiles.filter((f) => /\.(c|h)$/i.test(f));
const otherSources = ctx.sourceFiles.filter((f) => !/\.(c|h)$/i.test(f));

console.log('── project ─────────────────────────────────────────');
console.log(`targets        : ${targets.length} [${targets.join(', ')}]`);
console.log(`device         : ${ctx.target || '(none)'}`);
console.log(`include paths  : ${ctx.includePaths.length}`);
console.log(`defines        : ${ctx.defines.length} [${ctx.defines.join(', ')}]`);
console.log(`source files   : ${ctx.sourceFiles.length} (${cSources.length} C/H, ${otherSources.length} other)`);

if (ctx.sourceFiles.length === 0) {
  console.log(
    '\n✗ No source files parsed from the project — indexing cannot start.\n' +
      '  Check the <Groups>/<Files> layout inside the .uvprojx.',
  );
  process.exit(1);
}

const missing = ctx.sourceFiles.filter((f) => !fs.existsSync(f));
if (missing.length > 0) {
  console.log(`missing on disk : ${missing.length}`);
  for (const f of missing.slice(0, 5)) console.log(`  ${f}`);
}

// ── Step 2: drive the server ─────────────────────────────────────────────

const proc = spawn(process.execPath, [serverPath, '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = Buffer.alloc(0);
const logs = [];
const pending = new Map();
let nextId = 1;

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
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.slice(start, start + length).toString('utf-8');
    buffer = buffer.slice(start + length);

    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }

    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'window/logMessage') {
      logs.push(message.params.message);
    }
  }
});

function send(message) {
  const body = JSON.stringify(message);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

async function waitFor(regex, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const hit = logs.find((l) => regex.test(l));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function main() {
  await request('initialize', {
    processId: process.pid,
    rootUri: toUri(rootDir),
    capabilities: {},
  });
  notify('initialized', {});

  const grammar = await waitFor(/tree-sitter C grammar loaded|tree-sitter unavailable/, 20000);
  console.log('\n── server ──────────────────────────────────────────');
  console.log(`tree-sitter    : ${grammar ?? '(no log line!)'}`);

  console.log(`\nIndexing ${ctx.sourceFiles.length} file(s) — this can take a while…`);
  const started = Date.now();
  notify('lingchain/selectProject', { projectPath: projectFile });

  const done = await waitFor(/Indexing complete/, timeoutMs);
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);

  const armclang = logs.find((l) => /armclang (resolved|not found)/.test(l));
  console.log(`armclang       : ${armclang ?? '(no log line)'}`);

  if (!done) {
    console.log(`\n✗ Indexing did not finish within ${timeoutMs} ms (${elapsed}s).`);
  } else {
    console.log(`\nSummary        : ${done.replace('[indexer] ', '')}  (${elapsed}s)`);
  }

  const failures = logs.filter((l) => /Error indexing/.test(l));
  console.log(`file errors    : ${failures.length}`);
  for (const line of failures.slice(0, 15)) console.log(`  ${line}`);

  // ── What actually landed in the index ──────────────────────────────────
  const projectRoot = resolveProjectRoot(projectFile, ctx.sourceFiles);
  const dbPath = findIndexDatabase(projectFile, ctx.sourceFiles);
  console.log(`\nproject root   : ${projectRoot}`);
  console.log(`── index ${dbPath ? `(${dbPath})` : ''} ─────────────`);
  if (!dbPath) {
    console.log('no index database found under <root>/.lingchain');
    proc.kill();
    return;
  }

  try {
    const { Database } = require('node-sqlite3-wasm');
    const db = new Database(dbPath);
    const files = db.all('SELECT uri FROM files').length;
    const symbols = db.all('SELECT COUNT(*) AS c FROM symbols')[0].c;
    const usages = db.all('SELECT COUNT(*) AS c FROM usages')[0].c;
    console.log(`files          : ${files}`);
    console.log(`symbols        : ${symbols}`);
    console.log(`usages         : ${usages}`);

    if (symbols > 0) {
      const top = db.all(
        `SELECT file, COUNT(*) AS c FROM symbols GROUP BY file ORDER BY c DESC LIMIT 5`,
      );
      console.log('top files by symbols:');
      for (const row of top) {
        console.log(`  ${row.c.toString().padStart(5)}  ${path.basename(row.file)}`);
      }
    }

    // Files that were indexed but produced no symbol at all.
    const empty = [];
    for (const file of ctx.sourceFiles) {
      const uri = toUri(file);
      const count = db.all(
        'SELECT COUNT(*) AS c FROM symbols WHERE file = ?',
        [uri],
      )[0].c;
      if (count === 0) empty.push(path.basename(file));
    }
    if (empty.length > 0) {
      console.log(`files with 0 symbols: ${empty.length}`);
      for (const name of empty.slice(0, 10)) console.log(`  ${name}`);
    }

    db.close();

    console.log('\n── verdict ─────────────────────────────────────────');
    if (symbols === 0) {
      console.log(
        '✗ Index is empty — navigation will not work.\n' +
          '  See the file errors above; if there are none, check that the\n' +
          '  selected project is the one VS Code has open.',
      );
    } else if (failures.length > 0) {
      console.log(
        `~ Index has ${symbols} symbol(s) but ${failures.length} file(s) failed —\n` +
          '  navigation works for the rest.',
      );
    } else {
      console.log(`✓ Index has ${symbols} symbol(s) in ${files} file(s) — navigation should work.`);
    }
  } catch (err) {
    console.log(`could not inspect the index: ${err.message}`);
  }

  proc.kill();
}

main()
  .catch((err) => console.error(`diagnose failed: ${err.message}`))
  .finally(() => {
    proc.kill();
    process.exit(0);
  });
