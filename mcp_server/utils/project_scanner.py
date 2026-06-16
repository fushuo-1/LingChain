"""Scan STM32 project directory and check toolchain availability."""

import shutil
import subprocess
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class ToolchainStatus:
    """Status of a toolchain component."""

    name: str
    available: bool
    version: str = ""
    path: str = ""
    error: str = ""


@dataclass
class ProjectScanResult:
    """Result of scanning a project directory."""

    project_dir: Path
    ioc_file: Path | None = None
    cmake_lists: Path | None = None
    cmake_presets: Path | None = None
    toolchain_file: Path | None = None
    linker_script: Path | None = None
    startup_file: Path | None = None
    core_dir: Path | None = None
    drivers_dir: Path | None = None
    toolchain_status: list[ToolchainStatus] = field(default_factory=list)
    is_valid: bool = False
    errors: list[str] = field(default_factory=list)


def _check_tool(name: str, args: list[str] = None) -> ToolchainStatus:
    """Check if a tool is available and get its version.

    Args:
        name: Tool executable name
        args: Arguments to pass for version check (default: --version)

    Returns:
        ToolchainStatus with availability and version info
    """
    if args is None:
        args = ["--version"]

    tool_path = shutil.which(name)
    if not tool_path:
        return ToolchainStatus(name=name, available=False, error=f"{name} not found in PATH")

    try:
        result = subprocess.run(
            [name] + args,
            capture_output=True,
            text=True,
            timeout=5,
        )
        version = result.stdout.strip().split("\n")[0] if result.stdout else ""
        return ToolchainStatus(
            name=name,
            available=True,
            version=version,
            path=tool_path,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        return ToolchainStatus(
            name=name,
            available=False,
            path=tool_path,
            error=f"Failed to run {name}: {e}",
        )


def scan_project(project_dir: Path) -> ProjectScanResult:
    """Scan an STM32CubeMX project directory for structure and toolchain.

    Args:
        project_dir: Path to the project directory

    Returns:
        ProjectScanResult with project structure and toolchain status
    """
    result = ProjectScanResult(project_dir=project_dir)

    # Check if directory exists
    if not project_dir.exists():
        result.errors.append(f"Project directory does not exist: {project_dir}")
        return result

    # Find .ioc file
    ioc_files = list(project_dir.glob("*.ioc"))
    if ioc_files:
        result.ioc_file = ioc_files[0]
    else:
        result.errors.append("No .ioc file found (not a STM32CubeMX project?)")

    # Check CMake files
    result.cmake_lists = project_dir / "CMakeLists.txt"
    result.cmake_presets = project_dir / "CMakePresets.json"

    if not result.cmake_lists.exists():
        result.errors.append("CMakeLists.txt not found")

    # Check toolchain file
    toolchain_candidates = [
        project_dir / "cmake" / "gcc-arm-none-eabi.cmake",
        project_dir / "cmake" / "toolchain.cmake",
    ]
    for candidate in toolchain_candidates:
        if candidate.exists():
            result.toolchain_file = candidate
            break

    # Check linker script
    ld_files = list(project_dir.glob("*.ld"))
    if ld_files:
        result.linker_script = ld_files[0]

    # Check startup file
    startup_files = list(project_dir.glob("startup_*.s"))
    if startup_files:
        result.startup_file = startup_files[0]

    # Check Core and Drivers directories
    result.core_dir = project_dir / "Core"
    result.drivers_dir = project_dir / "Drivers"

    # Check toolchain availability
    tools_to_check = [
        ("arm-none-eabi-gcc", ["--version"]),
        ("cmake", ["--version"]),
        ("ninja", ["--version"]),
        ("openocd", ["--version"]),
        ("arm-none-eabi-gdb", ["--version"]),
        ("arm-none-eabi-size", ["--version"]),
        ("arm-none-eabi-objcopy", ["--version"]),
    ]

    for tool_name, args in tools_to_check:
        result.toolchain_status.append(_check_tool(tool_name, args))

    # Determine if project is valid
    result.is_valid = (
        result.ioc_file is not None
        and result.cmake_lists.exists()
        and any(ts.available for ts in result.toolchain_status if ts.name in ("arm-none-eabi-gcc", "cmake"))
    )

    return result


def format_scan_result(result: ProjectScanResult) -> str:
    """Format project scan result as a readable string.

    Args:
        result: ProjectScanResult to format

    Returns:
        Formatted string with project info and toolchain status
    """
    lines = [
        f"Project: {result.project_dir}",
        "",
        "=== Project Structure ===",
        f"  .ioc file:       {result.ioc_file or 'NOT FOUND'}",
        f"  CMakeLists.txt:  {'FOUND' if result.cmake_lists and result.cmake_lists.exists() else 'NOT FOUND'}",
        f"  CMakePresets:    {'FOUND' if result.cmake_presets and result.cmake_presets.exists() else 'NOT FOUND'}",
        f"  Toolchain file:  {result.toolchain_file or 'NOT FOUND'}",
        f"  Linker script:   {result.linker_script or 'NOT FOUND'}",
        f"  Startup file:    {result.startup_file or 'NOT FOUND'}",
        f"  Core dir:        {'FOUND' if result.core_dir and result.core_dir.exists() else 'NOT FOUND'}",
        f"  Drivers dir:     {'FOUND' if result.drivers_dir and result.drivers_dir.exists() else 'NOT FOUND'}",
        "",
        "=== Toolchain Status ===",
    ]

    for ts in result.toolchain_status:
        status = "✅" if ts.available else "❌"
        version = f" ({ts.version})" if ts.version else ""
        error = f" - {ts.error}" if ts.error else ""
        lines.append(f"  {status} {ts.name}{version}{error}")

    lines.extend([
        "",
        f"=== Summary ===",
        f"  Project valid: {'YES' if result.is_valid else 'NO'}",
    ])

    if result.errors:
        lines.extend(["", "=== Errors ==="])
        for error in result.errors:
            lines.append(f"  ⚠️  {error}")

    return "\n".join(lines)
