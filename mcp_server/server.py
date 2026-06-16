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

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)
        interface: Debug probe interface (stlink/jlink/cmsis-dap)

    Returns:
        Flash result with success/failure status
    """
    return f"[flash] Placeholder - will flash {project_dir} via {interface}"


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

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)
        type: Analysis type (size/symbols/map)

    Returns:
        Analysis result with size breakdown or symbol info
    """
    return f"[analyze] Placeholder - will analyze {project_dir} firmware ({type})"