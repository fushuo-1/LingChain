"""Keil MDK build tools: build, clean, flash, rebuild via UV4.exe."""

import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from mcp_server.utils.keil_utils import (
    BuildLogResult,
    find_uv4,
    find_uvprojx,
    parse_build_log,
)

# ── Constants ─────────────────────────────────────────────────

UV4_TIMEOUT = {
    "-b": 300,   # build
    "-r": 300,   # rebuild
    "-c": 60,    # clean
    "-f": 120,   # flash
}


# ── Internal Helpers ──────────────────────────────────────────

def _resolve_project(project_path: str) -> Path:
    """Resolve user-provided path to a .uvprojx file.

    Accepts either a .uvprojx file path or a directory containing one.

    Args:
        project_path: Path to .uvprojx file or project directory

    Returns:
        Resolved .uvprojx file path

    Raises:
        FileNotFoundError: If no .uvprojx file is found
        ValueError: If multiple .uvprojx files found in directory
    """
    p = Path(project_path).resolve()
    found = find_uvprojx(p)

    if not found:
        raise FileNotFoundError(
            f"No .uvprojx file found in: {project_path}"
        )

    if len(found) > 1:
        names = "\n  ".join(str(f) for f in found)
        raise ValueError(
            f"Multiple .uvprojx files found, please specify one:\n  {names}"
        )

    return found[0]


def _get_target_name(uvprojx_path: Path) -> str:
    """Extract the first target name from a .uvprojx file.

    Args:
        uvprojx_path: Path to the .uvprojx file

    Returns:
        Target name string, or empty string if parsing fails.
    """
    try:
        tree = ET.parse(uvprojx_path)
        target = tree.find(".//Target/TargetName")
        if target is not None and target.text:
            return target.text.strip()
    except ET.ParseError:
        pass
    return ""


def _find_output_files(uvprojx_path: Path, target_name: str) -> dict:
    """Find build output files (.axf, .hex, .bin) in the output directory.

    Keil outputs to a subdirectory named after the target, next to the .uvprojx.

    Args:
        uvprojx_path: Path to the .uvprojx file
        target_name: Target name (used as output subdirectory name)

    Returns:
        Dict with axf/hex/bin paths (as strings) or None if not found.
    """
    output_dir = uvprojx_path.parent / target_name
    result: dict[str, str | None] = {"axf": None, "hex": None, "bin": None}

    if not output_dir.is_dir():
        return result

    for ext in ("axf", "hex", "bin"):
        files = list(output_dir.glob(f"*.{ext}"))
        if files:
            result[ext] = str(files[0])

    return result


def _find_build_log(uvprojx_path: Path, target_name: str) -> Path | None:
    """Find the build log HTML file.

    Args:
        uvprojx_path: Path to the .uvprojx file
        target_name: Target name

    Returns:
        Path to .build_log.htm, or None if not found.
    """
    log_path = uvprojx_path.parent / target_name / f"{target_name}.build_log.htm"
    return log_path if log_path.exists() else None


def _run_uv4(
    uv4_path: Path,
    uvprojx_path: Path,
    flag: str,
    target: str = "",
) -> dict:
    """Run UV4.exe with the given flag and return structured result.

    Args:
        uv4_path: Path to UV4.exe
        uvprojx_path: Path to the .uvprojx file
        flag: UV4.exe flag (-b, -r, -c, -f)
        target: Target name (empty for default target)

    Returns:
        Dict with success, errors, warnings, output_files, etc.
    """
    target_name = target or _get_target_name(uvprojx_path)
    timeout = UV4_TIMEOUT.get(flag, 300)

    # Build command
    cmd = [str(uv4_path), flag, str(uvprojx_path), "-j0"]
    if target:
        cmd.extend(["-t", target])

    # Ensure output directory exists (UV4.exe requires it)
    if target_name:
        output_dir = uvprojx_path.parent / target_name
        output_dir.mkdir(parents=True, exist_ok=True)

    start = time.time()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        elapsed = round(time.time() - start, 1)
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "error": f"UV4.exe timed out ({timeout}s)",
        }
    except FileNotFoundError:
        return {
            "success": False,
            "error": f"UV4.exe not found: {uv4_path}",
        }

    # UV4.exe return codes: 0=ok, 1=warnings only, 2=errors, 3=fatal
    success = result.returncode <= 1

    # Parse build log
    log_path = _find_build_log(uvprojx_path, target_name)
    log_result = BuildLogResult()
    if log_path:
        log_result = parse_build_log(log_path)

    # Find output files
    output_files = _find_output_files(uvprojx_path, target_name)

    response: dict = {
        "success": success,
        "errors": log_result.error_count,
        "warnings": log_result.warning_count,
        "error_details": log_result.errors,
        "warning_details": log_result.warnings,
        "output_files": output_files,
        "program_size": log_result.program_size,
        "duration_seconds": elapsed,
        "build_log": str(log_path) if log_path else None,
    }

    if not success:
        response["error"] = (
            f"Build failed with {log_result.error_count} error(s) "
            f"and {log_result.warning_count} warning(s)"
        )

    return response


# ── Public API ────────────────────────────────────────────────

def keil_build_impl(project_path: str, target: str = "") -> str:
    """Build a Keil MDK project (incremental).

    Args:
        project_path: Path to .uvprojx file or project directory
        target: Target name (empty for default)

    Returns:
        JSON string with build result.
    """
    uv4 = find_uv4()
    if not uv4:
        return json.dumps({
            "success": False,
            "error": (
                "UV4.exe not found. Set KEIL_UV4 environment variable "
                "to the full path of UV4.exe, or install Keil MDK."
            ),
        }, indent=2, ensure_ascii=False)

    try:
        uvprojx = _resolve_project(project_path)
    except (FileNotFoundError, ValueError) as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, indent=2, ensure_ascii=False)

    return json.dumps(
        _run_uv4(uv4, uvprojx, "-b", target),
        indent=2,
        ensure_ascii=False,
    )


def keil_clean_impl(project_path: str, target: str = "") -> str:
    """Clean Keil MDK project build output.

    Args:
        project_path: Path to .uvprojx file or project directory
        target: Target name (empty for default)

    Returns:
        JSON string with clean result.
    """
    uv4 = find_uv4()
    if not uv4:
        return json.dumps({
            "success": False,
            "error": (
                "UV4.exe not found. Set KEIL_UV4 environment variable "
                "to the full path of UV4.exe, or install Keil MDK."
            ),
        }, indent=2, ensure_ascii=False)

    try:
        uvprojx = _resolve_project(project_path)
    except (FileNotFoundError, ValueError) as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, indent=2, ensure_ascii=False)

    result = _run_uv4(uv4, uvprojx, "-c", target)
    if result.get("success"):
        result["message"] = "Build output cleaned"
    return json.dumps(result, indent=2, ensure_ascii=False)


def keil_flash_impl(project_path: str, target: str = "") -> str:
    """Flash firmware to target via Keil UV4.exe.

    Uses the debug probe and flash algorithm configured in the .uvoptx file.

    Args:
        project_path: Path to .uvprojx file or project directory
        target: Target name (empty for default)

    Returns:
        JSON string with flash result.
    """
    uv4 = find_uv4()
    if not uv4:
        return json.dumps({
            "success": False,
            "error": (
                "UV4.exe not found. Set KEIL_UV4 environment variable "
                "to the full path of UV4.exe, or install Keil MDK."
            ),
        }, indent=2, ensure_ascii=False)

    try:
        uvprojx = _resolve_project(project_path)
    except (FileNotFoundError, ValueError) as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, indent=2, ensure_ascii=False)

    result = _run_uv4(uv4, uvprojx, "-f", target)
    if result.get("success"):
        result["message"] = "Firmware flashed successfully"
    return json.dumps(result, indent=2, ensure_ascii=False)


def keil_rebuild_impl(project_path: str, target: str = "") -> str:
    """Rebuild Keil MDK project (clean + build all files).

    Args:
        project_path: Path to .uvprojx file or project directory
        target: Target name (empty for default)

    Returns:
        JSON string with rebuild result.
    """
    uv4 = find_uv4()
    if not uv4:
        return json.dumps({
            "success": False,
            "error": (
                "UV4.exe not found. Set KEIL_UV4 environment variable "
                "to the full path of UV4.exe, or install Keil MDK."
            ),
        }, indent=2, ensure_ascii=False)

    try:
        uvprojx = _resolve_project(project_path)
    except (FileNotFoundError, ValueError) as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, indent=2, ensure_ascii=False)

    return json.dumps(
        _run_uv4(uv4, uvprojx, "-r", target),
        indent=2,
        ensure_ascii=False,
    )
