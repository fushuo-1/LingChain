"""Oscilloscope communication via VISA/SCPI.

Provides connection management and data acquisition for UNI-T UTD2000 series
oscilloscopes (and compatible SCPI instruments over USB VISA).

Usage:
    scope = get_scope()           # auto-scan USB
    scope = get_scope("USB0::...")  # explicit address
    waveform = read_waveform(scope, channel=1)
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

import pyvisa

logger = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────

VISA_TIMEOUT_MS = 10_000
WAVEFORM_TIMEOUT_MS = 30_000
SCOPE_USB_VENDOR = 0x5656  # UNI-T vendor ID

# SCPI measurement types we try to read
MEASUREMENT_TYPES = [
    ("FREQ", "frequency"),
    ("PER", "period"),
    ("VAMP", "amplitude"),
    ("VMAX", "v_max"),
    ("VMIN", "v_min"),
    ("VRMS", "v_rms"),
    ("RIS", "rise_time"),
    ("FALL", "fall_time"),
]


# ── Data classes ───────────────────────────────────────────────


@dataclass
class ScopeInfo:
    """Identifying information from *IDN?."""

    manufacturer: str
    model: str
    serial: str
    firmware: str

    @classmethod
    def from_idn(cls, idn: str) -> ScopeInfo:
        parts = [p.strip() for p in idn.split(",")]
        while len(parts) < 4:
            parts.append("")
        return cls(
            manufacturer=parts[0],
            model=parts[1],
            serial=parts[2],
            firmware=parts[3],
        )


@dataclass
class ChannelConfig:
    """Configuration of a single oscilloscope channel."""

    channel: int
    displayed: bool
    coupling: str = ""
    probe_ratio: float = 1.0
    scale: float = 0.0  # V/div
    offset: float = 0.0


@dataclass
class ScopeConfig:
    """Full oscilloscope configuration snapshot."""

    timebase_scale: float = 0.0  # s/div
    timebase_offset: float = 0.0
    acquisition_type: str = ""
    trigger_source: str = ""
    trigger_level: float | None = None
    channels: list[ChannelConfig] = field(default_factory=list)


@dataclass
class WaveformData:
    """Converted waveform data (physical units)."""

    channel: int
    points: int
    x_increment: float
    x_origin: float
    y_increment: float
    y_origin: float
    y_reference: int
    time: list[float] = field(default_factory=list)
    voltage: list[float] = field(default_factory=list)


# ── Connection management ─────────────────────────────────────


def _is_scope(resource: str, rm: pyvisa.ResourceManager) -> bool:
    """Check if a VISA resource is an oscilloscope by querying *IDN?."""
    try:
        instr = rm.open_resource(resource)
        instr.timeout = 3000
        idn = instr.query("*IDN?").strip()
        instr.close()
        # Typical scope IDN: "UNI-T,UTD2152S-E,serial,firmware"
        # Or generic: any SCPI device with "DSO", "OSCILLOSCOPE", etc.
        keywords = ("DSO", "OSCILLOSCOPE", "MSO", "UTD", "UPO")
        return any(kw in idn.upper() for kw in keywords)
    except Exception:
        return False


def find_scope_address() -> str | None:
    """Auto-scan USB VISA resources and return the first oscilloscope address."""
    rm = pyvisa.ResourceManager()
    try:
        for res in rm.list_resources():
            if "USB" in res and "INSTR" in res:
                if _is_scope(res, rm):
                    return res
    finally:
        rm.close()
    return None


def connect(address: str | None = None) -> tuple[pyvisa.ResourceManager, Any, ScopeInfo]:
    """Connect to an oscilloscope. Returns (rm, instrument, info).

    If *address* is None, auto-scans USB resources.
    Raises ConnectionError if no scope is found.
    """
    if address is None:
        address = find_scope_address()
        if address is None:
            raise ConnectionError(
                "No oscilloscope found. Check USB connection and VISA drivers."
            )

    rm = pyvisa.ResourceManager()
    last_error = None

    # Retry connection up to 3 times
    for attempt in range(3):
        try:
            instr = rm.open_resource(address)
            instr.timeout = VISA_TIMEOUT_MS

            # Query IDN with retry
            try:
                idn = instr.query("*IDN?").strip()
                info = ScopeInfo.from_idn(idn)
                logger.info("Connected: %s %s (%s)", info.manufacturer, info.model, info.serial)
                return rm, instr, info
            except Exception as idn_error:
                last_error = idn_error
                logger.warning("IDN query failed (attempt %d/3): %s", attempt + 1, idn_error)
                # Close and reopen connection
                instr.close()
                import time
                time.sleep(0.5)
                continue

        except Exception as e:
            last_error = e
            logger.warning("Connection attempt %d/3 failed: %s", attempt + 1, e)
            import time
            time.sleep(0.5)
            continue

    rm.close()
    raise ConnectionError(f"Failed to connect to {address} after 3 attempts: {last_error}")


# ── Auto-reconnect wrapper ────────────────────────────────────


class ScopeSession:
    """Manages a persistent VISA session with auto-reconnect."""

    def __init__(self) -> None:
        self._rm: pyvisa.ResourceManager | None = None
        self._instr: Any | None = None
        self._info: ScopeInfo | None = None
        self._address: str | None = None

    @property
    def connected(self) -> bool:
        return self._instr is not None

    @property
    def info(self) -> ScopeInfo | None:
        return self._info

    def ensure_connected(self, address: str | None = None) -> ScopeInfo:
        """Ensure we have a live connection. Returns ScopeInfo."""
        if self._instr is not None:
            try:
                idn = self._instr.query("*IDN?").strip()
                self._info = ScopeInfo.from_idn(idn)
                return self._info
            except Exception:
                logger.warning("Connection lost, reconnecting...")
                self.disconnect()

        addr = address or self._address
        self._rm, self._instr, self._info = connect(addr)
        self._address = address
        return self._info

    def disconnect(self) -> None:
        if self._instr is not None:
            try:
                self._instr.close()
            except Exception:
                pass
        if self._rm is not None:
            try:
                self._rm.close()
            except Exception:
                pass
        self._rm = None
        self._instr = None
        self._info = None

    @property
    def instr(self) -> Any:
        if self._instr is None:
            raise ConnectionError("Not connected. Call ensure_connected() first.")
        return self._instr


# Module-level singleton
_session = ScopeSession()


# ── Tool implementations ──────────────────────────────────────


def scope_connect_impl(address: str | None = None) -> str:
    """Connect to oscilloscope and return status."""
    try:
        info = _session.ensure_connected(address)
        return json.dumps({
            "success": True,
            "connected": True,
            "address": address or "auto-detected",
            "manufacturer": info.manufacturer,
            "model": info.model,
            "serial": info.serial,
            "firmware": info.firmware,
        }, indent=2, ensure_ascii=False)
    except ConnectionError as e:
        return json.dumps({
            "success": False,
            "connected": False,
            "error": str(e),
        }, indent=2, ensure_ascii=False)


def scope_list_channels_impl() -> str:
    """List all channels and their on/off status."""
    try:
        _session.ensure_connected()
    except ConnectionError as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    instr = _session.instr
    channels = []

    for ch in range(1, 5):  # Up to 4 channels
        try:
            displayed = instr.query(f":CHAN{ch}:DISP?").strip()
            if displayed == "1":
                coupling = instr.query(f":CHAN{ch}:COUP?").strip()
                probe = float(instr.query(f":CHAN{ch}:PROB?").strip())
                scale = float(instr.query(f":CHAN{ch}:SCAL?").strip())
                offset = float(instr.query(f":CHAN{ch}:OFFS?").strip())
                channels.append({
                    "channel": ch,
                    "displayed": True,
                    "coupling": coupling,
                    "probe_ratio": probe,
                    "scale_v_div": scale,
                    "offset_v": offset,
                })
            else:
                channels.append({
                    "channel": ch,
                    "displayed": False,
                })
        except Exception:
            # Channel doesn't exist or query failed — skip
            pass

    return json.dumps({
        "success": True,
        "channels": channels,
    }, indent=2, ensure_ascii=False)


def scope_get_config_impl() -> str:
    """Query current oscilloscope configuration."""
    try:
        _session.ensure_connected()
    except ConnectionError as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    instr = _session.instr

    def _query(cmd: str, default: Any = None) -> Any:
        try:
            return instr.query(cmd).strip()
        except Exception:
            return default

    config: dict[str, Any] = {
        "success": True,
        "timebase": {
            "scale_s_div": float(_query(":TIM:SCAL?", 0)),
            "offset_s": float(_query(":TIM:OFFS?", 0)),
        },
        "acquisition": {
            "type": _query(":ACQ:TYPE?", "unknown"),
        },
    }

    # Trigger — these may timeout on some models
    trig_source = _query(":TRIG:EDGE:SOUR?")
    if trig_source is not None:
        config["trigger"] = {
            "source": trig_source,
            "level": _query(":TRIG:EDGE:LEV?"),
        }

    # Channel summary
    channels = []
    for ch in range(1, 5):
        try:
            disp = _query(f":CHAN{ch}:DISP?", "0")
            if disp == "1":
                channels.append({
                    "channel": ch,
                    "scale_v_div": float(_query(f":CHAN{ch}:SCAL?", 0)),
                    "coupling": _query(f":CHAN{ch}:COUP?", "?"),
                })
        except Exception:
            pass
    config["active_channels"] = channels

    return json.dumps(config, indent=2, ensure_ascii=False)


def scope_get_waveform_impl(channel: int = 1) -> str:
    """Read waveform data from the specified channel.

    Returns voltage and time arrays in physical units.
    """
    try:
        _session.ensure_connected()
    except ConnectionError as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    instr = _session.instr
    instr.timeout = WAVEFORM_TIMEOUT_MS

    try:
        # Configure waveform transfer
        instr.write(":STOP")
        instr.write(f":WAV:SOUR CHAN{channel}")
        instr.write(":WAV:FORM WORD")
        instr.write(":WAV:POIN:MODE RAW")
        instr.write(":WAV:POIN 800")

        # Read preamble for scaling (10-field IEEE 488.2 XY format)
        # FORMAT,TYPE,POINTS,COUNT,XINC,XORIG,XREF,YINC,YORIG,YREF
        preamble = instr.query(":WAV:PRE?").strip()
        parts = preamble.split(",")
        x_increment = float(parts[4])
        x_origin = float(parts[5])
        y_increment = float(parts[7])
        y_origin = float(parts[8])
        y_reference = int(float(parts[9]))
        points = int(parts[2])

        # Read binary data (16-bit signed integers)
        raw_values = instr.query_binary_values(
            ":WAV:DATA?", datatype="h", is_big_endian=False
        )

        # Convert to physical units
        time_array = [x_origin + i * x_increment for i in range(len(raw_values))]
        voltage_array = [
            (val - y_reference) * y_increment + y_origin for val in raw_values
        ]

        # Resume acquisition
        instr.write(":RUN")

        return json.dumps({
            "success": True,
            "channel": channel,
            "points": len(raw_values),
            "x_increment": x_increment,
            "x_origin": x_origin,
            "y_increment": y_increment,
            "y_origin": y_origin,
            "y_reference": y_reference,
            "time": time_array,
            "voltage": voltage_array,
        }, indent=2, ensure_ascii=False)

    except Exception as e:
        # Ensure we resume even on error
        try:
            instr.write(":RUN")
        except Exception:
            pass
        return json.dumps({
            "success": False,
            "error": f"Waveform read failed: {e}",
        }, indent=2, ensure_ascii=False)


def scope_get_measurement_impl(channel: int = 1) -> str:
    """Read auto-measurement results for the specified channel."""
    try:
        _session.ensure_connected()
    except ConnectionError as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    instr = _session.instr

    try:
        instr.write(f":MEAS:SOUR CHAN{channel}")

        measurements: dict[str, Any] = {
            "success": True,
            "channel": channel,
        }

        for scpi_suffix, key in MEASUREMENT_TYPES:
            try:
                val = instr.query(f":MEAS:{scpi_suffix}?").strip()
                # "*" or "ERR" means invalid/no signal
                if val in ("*", "ERR", "---", "NaN"):
                    measurements[key] = None
                else:
                    measurements[key] = float(val)
            except Exception:
                measurements[key] = None

        # Calculate duty cycle from RMS formula (rectangular wave):
        # Vrms² = D * Vmax² + (1-D) * Vmin²  →  D = (Vrms²-Vmin²)/(Vmax²-Vmin²)
        # Only valid when signal is stable (frequency detected) and waveform
        # approximates a rectangular shape.
        v_max = measurements.get("v_max")
        v_min = measurements.get("v_min")
        v_rms = measurements.get("v_rms")
        freq = measurements.get("frequency")
        period = measurements.get("period")
        signal_stable = freq is not None or period is not None
        if v_max is not None and v_min is not None and v_rms is not None and signal_stable:
            denom = v_max**2 - v_min**2
            if denom > 0:
                duty = (v_rms**2 - v_min**2) / denom * 100
                measurements["duty_cycle"] = round(duty, 1) if 0 <= duty <= 100 else None
            else:
                measurements["duty_cycle"] = None
        else:
            measurements["duty_cycle"] = None

        return json.dumps(measurements, indent=2, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": f"Measurement read failed: {e}",
        }, indent=2, ensure_ascii=False)


# ── Waveform analysis ─────────────────────────────────────────


def scope_set_timebase_impl(
    scale_s_div: float | None = None,
    offset_s: float | None = None,
    auto: bool = False,
    channel: int = 1,
    cycles: int = 3,
) -> str:
    """Adjust oscilloscope timebase.

    Modes:
      - Manual: set scale_s_div and/or offset_s directly.
      - Auto: automatically adjust timebase to show *cycles* complete
        waveforms on screen for the given channel.

    Args:
        scale_s_div: Time per division in seconds (e.g. 1e-3 = 1ms/div).
        offset_s: Trigger offset in seconds.
        auto: If True, auto-adjust timebase from signal frequency.
        channel: Channel to read frequency from (used with auto=True).
        cycles: Number of complete cycles to show on screen (default 3).
    """
    try:
        _session.ensure_connected()
    except ConnectionError as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    instr = _session.instr

    def _q(cmd: str) -> str | None:
        try:
            val = instr.query(cmd).strip()
            if val in ("*", "ERR", "---", "NaN", ""):
                return None
            return val
        except Exception:
            return None

    try:
        if auto:
            # ── Auto mode: measure frequency, compute ideal timebase ──
            instr.write(":RUN")
            import time
            time.sleep(0.5)

            # Stabilize trigger first
            rough_vmax = _q(":MEAS:VMAX?")
            rough_vmin = _q(":MEAS:VMIN?")
            if rough_vmax and rough_vmin:
                vmax_est = float(rough_vmax)
                vmin_est = float(rough_vmin)
                if vmax_est - vmin_est > 0.1:
                    trig_level = (vmax_est + vmin_est) / 2
                    instr.write(":TRIG:MODE EDGE")
                    instr.write(f":TRIG:EDGE:SOUR CHAN{channel}")
                    instr.write(":TRIG:EDGE:SLOP POS")
                    instr.write(f":TRIG:EDGE:LEV {trig_level:.3f}")
                    instr.write(":SING")
                    time.sleep(1.5)
                    instr.write(":RUN")
                    time.sleep(0.5)

            instr.write(f":MEAS:SOUR CHAN{channel}")
            scpi_freq = _q(":MEAS:FREQ?")
            if scpi_freq is None:
                return json.dumps({
                    "success": False,
                    "error": "Cannot measure frequency. Check signal on channel.",
                }, indent=2, ensure_ascii=False)

            freq = float(scpi_freq)
            if freq <= 0:
                return json.dumps({
                    "success": False,
                    "error": "Invalid frequency measurement.",
                }, indent=2, ensure_ascii=False)

            # UTD2000 has 14 divisions horizontally
            DIVISIONS = 14
            period = 1.0 / freq
            target_window = period * cycles
            ideal_scale = target_window / DIVISIONS

            # Snap to nearest standard timebase value
            STANDARD_SCALES = [
                1e-9, 2e-9, 5e-9,
                1e-8, 2e-8, 5e-8,
                1e-7, 2e-7, 5e-7,
                1e-6, 2e-6, 5e-6,
                1e-5, 2e-5, 5e-5,
                1e-4, 2e-4, 5e-4,
                1e-3, 2e-3, 5e-3,
                1e-2, 2e-2, 5e-2,
                1e-1, 2e-1, 5e-1,
                1.0, 2.0, 5.0,
                10.0, 20.0, 50.0,
            ]
            # Find closest standard value (round down to show ≥ cycles)
            chosen = STANDARD_SCALES[-1]
            for s in STANDARD_SCALES:
                if s >= ideal_scale * 0.95:  # 5% tolerance
                    chosen = s
                    break

            instr.write(f":TIM:SCAL {chosen}")

            # Center the trigger on screen
            instr.write(":TIM:OFFS 0")

            new_scale = float(_q(":TIM:SCAL?") or chosen)
            window_ms = new_scale * DIVISIONS * 1e3

            return json.dumps({
                "success": True,
                "mode": "auto",
                "frequency_hz": round(freq, 2),
                "cycles_on_screen": cycles,
                "scale_s_div": new_scale,
                "scale_display": _format_timebase(new_scale),
                "time_window_ms": round(window_ms, 2),
                "offset_s": 0,
            }, indent=2, ensure_ascii=False)

        else:
            # ── Manual mode ──
            changed = []
            if scale_s_div is not None:
                if scale_s_div <= 0:
                    return json.dumps({
                        "success": False,
                        "error": "scale_s_div must be positive.",
                    }, indent=2, ensure_ascii=False)
                instr.write(f":TIM:SCAL {scale_s_div}")
                changed.append("scale")

            if offset_s is not None:
                instr.write(f":TIM:OFFS {offset_s}")
                changed.append("offset")

            if not changed:
                # No parameters given — return current timebase
                cur_scale = float(_q(":TIM:SCAL?") or 0)
                cur_offset = float(_q(":TIM:OFFS?") or 0)
                return json.dumps({
                    "success": True,
                    "mode": "query",
                    "scale_s_div": cur_scale,
                    "scale_display": _format_timebase(cur_scale),
                    "offset_s": cur_offset,
                    "time_window_ms": round(cur_scale * 14 * 1e3, 2),
                }, indent=2, ensure_ascii=False)

            # Read back actual values
            new_scale = float(_q(":TIM:SCAL?") or scale_s_div)
            new_offset = float(_q(":TIM:OFFS?") or (offset_s or 0))

            return json.dumps({
                "success": True,
                "mode": "manual",
                "changed": changed,
                "scale_s_div": new_scale,
                "scale_display": _format_timebase(new_scale),
                "offset_s": new_offset,
                "time_window_ms": round(new_scale * 14 * 1e3, 2),
            }, indent=2, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": f"Timebase adjustment failed: {e}",
        }, indent=2, ensure_ascii=False)


def _format_timebase(s_per_div: float) -> str:
    """Format timebase value as human-readable string (e.g. '1.00 ms/div')."""
    if s_per_div >= 1.0:
        return f"{s_per_div:.2f} s/div"
    elif s_per_div >= 1e-3:
        return f"{s_per_div * 1e3:.2f} ms/div"
    elif s_per_div >= 1e-6:
        return f"{s_per_div * 1e6:.2f} us/div"
    elif s_per_div >= 1e-9:
        return f"{s_per_div * 1e9:.2f} ns/div"
    else:
        return f"{s_per_div:.2e} s/div"


def scope_set_voltage_scale_impl(
    channel: int = 1,
    scale_v_div: float | None = None,
    offset_v: float | None = None,
    auto: bool = False,
) -> str:
    """Adjust oscilloscope vertical scale (Volts/div) for a channel.

    Modes:
      - Manual: set scale_v_div and/or offset_v directly.
      - Auto: automatically adjust scale to fit the signal amplitude on screen.

    Args:
        channel: Channel number (1-4).
        scale_v_div: Volts per division (e.g. 1.0 = 1V/div).
        offset_v: Vertical offset in volts.
        auto: If True, auto-adjust scale to fit signal amplitude.
    """
    try:
        _session.ensure_connected()
    except ConnectionError as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    instr = _session.instr

    def _q(cmd: str) -> str | None:
        try:
            val = instr.query(cmd).strip()
            if val in ("*", "ERR", "---", "NaN", ""):
                return None
            return val
        except Exception:
            return None

    try:
        # Verify channel exists and is active
        disp = _q(f":CHAN{channel}:DISP?")
        if disp != "1":
            return json.dumps({
                "success": False,
                "error": f"Channel {channel} is not displayed. Enable it first.",
            }, indent=2, ensure_ascii=False)

        if auto:
            # ── Auto mode: measure amplitude, compute ideal scale ──
            instr.write(":RUN")
            import time
            time.sleep(0.5)

            instr.write(f":MEAS:SOUR CHAN{channel}")
            scpi_vmax = _q(":MEAS:VMAX?")
            scpi_vmin = _q(":MEAS:VMIN?")

            if scpi_vmax is None or scpi_vmin is None:
                return json.dumps({
                    "success": False,
                    "error": "Cannot measure signal amplitude. Check signal on channel.",
                }, indent=2, ensure_ascii=False)

            v_max = float(scpi_vmax)
            v_min = float(scpi_vmin)
            amplitude = v_max - v_min

            if amplitude < 1e-6:
                return json.dumps({
                    "success": False,
                    "error": "Signal amplitude too small to measure.",
                }, indent=2, ensure_ascii=False)

            # UTD2000 has 8 divisions vertically
            # Target: signal occupies ~6 divisions (75% of screen)
            DIVISIONS = 8
            target_divisions = DIVISIONS * 0.75
            ideal_scale = amplitude / target_divisions

            # Snap to nearest standard V/div value (1-2-5 sequence)
            STANDARD_SCALES = [
                1e-3, 2e-3, 5e-3,      # 1mV, 2mV, 5mV
                1e-2, 2e-2, 5e-2,      # 10mV, 20mV, 50mV
                1e-1, 2e-1, 5e-1,      # 100mV, 200mV, 500mV
                1.0, 2.0, 5.0,         # 1V, 2V, 5V
                10.0, 20.0, 50.0,      # 10V, 20V, 50V
            ]
            # Find closest standard value (round up to fit signal)
            chosen = STANDARD_SCALES[-1]
            for s in STANDARD_SCALES:
                if s >= ideal_scale * 0.95:  # 5% tolerance
                    chosen = s
                    break

            instr.write(f":CHAN{channel}:SCAL {chosen}")

            # Center the waveform vertically
            v_center = (v_max + v_min) / 2
            instr.write(f":CHAN{channel}:OFFS {-v_center}")  # Offset is inverted

            new_scale = float(_q(f":CHAN{channel}:SCAL?") or chosen)
            new_offset = float(_q(f":CHAN{channel}:OFFS?") or 0)
            screen_range = new_scale * DIVISIONS

            return json.dumps({
                "success": True,
                "mode": "auto",
                "channel": channel,
                "signal_v_max": round(v_max, 3),
                "signal_v_min": round(v_min, 3),
                "signal_amplitude": round(amplitude, 3),
                "scale_v_div": new_scale,
                "scale_display": _format_voltage_scale(new_scale),
                "offset_v": round(new_offset, 3),
                "screen_range_v": round(screen_range, 2),
            }, indent=2, ensure_ascii=False)

        else:
            # ── Manual mode ──
            changed = []
            if scale_v_div is not None:
                if scale_v_div <= 0:
                    return json.dumps({
                        "success": False,
                        "error": "scale_v_div must be positive.",
                    }, indent=2, ensure_ascii=False)
                instr.write(f":CHAN{channel}:SCAL {scale_v_div}")
                changed.append("scale")

            if offset_v is not None:
                instr.write(f":CHAN{channel}:OFFS {offset_v}")
                changed.append("offset")

            if not changed:
                # No parameters given — return current settings
                cur_scale = float(_q(f":CHAN{channel}:SCAL?") or 0)
                cur_offset = float(_q(f":CHAN{channel}:OFFS?") or 0)
                cur_coupling = _q(f":CHAN{channel}:COUP?") or "?"
                cur_probe = float(_q(f":CHAN{channel}:PROB?") or 1)
                return json.dumps({
                    "success": True,
                    "mode": "query",
                    "channel": channel,
                    "scale_v_div": cur_scale,
                    "scale_display": _format_voltage_scale(cur_scale),
                    "offset_v": cur_offset,
                    "coupling": cur_coupling,
                    "probe_ratio": cur_probe,
                    "screen_range_v": round(cur_scale * 8, 2),
                }, indent=2, ensure_ascii=False)

            # Read back actual values
            new_scale = float(_q(f":CHAN{channel}:SCAL?") or scale_v_div)
            new_offset = float(_q(f":CHAN{channel}:OFFS?") or (offset_v or 0))

            return json.dumps({
                "success": True,
                "mode": "manual",
                "channel": channel,
                "changed": changed,
                "scale_v_div": new_scale,
                "scale_display": _format_voltage_scale(new_scale),
                "offset_v": new_offset,
                "screen_range_v": round(new_scale * 8, 2),
            }, indent=2, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": f"Voltage scale adjustment failed: {e}",
        }, indent=2, ensure_ascii=False)


def _format_voltage_scale(v_per_div: float) -> str:
    """Format voltage scale value as human-readable string (e.g. '1.00 V/div')."""
    if v_per_div >= 1.0:
        return f"{v_per_div:.2f} V/div"
    elif v_per_div >= 1e-3:
        return f"{v_per_div * 1e3:.2f} mV/div"
    else:
        return f"{v_per_div * 1e6:.2f} uV/div"


def scope_analyze_waveform_impl(channel: int = 1, pole_pairs: int = 2) -> str:
    """Analyze waveform: signal characterization + quality assessment.

    Reads the waveform, then computes frequency, duty cycle, amplitude,
    signal type, rise/fall time, overshoot, glitches, and stability.
    """
    try:
        _session.ensure_connected()
    except ConnectionError as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    instr = _session.instr
    instr.timeout = WAVEFORM_TIMEOUT_MS

    def _q(cmd: str) -> str | None:
        """Query SCPI, return stripped string or None on failure."""
        try:
            val = instr.query(cmd).strip()
            if val in ("*", "ERR", "---", "NaN", ""):
                return None
            return val
        except Exception:
            return None

    try:
        # ── Step 0: Ensure running and stabilize trigger ──
        instr.write(":RUN")
        import time
        time.sleep(0.5)

        # Quick read to estimate signal range for trigger level
        rough_vmax = _q(":MEAS:VMAX?")
        rough_vmin = _q(":MEAS:VMIN?")
        if rough_vmax and rough_vmin:
            vmax_est = float(rough_vmax)
            vmin_est = float(rough_vmin)
            if vmax_est - vmin_est > 0.1:
                trig_level = (vmax_est + vmin_est) / 2
                instr.write(":TRIG:MODE EDGE")
                instr.write(f":TRIG:EDGE:SOUR CHAN{channel}")
                instr.write(":TRIG:EDGE:SLOP POS")
                instr.write(f":TRIG:EDGE:LEV {trig_level:.3f}")
                # Single trigger to capture one stable frame
                instr.write(":SING")
                time.sleep(1.5)
                instr.write(":RUN")
                time.sleep(0.5)

        # ── Step 1: SCPI measurements (uses scope's internal high-speed ADC) ──
        instr.write(f":MEAS:SOUR CHAN{channel}")

        scpi_freq = _q(":MEAS:FREQ?")
        scpi_period = _q(":MEAS:PER?")
        scpi_vmax = _q(":MEAS:VMAX?")
        scpi_vmin = _q(":MEAS:VMIN?")
        scpi_vrms = _q(":MEAS:VRMS?")
        scpi_vamp = _q(":MEAS:VAMP?")
        scpi_pduty = _q(":MEAS:PDUTY?")
        scpi_ris = _q(":MEAS:RIS?")
        scpi_fall = _q(":MEAS:FALL?")

        frequency = float(scpi_freq) if scpi_freq else None
        period_s = float(scpi_period) if scpi_period else None
        v_max = float(scpi_vmax) if scpi_vmax else None
        v_min = float(scpi_vmin) if scpi_vmin else None
        v_rms = float(scpi_vrms) if scpi_vrms else None
        amplitude = float(scpi_vamp) if scpi_vamp else None

        # Duty cycle: prefer direct measurement, fall back to RMS formula
        duty_cycle = None
        if scpi_pduty:
            duty_cycle = round(float(scpi_pduty), 1)
        elif frequency is not None and v_max is not None and v_min is not None and v_rms is not None:
            denom = v_max**2 - v_min**2
            if denom > 0:
                d = (v_rms**2 - v_min**2) / denom * 100
                duty_cycle = round(d, 1) if 0 <= d <= 100 else None

        # ── Step 3: Waveform readout for signal type + commutation detection ──
        instr.write(":STOP")
        instr.write(f":WAV:SOUR CHAN{channel}")
        instr.write(":WAV:FORM WORD")
        instr.write(":WAV:POIN:MODE RAW")
        instr.write(":WAV:POIN 800")

        preamble = instr.query(":WAV:PRE?").strip()
        parts = preamble.split(",")
        dt = float(parts[4])
        y_inc = float(parts[7])
        y_orig = float(parts[8])
        y_ref = int(float(parts[9]))

        raw = instr.query_binary_values(":WAV:DATA?", datatype="h", is_big_endian=False)
        instr.write(":RUN")

        voltage = [(v - y_ref) * y_inc + y_orig for v in raw]

    except Exception as e:
        try:
            instr.write(":RUN")
        except Exception:
            pass
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)

    n = len(voltage)
    time_window_ms = n * dt * 1e3

    # ── Commutation detection (for BLDC/motor signals) ──
    commutation = None
    if voltage and v_max is not None and v_min is not None:
        vmid = (v_max + v_min) / 2
        low_segments = []
        in_low = False
        low_start = 0
        for i, v in enumerate(voltage):
            if v <= vmid:
                if not in_low:
                    in_low = True
                    low_start = i
            else:
                if in_low:
                    seg_len = (i - low_start) * dt
                    low_segments.append(seg_len)
                    in_low = False
        if in_low:
            low_segments.append((n - low_start) * dt)

        if low_segments:
            avg_low = sum(low_segments) / len(low_segments)
            longest_low = max(low_segments)
            # If longest low segment is >10x the average → commutation gap
            if longest_low > avg_low * 10 and longest_low > 0.001:
                # In 6-step BLDC: phase off for 240°, on for 120°
                # Full electrical cycle = gap × 360/240 = gap × 1.5
                elec_period = longest_low * 1.5
                elec_freq = 1.0 / elec_period if elec_period > 0 else None
                rpm = elec_freq * 60 / pole_pairs if elec_freq else None
                commutation = {
                    "detected": True,
                    "gap_duration_ms": round(longest_low * 1e3, 2),
                    "electrical_period_ms": round(elec_period * 1e3, 2),
                    "electrical_freq_hz": round(elec_freq, 2) if elec_freq else None,
                    "estimated_rpm": round(rpm) if rpm else None,
                    "pole_pairs": pole_pairs,
                }

    # ── Build result ──
    result: dict[str, Any] = {
        "success": True,
        "frequency_hz": round(frequency, 2) if frequency else None,
        "period_us": round(period_s * 1e6, 2) if period_s else None,
        "duty_cycle_percent": duty_cycle,
        "amplitude_v": round(amplitude, 3) if amplitude else None,
        "v_max": round(v_max, 3) if v_max is not None else None,
        "v_min": round(v_min, 3) if v_min is not None else None,
        "v_rms": round(v_rms, 3) if v_rms is not None else None,
        "rise_time_ns": round(float(scpi_ris) * 1e9) if scpi_ris else None,
        "fall_time_ns": round(float(scpi_fall) * 1e9) if scpi_fall else None,
        "samples": n,
        "time_window_ms": round(time_window_ms, 2),
    }

    if commutation:
        result["commutation"] = commutation

    return json.dumps(result, indent=2, ensure_ascii=False)
