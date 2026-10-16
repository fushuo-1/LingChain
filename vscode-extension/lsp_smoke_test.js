#!/usr/bin/env node
/**
 * LSP smoke test.
 *
 * Spawns a built server over stdio, performs the `initialize` /
 * `initialized` handshake, and reports whether the server came up and
 * loaded the tree-sitter grammar (it logs a warning when it cannot).
 *
 * Usage:
 *   node lsp_smoke_test.js [path/to/server.js]
 *
 * Defaults to `server/out/server.js` (development layout).  Pass
 * `extension/server/out/server.js` to check a packaged bundle.
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

// Point the server's cache at a scratch directory so the workspace is not
// touched (the server creates <root>/.lingchain on startup).
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingchain-smoke-'));
const rootUri = `file:///${rootDir.replace(/\\/g, '/')}`;

const proc = spawn(process.execPath, [serverPath, '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
proc.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

// ── LSP framing ──────────────────────────────────────────────────────────

function send(message) {
  const body = JSON.stringify(message);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

const messages = [];
let buffer = Buffer.alloc(0);

function drain() {
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;

    const header = buffer.slice(0, headerEnd).toString('utf-8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return;

    const length = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;

    const body = buffer.slice(bodyStart, bodyStart + length).toString('utf-8');
    buffer = buffer.slice(bodyStart + length);

    try {
      messages.push(JSON.parse(body));
    } catch {
      // Ignore unparseable frames.
    }
  }
}

proc.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

// ── Flow ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { processId: process.pid, rootUri, capabilities: {} },
  });
}, 300);

setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
}, 1200);

setTimeout(() => {
  const response = messages.find((m) => m.id === 1);
  const logs = messages
    .filter((m) => m.method === 'window/logMessage')
    .map((m) => m.params.message);
  const treeSitterFailed = logs.some((l) => /tree-sitter unavailable/.test(l));
  const grammarLoaded = logs.some((l) => /tree-sitter C grammar loaded/.test(l));

  console.log(`server:      ${serverPath}`);
  console.log(`initialize:  ${response ? 'OK' : 'NO RESPONSE'}`);
  if (response?.result?.capabilities) {
    const caps = response.result.capabilities;
    console.log(
      `capabilities: definition=${!!caps.definitionProvider} references=${!!caps.referencesProvider} ` +
        `hover=${!!caps.hoverProvider} documentSymbol=${!!caps.documentSymbolProvider} ` +
        `workspaceSymbol=${!!caps.workspaceSymbolProvider} completion=${!!caps.completionProvider}`,
    );
  }
  for (const line of logs) console.log(`log:         ${line}`);
  if (stderr.trim()) console.log(`stderr:      ${stderr.trim()}`);

  console.log(
    grammarLoaded
      ? 'RESULT: PASS (tree-sitter grammar loaded)'
      : 'RESULT: FAIL (tree-sitter grammar not loaded)',
  );

  proc.kill();
  fs.rmSync(rootDir, { recursive: true, force: true });
  process.exit(grammarLoaded && response ? 0 : 1);
}, 4000);
