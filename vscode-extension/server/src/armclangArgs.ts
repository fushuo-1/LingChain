/**
 * armclang target flags.
 *
 * ARM Compiler 6 refuses to compile without an explicit `--target`, and a
 * missing `-mcpu` produces code for the default CPU of the target triple
 * rather than the project's device.  Both the preprocessor and the
 * diagnostics provider build their command lines from this module so the
 * flags cannot drift apart.
 */

// ── Constants ────────────────────────────────────────────────────────────

/** ARM Compiler 6 target triple for bare-metal ARM. */
const ARM_TARGET = '--target=arm-arm-none-eabi';

/**
 * STM32 series -> Cortex-M variant, as accepted by `-mcpu`.
 *
 * Series is the two characters following `STM32` in the device name
 * (e.g. `STM32G071RBTx` -> `G0`).
 */
const SERIES_TO_CORTEX: Record<string, string> = {
  C0: 'cortex-m0plus',
  F0: 'cortex-m0',
  F1: 'cortex-m3',
  F2: 'cortex-m3',
  F3: 'cortex-m4',
  F4: 'cortex-m4',
  F7: 'cortex-m7',
  G0: 'cortex-m0plus',
  G4: 'cortex-m4',
  H5: 'cortex-m33',
  H7: 'cortex-m7',
  L0: 'cortex-m0plus',
  L1: 'cortex-m3',
  L4: 'cortex-m4',
  L5: 'cortex-m33',
  U5: 'cortex-m33',
  WB: 'cortex-m4',
  WL: 'cortex-m4',
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Extract the STM32 series from a Keil device name.
 *
 * @param device Device name such as `STM32G071RBTx`.
 * @returns Series such as `G0`, or `null` when the name is not recognised.
 */
export function seriesForDevice(device: string | undefined | null): string | null {
  if (!device) return null;
  const match = device.trim().toUpperCase().match(/^STM32([A-Z0-9]{2})/);
  return match ? match[1] : null;
}

/**
 * Map a Keil device name to an armclang `-mcpu` value.
 *
 * @returns Cortex-M variant (e.g. `cortex-m0plus`), or `null` when unknown.
 */
export function cortexForDevice(device: string | undefined | null): string | null {
  const series = seriesForDevice(device);
  if (!series) return null;
  return SERIES_TO_CORTEX[series] ?? null;
}

/**
 * Build the armclang flags that select the compilation target.
 *
 * Always includes `--target`; `-mcpu` is added when the device is known.
 * An empty result would make armclang fail, so `--target` is unconditional.
 *
 * @param device Device name from the Keil project (may be empty).
 */
export function armclangTargetFlags(
  device: string | undefined | null,
): string[] {
  const flags = [ARM_TARGET];
  const cpu = cortexForDevice(device);
  if (cpu) {
    flags.push(`-mcpu=${cpu}`);
  }
  return flags;
}
