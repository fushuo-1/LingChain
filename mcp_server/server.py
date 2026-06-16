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

from mcp_server.utils.ioc_parser import parse_ioc, get_chip_series, get_chip_target
from mcp_server.utils.project_scanner import scan_project
from mcp_server.utils.toolchain_manager import generate_toolchain_content

mcp = FastMCP("lingchain-mcp")


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

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)
        interface: Debug probe interface (stlink/jlink/cmsis-dap)

    Returns:
        Debug session info with GDB connection details
    """
    return f"[debug] Placeholder - will start debug session for {project_dir}"


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