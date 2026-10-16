#!/usr/bin/env node
/**
 * Stage everything the packaged extension needs to run standalone.
 *
 * The extension and the server are separate npm workspaces, and npm hoists
 * their dependencies to `vscode-extension/node_modules`.  A VSIX is installed
 * on its own, where neither hoisting nor the sibling `server/` workspace
 * exists, so this script materialises a self-contained package:
 *
 *   extension/node_modules/           extension runtime dependency closure
 *   extension/server/out/*.js         compiled LSP server
 *   extension/server/node_modules/    server runtime dependency closure
 *
 * The tree-sitter grammar bundle is trimmed to the single C grammar the
 * server loads, keeping the package small.
 *
 * Wired into `vscode:prepublish` and `package`; packaging passes
 * `--no-dependencies` so vsce does not try to resolve the hoisted tree.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const workspaceDir = path.resolve(__dirname, '..');
const extensionDir = path.join(workspaceDir, 'extension');
const serverDir = path.join(workspaceDir, 'server');
const serverStageDir = path.join(extensionDir, 'server');

/** Grammars kept from the tree-sitter-wasms package. */
const KEPT_GRAMMARS = ['tree-sitter-c.wasm'];

// ── Helpers ──────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** Walk up from `fromDir` looking for `node_modules/<name>/package.json`. */
function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the transitive production dependencies of `names`.
 *
 * @returns Map of package name -> absolute package directory.
 */
function resolveClosure(names, searchFrom) {
  const resolved = new Map();
  const queue = [...names];

  while (queue.length > 0) {
    const name = queue.shift();
    if (resolved.has(name)) continue;

    const dir = findPackageDir(name, searchFrom);
    if (!dir) {
      throw new Error(`Missing production dependency "${name}" – run npm install first.`);
    }

    resolved.set(name, dir);
    const pkg = readJson(path.join(dir, 'package.json'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push(dep);
  }

  return resolved;
}

/**
 * Recursively copy a directory.
 *
 * A hand-rolled walk instead of `fs.cpSync`: the latter crashed the process
 * (0xC0000409) while copying this workspace on OneDrive.
 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);

    if (entry.isDirectory()) {
      copyDir(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
    // Symlinks are intentionally skipped: the bundle must be self-contained.
  }
}

/**
 * Recursively remove a file or directory.
 *
 * Uses explicit unlink/rmdir instead of `fs.rmSync`: on this OneDrive path
 * `rmSync` silently does nothing (neither deleting nor throwing).
 */
function removePath(target) {
  const stat = fs.lstatSync(target);

  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }

  for (const entry of fs.readdirSync(target)) {
    removePath(path.join(target, entry));
  }
  fs.rmdirSync(target);
}

/** Replace `destDir` with the production dependency closure of `pkgDir`. */
function stageDependencies(pkgDir, destDir) {
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  const closure = resolveClosure(Object.keys(pkg.dependencies ?? {}), pkgDir);

  if (fs.existsSync(destDir)) removePath(destDir);
  fs.mkdirSync(destDir, { recursive: true });

  for (const [name, dir] of closure) {
    const target = path.join(destDir, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copyDir(dir, target);
  }

  return closure.size;
}

// ── Staging steps ────────────────────────────────────────────────────────

/** Stage the compiled server plus its dependency closure. */
function stageServer() {
  const serverEntry = path.join(serverDir, 'out', 'server.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `Compiled server not found at ${serverEntry} – run "npm run compile" in vscode-extension first.`,
    );
  }

  if (fs.existsSync(serverStageDir)) removePath(serverStageDir);
  fs.mkdirSync(path.join(serverStageDir, 'out'), { recursive: true });
  copyDir(path.join(serverDir, 'out'), path.join(serverStageDir, 'out'));

  const nodeModulesDir = path.join(serverStageDir, 'node_modules');
  const count = stageDependencies(serverDir, nodeModulesDir);

  // Keep only the grammar the server actually loads.
  const grammarDir = path.join(nodeModulesDir, 'tree-sitter-wasms', 'out');
  if (fs.existsSync(grammarDir)) {
    const before = fs.readdirSync(grammarDir);
    for (const entry of before) {
      if (!KEPT_GRAMMARS.includes(entry)) {
        removePath(path.join(grammarDir, entry));
      }
    }
  }

  // Minimal package.json so Node resolves deps from server/node_modules.
  const serverPkg = readJson(path.join(serverDir, 'package.json'));
  fs.writeFileSync(
    path.join(serverStageDir, 'package.json'),
    JSON.stringify(
      {
        name: '@lingchain/embedded-c-server-bundle',
        version: serverPkg.version,
        private: true,
        main: 'out/server.js',
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  return count;
}

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * Only the server is staged here: the extension client is bundled into a
 * single file by `bundle-extension.js` and needs no node_modules.
 */
function main() {
  const serverCount = stageServer();

  console.log(`[bundle] staged server (${serverCount} packages)`);
}

main();
