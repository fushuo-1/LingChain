import { armclangTargetFlags, cortexForDevice, seriesForDevice } from './armclangArgs';

// ── seriesForDevice ──────────────────────────────────────────────────────

describe('seriesForDevice', () => {
  it('should extract the series from a Keil device name', () => {
    expect(seriesForDevice('STM32G071RBTx')).toBe('G0');
    expect(seriesForDevice('STM32F407VET6')).toBe('F4');
    expect(seriesForDevice('STM32H743ZITx')).toBe('H7');
  });

  it('should be case-insensitive', () => {
    expect(seriesForDevice('stm32l432kc')).toBe('L4');
  });

  it('should return null for missing or unrecognised names', () => {
    expect(seriesForDevice('')).toBeNull();
    expect(seriesForDevice(undefined)).toBeNull();
    expect(seriesForDevice(null)).toBeNull();
    expect(seriesForDevice('ATMEGA328P')).toBeNull();
  });
});

// ── cortexForDevice ──────────────────────────────────────────────────────

describe('cortexForDevice', () => {
  it('should map known STM32 series to Cortex-M variants', () => {
    expect(cortexForDevice('STM32G071RBTx')).toBe('cortex-m0plus');
    expect(cortexForDevice('STM32F103C8Tx')).toBe('cortex-m3');
    expect(cortexForDevice('STM32F407VET6')).toBe('cortex-m4');
    expect(cortexForDevice('STM32H743ZITx')).toBe('cortex-m7');
    expect(cortexForDevice('STM32L552ZETx')).toBe('cortex-m33');
  });

  it('should return null for an unmapped series', () => {
    expect(cortexForDevice('STM32U073xx')).toBeNull();
    expect(cortexForDevice('')).toBeNull();
  });
});

// ── armclangTargetFlags ──────────────────────────────────────────────────

describe('armclangTargetFlags', () => {
  it('should always include --target', () => {
    expect(armclangTargetFlags('')).toContain('--target=arm-arm-none-eabi');
    expect(armclangTargetFlags('STM32G071RBTx')).toContain(
      '--target=arm-arm-none-eabi',
    );
  });

  it('should add -mcpu when the device is known', () => {
    expect(armclangTargetFlags('STM32G071RBTx')).toEqual([
      '--target=arm-arm-none-eabi',
      '-mcpu=cortex-m0plus',
    ]);
  });

  it('should omit -mcpu when the device is unknown', () => {
    expect(armclangTargetFlags('')).toEqual(['--target=arm-arm-none-eabi']);
    expect(armclangTargetFlags('STM32U073xx')).toEqual([
      '--target=arm-arm-none-eabi',
    ]);
  });
});
