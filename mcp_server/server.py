"""LingChain MCP Server - STM32 CMake build chain tools.

This MCP server provides tools for LLM-controlled STM32 development:
- init:      Scan project (.ioc) and configure toolchain
- configure: Run cmake --preset
- build:     Compile the project
- flash:     Flash firmware via OpenOCD
- debug:     Start debugging session
- analyze:   Analyze firmware size/symbols
"""

import json
import re
import subprocess
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from mcp_server.keil import (
    keil_build_impl,
    keil_clean_impl,
    keil_flash_impl,
    keil_rebuild_impl,
)
from mcp_server.scope import (
    scope_analyze_waveform_impl,
    scope_connect_impl,
    scope_get_config_impl,
    scope_get_measurement_impl,
    scope_get_waveform_impl,
    scope_list_channels_impl,
    scope_set_timebase_impl,
    scope_set_voltage_scale_impl,
)
from mcp_server.utils.ioc_parser import parse_ioc, get_chip_series, get_chip_target
from mcp_server.utils.project_scanner import scan_project

mcp = FastMCP("LingChain")


@mcp.tool()
def init(project_dir: str) -> str:
    """Initialize STM32 CMake project by scanning .ioc file and checking toolchain.

    Scans the project directory for STM32CubeMX configuration (.ioc file),
    extracts chip model and HAL library info, and checks toolchain availability.

    Args:
        project_dir: Path to STM32CubeMX generated project directory

    Returns:
        JSON string with project summary: chip info, toolchain status, project structure
    """
    project_path = Path(project_dir).resolve()

    # Scan project structure and toolchain
    scan_result = scan_project(project_path)

    # Parse .ioc if available
    ioc_info = None
    if scan_result.ioc_file:
        try:
            ioc_config = parse_ioc(scan_result.ioc_file)
            ioc_info = {
                "mcu_name": ioc_config.mcu_name,
                "mcu_family": ioc_config.mcu_family,
                "mcu_package": ioc_config.mcu_package,
                "chip_series": get_chip_series(ioc_config.mcu_name),
                "chip_target": get_chip_target(ioc_config.mcu_name),
                "hal_version": ioc_config.hal_version,
                "project_name": ioc_config.project_name,
                "toolchain": ioc_config.toolchain,
                "c_standard": ioc_config.c_standard,
                "heap_size": ioc_config.heap_size,
                "stack_size": ioc_config.stack_size,
                "defines": ioc_config.defines,
            }
        except (FileNotFoundError, ValueError) as e:
            scan_result.errors.append(f"Failed to parse .ioc: {e}")

    # Build toolchain status
    toolchain_status = {
        ts.name: {
            "available": ts.available,
            "version": ts.version,
            "path": ts.path,
            "error": ts.error,
        }
        for ts in scan_result.toolchain_status
    }

    # Build response
    response = {
        "project_dir": str(project_path),
        "valid": scan_result.is_valid,
        "ioc": ioc_info,
        "toolchain": toolchain_status,
        "structure": {
            "cmake_lists": str(scan_result.cmake_lists) if scan_result.cmake_lists and scan_result.cmake_lists.exists() else None,
            "cmake_presets": str(scan_result.cmake_presets) if scan_result.cmake_presets and scan_result.cmake_presets.exists() else None,
            "toolchain_file": str(scan_result.toolchain_file) if scan_result.toolchain_file else None,
            "linker_script": str(scan_result.linker_script) if scan_result.linker_script else None,
            "startup_file": str(scan_result.startup_file) if scan_result.startup_file else None,
        },
        "errors": scan_result.errors,
    }

    return json.dumps(response, indent=2, ensure_ascii=False)


@mcp.tool()
def configure(project_dir: str, preset: str = "Debug") -> str:
    """Configure CMake build system for STM32 project.

    Runs cmake --preset to generate the build directory and cache.
    Validates that CMakePresets.json exists and the preset is valid.

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)

    Returns:
        JSON string with build directory path and configuration result
    """
    project_path = Path(project_dir).resolve()
    presets_file = project_path / "CMakePresets.json"

    if not presets_file.exists():
        return json.dumps({
            "success": False,
            "error": f"CMakePresets.json not found in {project_dir}",
        }, indent=2, ensure_ascii=False)

    try:
        result = subprocess.run(
            ["cmake", "--preset", preset],
            cwd=project_path,
            capture_output=True,
            text=True,
            timeout=120,
        )

        # Determine build directory from preset
        build_dir = project_path / "build" / preset

        response = {
            "success": result.returncode == 0,
            "preset": preset,
            "build_dir": str(build_dir),
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }

        if result.returncode != 0:
            response["error"] = result.stderr.strip() or "CMake configuration failed"

        return json.dumps(response, indent=2, ensure_ascii=False)

    except subprocess.TimeoutExpired:
        return json.dumps({
            "success": False,
            "error": "CMake configuration timed out (120s)",
        }, indent=2, ensure_ascii=False)
    except FileNotFoundError:
        return json.dumps({
            "success": False,
            "error": "cmake not found in PATH. Please install CMake.",
        }, indent=2, ensure_ascii=False)


@mcp.tool()
def build(project_dir: str, preset: str = "Debug") -> str:
    """Build STM32 project using CMake.

    Runs cmake --build --preset to compile the project.
    Parses compiler output to extract errors and warnings with file locations.

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)

    Returns:
        JSON string with build result: success, errors, warnings, output paths
    """
    project_path = Path(project_dir).resolve()
    build_dir = project_path / "build" / preset

    if not build_dir.exists():
        return json.dumps({
            "success": False,
            "error": f"Build directory not found: {build_dir}. Run configure first.",
        }, indent=2, ensure_ascii=False)

    try:
        result = subprocess.run(
            ["cmake", "--build", "--preset", preset],
            cwd=project_path,
            capture_output=True,
            text=True,
            timeout=300,
        )

        # Parse errors and warnings from compiler output
        errors = []
        warnings = []
        # GCC error/warning patterns: file:line:col: severity: message
        error_pattern = re.compile(r"^(.+?):(\d+):(\d+):\s*error:\s*(.+)$", re.MULTILINE)
        warning_pattern = re.compile(r"^(.+?):(\d+):(\d+):\s*warning:\s*(.+)$", re.MULTILINE)

        combined = result.stdout + result.stderr
        for match in error_pattern.finditer(combined):
            errors.append({
                "file": match.group(1),
                "line": int(match.group(2)),
                "column": int(match.group(3)),
                "message": match.group(4),
            })

        for match in warning_pattern.finditer(combined):
            warnings.append({
                "file": match.group(1),
                "line": int(match.group(2)),
                "column": int(match.group(3)),
                "message": match.group(4),
            })

        # Find output files
        elf_files = list(build_dir.rglob("*.elf"))
        hex_files = list(build_dir.rglob("*.hex"))
        bin_files = list(build_dir.rglob("*.bin"))

        response = {
            "success": result.returncode == 0,
            "preset": preset,
            "build_dir": str(build_dir),
            "errors": errors,
            "warnings": warnings,
            "error_count": len(errors),
            "warning_count": len(warnings),
            "outputs": {
                "elf": str(elf_files[0]) if elf_files else None,
                "hex": str(hex_files[0]) if hex_files else None,
                "bin": str(bin_files[0]) if bin_files else None,
            },
            "stdout": result.stdout.strip()[-2000:] if result.stdout else "",
        }

        if result.returncode != 0:
            response["error"] = f"Build failed with {len(errors)} error(s) and {len(warnings)} warning(s)"

        return json.dumps(response, indent=2, ensure_ascii=False)

    except subprocess.TimeoutExpired:
        return json.dumps({
            "success": False,
            "error": "Build timed out (300s)",
        }, indent=2, ensure_ascii=False)
    except FileNotFoundError:
        return json.dumps({
            "success": False,
            "error": "cmake not found in PATH. Please install CMake.",
        }, indent=2, ensure_ascii=False)


@mcp.tool()
def flash(
    project_dir: str,
    preset: str = "Debug",
    interface: str = "stlink",
) -> str:
    """Flash firmware to STM32 target via OpenOCD.

    Builds OpenOCD command from chip series and probe interface.
    Programs the .elf file and validates write.

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)
        interface: Debug probe interface (stlink/jlink/cmsis-dap)

    Returns:
        JSON string with flash result
    """
    project_path = Path(project_dir).resolve()
    build_dir = project_path / "build" / preset

    # Find ELF / HEX file
    elf_files = list(build_dir.rglob("*.elf"))
    if not elf_files:
        hex_files = list(build_dir.rglob("*.hex"))
        bin_files = list(build_dir.rglob("*.bin"))
        target_file = None
        if hex_files:
            target_file = hex_files[0]
        elif bin_files:
            target_file = bin_files[0]
        if not target_file:
            return json.dumps({
                "success": False,
                "error": "No firmware file (.elf/.hex/.bin) found. Run build first.",
            }, indent=2, ensure_ascii=False)
    else:
        target_file = elf_files[0]

    # Determine chip target from .ioc
    ioc_files = list(project_path.glob("*.ioc"))
    chip_target = "stm32g0x"  # default fallback
    if ioc_files:
        try:
            ioc_config = parse_ioc(ioc_files[0])
            chip_target = get_chip_target(ioc_config.mcu_name)
        except (FileNotFoundError, ValueError):
            pass

    # Determine interface config
    interface_map = {
        "stlink": "interface/stlink-v2-1.cfg",
        "stlink-v3": "interface/stlink-v3.cfg",
        "jlink": "interface/jlink.cfg",
        "cmsis-dap": "interface/cmsis-dap.cfg",
    }
    interface_cfg = interface_map.get(interface, "interface/stlink-v2-1.cfg")

    # Build OpenOCD command
    target_ext = target_file.suffix.lower()
    program_args = {
        ".elf": str(target_file),
        ".hex": str(target_file),
        ".bin": f"{target_file} 0x08000000",
    }
    program_arg = program_args.get(target_ext, str(target_file))

    openocd_cmd = [
        "openocd",
        "-f", interface_cfg,
        "-f", f"target/{chip_target}.cfg",
        "-c", f"program {program_arg} verify reset exit",
    ]

    try:
        result = subprocess.run(
            openocd_cmd,
            capture_output=True,
            text=True,
            timeout=60,
        )

        stdout = result.stdout.strip()
        stderr = result.stderr.strip()

        response = {
            "success": result.returncode == 0,
            "interface": interface,
            "chip_target": chip_target,
            "firmware": str(target_file),
            "stdout": stdout[-2000:] if stdout else "",
            "stderr": stderr[-2000:] if stderr else "",
        }

        if result.returncode != 0:
            # Determine specific error type
            if "Error: open failed" in stdout + stderr:
                response["error_type"] = "connection_failed"
                response["error"] = "Cannot connect to target. Check probe connection and power."
            elif "verify failed" in stdout + stderr:
                response["error_type"] = "verify_failed"
                response["error"] = "Verify failed after programming."
            elif "timeout" in stdout + stderr.lower():
                response["error_type"] = "timeout"
                response["error"] = "Communication timeout."
            else:
                response["error_type"] = "unknown"
                response["error"] = stderr[-500:] or stdout[-500:]

        return json.dumps(response, indent=2, ensure_ascii=False)

    except subprocess.TimeoutExpired:
        return json.dumps({
            "success": False,
            "error": "OpenOCD timed out (60s)",
        }, indent=2, ensure_ascii=False)
    except FileNotFoundError:
        return json.dumps({
            "success": False,
            "error": "openocd not found in PATH. Please install OpenOCD.",
        }, indent=2, ensure_ascii=False)


@mcp.tool()
def debug(
    project_dir: str,
    preset: str = "Debug",
    interface: str = "stlink",
) -> str:
    """Start debugging session for STM32 project.

    Launches OpenOCD in background and starts arm-none-eabi-gdb.
    Auto-loads the ELF file and sets up remote connection.

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)
        interface: Debug probe interface (stlink/jlink/cmsis-dap)

    Returns:
        JSON string with debug session details
    """
    project_path = Path(project_dir).resolve()
    build_dir = project_path / "build" / preset

    # Find ELF file
    elf_files = list(build_dir.rglob("*.elf"))
    if not elf_files:
        return json.dumps({
            "success": False,
            "error": f"No .elf file found in {build_dir}. Run build first.",
        }, indent=2, ensure_ascii=False)

    elf_path = elf_files[0]

    # Determine chip target from .ioc
    ioc_files = list(project_path.glob("*.ioc"))
    chip_target = "stm32g0x"
    if ioc_files:
        try:
            ioc_config = parse_ioc(ioc_files[0])
            chip_target = get_chip_target(ioc_config.mcu_name)
        except (FileNotFoundError, ValueError):
            pass

    # Interface config
    interface_map = {
        "stlink": "interface/stlink-v2-1.cfg",
        "stlink-v3": "interface/stlink-v3.cfg",
        "jlink": "interface/jlink.cfg",
        "cmsis-dap": "interface/cmsis-dap.cfg",
    }
    interface_cfg = interface_map.get(interface, "interface/stlink-v2-1.cfg")

    # Build OpenOCD command (runs in background on port 3333)
    openocd_cmd = [
        "openocd",
        "-f", interface_cfg,
        "-f", f"target/{chip_target}.cfg",
    ]

    # Try starting OpenOCD
    try:
        openocd_proc = subprocess.Popen(
            openocd_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )

        # Wait for OpenOCD to be ready (check port 3333)
        import time
        time.sleep(2)

        # Build GDB command sequence
        gdb_cmd = (
            f'arm-none-eabi-gdb '
            f'-ex "target extended-remote localhost:3333" '
            f'-ex "file {elf_path}" '
            f'-ex "monitor reset halt" '
            f'-ex "load" '
            f'-ex "monitor reset halt" '
            f'"{elf_path}"'
        )

        return json.dumps({
            "success": True,
            "session": {
                "openocd_pid": openocd_proc.pid,
                "interface": interface,
                "chip_target": chip_target,
                "elf": str(elf_path),
                "gdb_cmd": gdb_cmd,
            },
            "instructions": [
                f"OpenOCD started on PID {openocd_proc.pid}",
                f"Copy the gdb_cmd below to start GDB:",
                gdb_cmd,
            ],
        }, indent=2, ensure_ascii=False)

    except FileNotFoundError:
        return json.dumps({
            "success": False,
            "error": "openocd not found in PATH. Please install OpenOCD.",
        }, indent=2, ensure_ascii=False)


@mcp.tool()
def analyze(
    project_dir: str,
    preset: str = "Debug",
    type: str = "size",
) -> str:
    """Analyze STM32 firmware (size, symbols, memory map).

    Runs arm-none-eabi-size or arm-none-eabi-nm on the compiled ELF.
    Provides memory usage breakdown and symbol size analysis.

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)
        type: Analysis type (size/symbols/map)

    Returns:
        JSON string with analysis results
    """
    project_path = Path(project_dir).resolve()
    build_dir = project_path / "build" / preset

    # Find ELF file
    elf_files = list(build_dir.rglob("*.elf"))
    if not elf_files:
        return json.dumps({
            "success": False,
            "error": f"No .elf file found in {build_dir}. Run build first.",
        }, indent=2, ensure_ascii=False)

    elf_path = elf_files[0]

    try:
        if type == "size":
            # Run arm-none-eabi-size
            result = subprocess.run(
                ["arm-none-eabi-size", "-A", str(elf_path)],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                return json.dumps({
                    "success": False,
                    "error": result.stderr.strip() or "size analysis failed",
                }, indent=2, ensure_ascii=False)

            # Parse size output
            sections = []
            total_flash = 0
            total_ram = 0
            for line in result.stdout.strip().split("\n"):
                parts = line.split()
                if len(parts) >= 3 and parts[0] != "section":
                    section_name = parts[0]
                    size = int(parts[1])
                    if section_name in (".text", ".rodata", ".isr_vector"):
                        total_flash += size
                    elif section_name in (".data", ".bss", ".heap", ".stack"):
                        total_ram += size
                    sections.append({
                        "name": section_name,
                        "size": size,
                        "addr": int(parts[2]) if len(parts) > 2 else 0,
                    })

            return json.dumps({
                "success": True,
                "elf": str(elf_path),
                "sections": sections,
                "summary": {
                    "flash": total_flash,
                    "ram": total_ram,
                },
            }, indent=2, ensure_ascii=False)

        elif type == "symbols":
            # Run arm-none-eabi-nm for symbol sizes
            result = subprocess.run(
                ["arm-none-eabi-nm", "--size-sort", "--print-size", str(elf_path)],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                return json.dumps({
                    "success": False,
                    "error": result.stderr.strip() or "symbol analysis failed",
                }, indent=2, ensure_ascii=False)

            # Parse nm output and sort by size
            symbols = []
            for line in result.stdout.strip().split("\n"):
                parts = line.split()
                if len(parts) >= 4:
                    try:
                        size = int(parts[1], 16)
                        symbols.append({
                            "size": size,
                            "type": parts[2],
                            "name": parts[3],
                        })
                    except ValueError:
                        continue

            # Sort by size descending, return top 20
            symbols.sort(key=lambda s: s["size"], reverse=True)
            top_symbols = symbols[:20]

            return json.dumps({
                "success": True,
                "elf": str(elf_path),
                "symbols": top_symbols,
                "total_symbols": len(symbols),
            }, indent=2, ensure_ascii=False)

        elif type == "map":
            # Read .map file
            map_files = list(build_dir.rglob("*.map"))
            if not map_files:
                return json.dumps({
                    "success": False,
                    "error": "No .map file found in build directory",
                }, indent=2, ensure_ascii=False)

            map_path = map_files[0]
            map_content = map_path.read_text(encoding="utf-8", errors="ignore")

            # Extract memory configuration from map file
            memory_config = {}
            # Look for Memory Configuration section
            in_memory_section = False
            for line in map_content.split("\n"):
                if "Memory Configuration" in line:
                    in_memory_section = True
                elif in_memory_section and line.strip().startswith("Name"):
                    continue
                elif in_memory_section and line.strip() and not line.startswith(" "):
                    parts = line.split()
                    if len(parts) >= 4:
                        memory_config[parts[0]] = {
                            "origin": int(parts[1], 16),
                            "length": int(parts[2], 16),
                            "attributes": parts[3],
                        }
                elif in_memory_section and not line.strip():
                    in_memory_section = False

            return json.dumps({
                "success": True,
                "elf": str(elf_path),
                "map_file": str(map_path),
                "memory_config": memory_config,
            }, indent=2, ensure_ascii=False)

        else:
            return json.dumps({
                "success": False,
                "error": f"Unknown analysis type: {type}. Use size/symbols/map.",
            }, indent=2, ensure_ascii=False)

    except subprocess.TimeoutExpired:
        return json.dumps({
            "success": False,
            "error": "Analysis timed out",
        }, indent=2, ensure_ascii=False)
    except FileNotFoundError as e:
        return json.dumps({
            "success": False,
            "error": f"Tool not found: {e}. Please install arm-none-eabi toolchain.",
        }, indent=2, ensure_ascii=False)


# ── Keil MDK Tools ────────────────────────────────────────────

@mcp.tool()
def keil_build(project_path: str, target: str = "") -> str:
    """Build Keil MDK project (incremental) using UV4.exe.

    Compiles only changed files. Use keil_rebuild for a full recompile.

    Args:
        project_path: Path to .uvprojx file or project directory containing one
        target: Target name (empty to use the default target)

    Returns:
        JSON string with build result: error/warning counts, output files, program size
    """
    return keil_build_impl(project_path, target)


@mcp.tool()
def keil_clean(project_path: str, target: str = "") -> str:
    """Clean Keil MDK project build output.

    Removes all intermediate and output files for the target.

    Args:
        project_path: Path to .uvprojx file or project directory containing one
        target: Target name (empty to use the default target)

    Returns:
        JSON string with clean result
    """
    return keil_clean_impl(project_path, target)


@mcp.tool()
def keil_flash(project_path: str, target: str = "") -> str:
    """Flash firmware to target device via Keil UV4.exe.

    Uses the debug probe and flash algorithm configured in the .uvoptx file.
    Requires a connected debug probe (ST-LINK, J-LINK, etc.).

    Args:
        project_path: Path to .uvprojx file or project directory containing one
        target: Target name (empty to use the default target)

    Returns:
        JSON string with flash result
    """
    return keil_flash_impl(project_path, target)


@mcp.tool()
def keil_rebuild(project_path: str, target: str = "") -> str:
    """Rebuild Keil MDK project (clean + build all files).

    Performs a full recompile of all source files regardless of changes.

    Args:
        project_path: Path to .uvprojx file or project directory containing one
        target: Target name (empty to use the default target)

    Returns:
        JSON string with rebuild result: error/warning counts, output files, program size
    """
    return keil_rebuild_impl(project_path, target)


# ── Oscilloscope Tools ─────────────────────────────────────────


@mcp.tool()
def scope_connect(address: str = "") -> str:
    """Connect to a USB oscilloscope and verify communication.

    Auto-scans USB VISA resources if no address is provided.
    Returns device identification on success.

    Args:
        address: VISA resource address (e.g. "USB0::0x5656::0x0832::SERIAL::INSTR").
                 Empty string to auto-detect.

    Returns:
        JSON string with connection status and device info
    """
    return scope_connect_impl(address or None)


@mcp.tool()
def scope_list_channels() -> str:
    """List oscilloscope channels and their current configuration.

    Returns the display state, coupling, probe ratio, and vertical
    scale for each available channel.

    Returns:
        JSON string with channel list and settings
    """
    return scope_list_channels_impl()


@mcp.tool()
def scope_get_config() -> str:
    """Query current oscilloscope configuration.

    Returns timebase settings, acquisition type, trigger configuration,
    and a summary of active channels.

    Returns:
        JSON string with full oscilloscope configuration
    """
    return scope_get_config_impl()


@mcp.tool()
def scope_get_waveform(channel: int = 1) -> str:
    """Read waveform data from the specified oscilloscope channel.

    Acquires a single waveform trace and returns the data as
    voltage and time arrays in physical units (Volts, Seconds).
    Acquisition is paused briefly during readout then resumed.

    Args:
        channel: Channel number (1-4, default 1)

    Returns:
        JSON string with waveform metadata, time array, and voltage array
    """
    return scope_get_waveform_impl(channel)


@mcp.tool()
def scope_get_measurement(channel: int = 1) -> str:
    """Read automatic measurements from the specified oscilloscope channel.

    Returns frequency, period, amplitude, Vmax, Vmin, Vrms, rise time,
    and fall time. Values are null when no valid signal is present.

    Args:
        channel: Channel number (1-4, default 1)

    Returns:
        JSON string with measurement results
    """
    return scope_get_measurement_impl(channel)


@mcp.tool()
def scope_analyze_waveform(channel: int = 1, pole_pairs: int = 2) -> str:
    """Analyze waveform: auto-detect signal type, measure frequency/duty/amplitude,
    assess signal quality (rise time, overshoot, glitches), and detect commutation patterns.

    Works with any signal type: PWM, sine, square, triangle, BLDC motor drive, etc.

    Args:
        channel: Channel number (1-4, default 1)
        pole_pairs: Motor pole pairs for RPM estimation (default 2, ignored for non-motor signals)

    Returns:
        JSON string with signal characterization, quality metrics, and optional commutation analysis
    """
    return scope_analyze_waveform_impl(channel, pole_pairs)


@mcp.tool()
def scope_set_timebase(
    scale_s_div: float = 0,
    offset_s: float = 0,
    auto: bool = False,
    channel: int = 1,
    cycles: int = 3,
) -> str:
    """Adjust oscilloscope timebase (time per division).

    Supports two modes:
    - Manual: set scale (s/div) and/or offset directly
    - Auto: automatically adjust timebase to show N complete signal cycles on screen

    Args:
        scale_s_div: Time per division in seconds (e.g. 0.001 = 1ms/div).
                     Set to 0 to query current value without changing.
        offset_s: Trigger offset in seconds.
        auto: If true, auto-adjust timebase based on signal frequency.
        channel: Channel to read frequency from (used with auto mode).
        cycles: Number of complete cycles to show on screen (default 3, used with auto mode).

    Returns:
        JSON string with timebase settings
    """
    return scope_set_timebase_impl(
        scale_s_div=scale_s_div if scale_s_div > 0 else None,
        offset_s=offset_s if offset_s != 0 else None,
        auto=auto,
        channel=channel,
        cycles=cycles,
    )


@mcp.tool()
def scope_set_voltage_scale(
    channel: int = 1,
    scale_v_div: float = 0,
    offset_v: float = 0,
    auto: bool = False,
) -> str:
    """Adjust oscilloscope vertical scale (Volts/div) for a channel.

    Supports two modes:
    - Manual: set scale (V/div) and/or offset directly
    - Auto: automatically adjust scale to fit signal amplitude on screen

    Args:
        channel: Channel number (1-4, default 1)
        scale_v_div: Volts per division (e.g. 1.0 = 1V/div).
                     Set to 0 to query current value without changing.
        offset_v: Vertical offset in volts.
        auto: If true, auto-adjust scale to fit signal amplitude.

    Returns:
        JSON string with voltage scale settings
    """
    return scope_set_voltage_scale_impl(
        channel=channel,
        scale_v_div=scale_v_div if scale_v_div > 0 else None,
        offset_v=offset_v if offset_v != 0 else None,
        auto=auto,
    )