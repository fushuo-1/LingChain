const { spawn } = require('child_process');
const serverPath = 'D:/OneDrive/LingµChain-worktrees/slice-01-lsp-skeleton/vscode-extension/server/out/server.js';

const proc = spawn('node', [serverPath, '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';

proc.stdout.on('data', (d) => { stdout += d.toString(); });
proc.stderr.on('data', (d) => { stderr += d.toString(); });
proc.on('error', (err) => { console.error('Spawn error:', err.message); });
proc.on('exit', (code, signal) => {
  console.error('Exit code:', code, 'signal:', signal);
  console.error('Stderr:', stderr);

  // Parse LSP response
  const contentLengthMatch = stdout.match(/Content-Length:\s*(\d+)/);
  if (contentLengthMatch) {
    const len = parseInt(contentLengthMatch[1]);
    const jsonStart = stdout.indexOf('\r\n\r\n') + 4;
    const jsonBody = stdout.substring(jsonStart, jsonStart + len);
    try {
      const response = JSON.parse(jsonBody);
      if (response.result && response.result.capabilities && response.result.capabilities.textDocumentSync !== undefined) {
        console.log('SMOKE TEST PASSED');
        console.log('textDocumentSync:', response.result.capabilities.textDocumentSync);
        process.exit(0);
      } else {
        console.log('SMOKE TEST FAILED - missing textDocumentSync');
        console.log(JSON.stringify(response, null, 2));
        process.exit(1);
      }
    } catch (e) {
      console.log('SMOKE TEST FAILED - parse error:', e.message);
      console.log('Raw:', jsonBody);
      process.exit(1);
    }
  } else {
    console.log('SMOKE TEST FAILED - no Content-Length header');
    console.log('Raw stdout:', JSON.stringify(stdout));
    process.exit(1);
  }
});

const request = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { processId: null, rootUri: null, capabilities: {} }
});
const message = `Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`;

setTimeout(() => {
  proc.stdin.write(message);
  // End stdin after a brief delay so server processes and responds
  setTimeout(() => proc.stdin.end(), 500);
}, 500);

// Safety timeout
setTimeout(() => {
  console.error('TIMEOUT - killing process');
  proc.kill();
  process.exit(1);
}, 10000);
