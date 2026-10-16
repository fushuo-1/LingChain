"""Keil MDK utility functions: UV4.exe discovery, build log parsing, project finding."""

import os
import re
import winreg
from dataclasses import dataclass, field
from pathlib import Path


# ── Data Classes ──────────────────────────────────────────────

@dataclass
class BuildLogResult:
    """Parsed Keil build log result."""

    errors: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    error_count: int = 0
    warning_count: int = 0
    program_size: dict | None = None


# ── UV4.exe Discovery ────────────────────────────────────────

_COMMON_UV4_PATHS = [
    r"C:\Keil_v5\UV4\UV4.exe",
    r"D:\Keil_v5\UV4\UV4.exe",
    r"C:\Program Files\Keil_v5\UV4\UV4.exe",
    r"D:\Program Files\Keil_v5\UV4\UV4.exe",
    r"C:\Program Files (x86)\Keil_v5\UV4\UV4.exe",
]


def _try_registry() -> Path | None:
    """Try to find UV4.exe via Windows registry."""
    try:
        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Keil\Products\MDK",
        )
        value, _ = winreg.QueryValueEx(key, "Path")
        winreg.CloseKey(key)
        uv4 = Path(value) / "UV4" / "UV4.exe"
        if uv4.exists():
            return uv4
    except (OSError, FileNotFoundError):
        pass
    return None


def find_uv4() -> Path | None:
    """Find UV4.exe path.

    Search order:
    1. KEIL_UV4 environment variable
    2. Windows registry (HKLM\\SOFTWARE\\Keil\\Products\\MDK)
    3. Common installation paths

    Returns:
        Path to UV4.exe, or None if not found.
    """
    # 1. Environment variable
    env_path = os.environ.get("KEIL_UV4")
    if env_path:
        p = Path(env_path)
        if p.exists():
            return p

    # 2. Registry
    reg_path = _try_registry()
    if reg_path:
        return reg_path

    # 3. Common paths
    for path_str in _COMMON_UV4_PATHS:
        p = Path(path_str)
        if p.exists():
            return p

    return None


# ── .uvprojx Discovery ───────────────────────────────────────

def find_uvprojx(project_path: Path) -> list[Path]:
    """Find .uvprojx files in the given path.

    If project_path is a .uvprojx file, return it directly.
    If it's a directory, search recursively for .uvprojx files.

    Args:
        project_path: Path to a .uvprojx file or project directory

    Returns:
        List of .uvprojx file paths found.
    """
    if project_path.is_file() and project_path.suffix == ".uvprojx":
        return [project_path]

    if project_path.is_dir():
        return sorted(project_path.rglob("*.uvprojx"))

    return []


# ── Build Log Parsing ─────────────────────────────────────────

# ARMCLANG error: "file.c(line): error: message"
_RE_ERROR = re.compile(r"(.+?\.[ch])\((\d+)\):\s*error:\s*(.+)", re.IGNORECASE)
# ARMCLANG warning: "file.c(line): warning: message"
_RE_WARNING = re.compile(r"(.+?\.[ch])\((\d+)\):\s*warning:\s*(.+)", re.IGNORECASE)
# Program Size: Code=21436 RO-data=376 RW-data=12 ZI-data=1644
_RE_PROG_SIZE = re.compile(
    r"Program Size:\s*Code=(\d+)\s+RO-data=(\d+)\s+RW-data=(\d+)\s+ZI-data=(\d+)"
)
# Final count: "0 Error(s), 0 Warning(s)."
_RE_COUNT = re.compile(r"(\d+)\s*Error\(s\),\s*(\d+)\s*Warning\(s\)")


def parse_build_log(log_path: Path) -> BuildLogResult:
    """Parse a Keil HTML build log file.

    The log is plain text wrapped in <html><body><pre> tags.
    Extracts errors, warnings, and program size information.

    Args:
        log_path: Path to the .build_log.htm file

    Returns:
        BuildLogResult with parsed errors, warnings, and program size.
    """
    result = BuildLogResult()

    if not log_path.exists():
        return result

    content = log_path.read_text(encoding="utf-8", errors="ignore")

    # Strip HTML tags to get plain text
    text = re.sub(r"<[^>]+>", "", content)

    # Parse errors
    for match in _RE_ERROR.finditer(text):
        result.errors.append({
            "file": match.group(1),
            "line": int(match.group(2)),
            "message": match.group(3).strip(),
        })

    # Parse warnings
    for match in _RE_WARNING.finditer(text):
        result.warnings.append({
            "file": match.group(1),
            "line": int(match.group(2)),
            "message": match.group(3).strip(),
        })

    # Parse program size
    size_match = _RE_PROG_SIZE.search(text)
    if size_match:
        result.program_size = {
            "code": int(size_match.group(1)),
            "ro_data": int(size_match.group(2)),
            "rw_data": int(size_match.group(3)),
            "zi_data": int(size_match.group(4)),
        }

    # Parse final error/warning count (authoritative)
    count_match = _RE_COUNT.search(text)
    if count_match:
        result.error_count = int(count_match.group(1))
        result.warning_count = int(count_match.group(2))
    else:
        result.error_count = len(result.errors)
        result.warning_count = len(result.warnings)

    return result
