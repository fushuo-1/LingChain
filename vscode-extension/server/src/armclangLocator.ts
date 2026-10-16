/**
 * armclang discovery.
 *
 * armclang.exe is not normally on PATH: it ships inside a Keil MDK
 * installation (`<root>/ARM/ARMCLANG/bin/armclang.exe`).  This module
 * resolves it in order of trust:
 *
 *  1. an explicit path supplied by the client (VS Code setting)
 *  2. environment variables (`KEIL_ARMCLANG`, `ARMCLANG_PATH`, `KEIL_MDK`,
 *     `KEIL_UV4`)
 *  3. the Keil registry key `HKLM\SOFTWARE\Keil\Products\MDK`
 *  4. well-known installation directories
 *  5. the `PATH` environment variable
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// ── Types ────────────────────────────────────────────────────────────────

/** Where a resolved armclang path came from (useful in logs). */
export type ArmclangSource =
  | 'configured'
  | 'env'
  | 'registry'
  | 'common-path'
  | 'path';

/** A resolved armclang executable. */
export interface ArmclangLocation {
  path: string;
  source: ArmclangSource;
}

// ── Constants ────────────────────────────────────────────────────────────

const EXECUTABLE = process.platform === 'win32' ? 'armclang.exe' : 'armclang';

/** Name of the armclang executable on this platform. */
export const ARMCLANG_EXECUTABLE = EXECUTABLE;

/** armclang's location relative to a Keil installation root. */
export const KEIL_RELATIVE_EXECUTABLE = path.join(
  'ARM',
  'ARMCLANG',
  'bin',
  EXECUTABLE,
);

const COMMON_KEIL_ROOTS = [
  'C:/Keil_v5',
  'D:/Keil_v5',
  'E:/Keil_v5',
  'C:/Program Files/Keil_v5',
  'D:/Program Files/Keil_v5',
  'C:/Program Files (x86)/Keil_v5',
];

const REGISTRY_KEY = 'HKLM\\SOFTWARE\\Keil\\Products\\MDK';

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Locate the armclang executable.
 *
 * @param explicitPath Path configured by the user; used verbatim when it
 *                     points at an existing file.
 * @returns The resolved location, or `null` when armclang cannot be found.
 */
export function locateArmclang(
  explicitPath?: string | null,
): ArmclangLocation | null {
  if (explicitPath) {
    const resolved = resolveCandidate(explicitPath);
    if (resolved) return { path: resolved, source: 'configured' };
  }

  const fromEnv = locateFromEnv();
  if (fromEnv) return fromEnv;

  const fromRegistry = locateFromRegistry();
  if (fromRegistry) return fromRegistry;

  for (const root of COMMON_KEIL_ROOTS) {
    const candidate = resolveCandidate(path.join(root, KEIL_RELATIVE_EXECUTABLE));
    if (candidate) return { path: candidate, source: 'common-path' };
  }

  const onPath = findOnPath(EXECUTABLE);
  if (onPath) return { path: onPath, source: 'path' };

  return null;
}

// ── Internals ────────────────────────────────────────────────────────────

/**
 * Normalise a user-supplied path: it may point at the executable, at its
 * directory, or at a Keil installation root.
 */
function resolveCandidate(candidate: string): string | null {
  const cleaned = candidate.trim().replace(/^"|"$/g, '');
  if (!cleaned) return null;

  if (fs.existsSync(cleaned) && fs.statSync(cleaned).isFile()) {
    return cleaned;
  }

  const asDir = path.join(cleaned, EXECUTABLE);
  if (fs.existsSync(asDir)) return asDir;

  const asKeilRoot = path.join(cleaned, KEIL_RELATIVE_EXECUTABLE);
  if (fs.existsSync(asKeilRoot)) return asKeilRoot;

  return null;
}

/** Resolve armclang from environment variables, in order of specificity. */
function locateFromEnv(): ArmclangLocation | null {
  const direct = ['KEIL_ARMCLANG', 'ARMCLANG_PATH'];
  for (const name of direct) {
    const value = process.env[name];
    if (!value) continue;
    const resolved = resolveCandidate(value);
    if (resolved) return { path: resolved, source: 'env' };
  }

  // KEIL_MDK points at a Keil root; KEIL_UV4 points at <root>/UV4/UV4.exe.
  const mdkRoot = process.env.KEIL_MDK;
  if (mdkRoot) {
    const resolved = resolveCandidate(
      path.join(mdkRoot, KEIL_RELATIVE_EXECUTABLE),
    );
    if (resolved) return { path: resolved, source: 'env' };
  }

  const uv4 = process.env.KEIL_UV4;
  if (uv4) {
    const root = path.dirname(path.dirname(uv4));
    const resolved = resolveCandidate(path.join(root, KEIL_RELATIVE_EXECUTABLE));
    if (resolved) return { path: resolved, source: 'env' };
  }

  return null;
}

/**
 * Read the Keil installation root from the Windows registry.
 *
 * Uses `reg.exe` rather than a native binding so no optional dependency is
 * required; failures are treated as "not installed".
 */
function locateFromRegistry(): ArmclangLocation | null {
  if (process.platform !== 'win32') return null;

  try {
    const output = execFileSync('reg', ['query', REGISTRY_KEY, '/v', 'Path'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const value = parseRegQueryPath(output);
    if (!value) return null;

    const resolved = resolveCandidate(path.join(value, KEIL_RELATIVE_EXECUTABLE));
    if (resolved) return { path: resolved, source: 'registry' };
  } catch {
    // reg.exe missing or key absent – not an error, just "not found here".
  }

  return null;
}

/**
 * Extract the value of a `REG_SZ` line from `reg query` output, e.g.
 *
 *     HKEY_LOCAL_MACHINE\SOFTWARE\Keil\Products\MDK
 *         Path    REG_SZ    C:\Keil_v5\
 *
 * Exported for testing.
 */
export function parseRegQueryPath(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/REG_SZ\s+(.+?)\s*$/);
    if (match) return match[1];
  }
  return null;
}

/** Look for `exe` in every directory on PATH. */
function findOnPath(exe: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
