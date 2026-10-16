#!/usr/bin/env node
/**
 * Bundle the extension client into a single self-contained file.
 *
 * `vscode-languageclient` is hoisted to the workspace root by npm, which
 * neither `vsce` (its `npm list` call fails on workspaces) nor an installed
 * VSIX can resolve.  Bundling inlines it, so the package needs no
 * `extension/node_modules` at all.  `vscode` itself stays external — the
 * host provides it.
 *
 * Output: extension/out/extension.js (+ source map)
 */

'use strict';

const path = require('path');
const esbuild = require('esbuild');

const extensionDir = path.resolve(__dirname, '..', 'extension');

esbuild.buildSync({
  entryPoints: [path.join(extensionDir, 'src', 'extension.ts')],
  outfile: path.join(extensionDir, 'out', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});

console.log('[bundle-extension] wrote out/extension.js');
