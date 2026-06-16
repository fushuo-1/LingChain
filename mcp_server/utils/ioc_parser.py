"""Parse STM32CubeMX .ioc configuration files."""

from pathlib import Path
from dataclasses import dataclass


@dataclass
class IocConfig:
    """Parsed STM32CubeMX .ioc configuration."""

    mcu_name: str
    mcu_family: str
    mcu_package: str
    hal_version: str
    project_name: str
    toolchain: str
    c_standard: str
    heap_size: str
    stack_size: str
    defines: list[str]


def _parse_ioc_raw(ioc_path: Path) -> dict[str, str]:
    """Parse a .ioc file line by line into key=value pairs.

    .ioc files use INI-like key=value lines inside [section] headers,
    but values can contain unescaped special characters (backslashes, quotes).
    Standard ConfigParser fails on these, so we parse manually.

    Args:
        ioc_path: Path to the .ioc file

    Returns:
        Flat dict of "section.key" -> value for all key=value lines
    """
    result: dict[str, str] = {}
    current_section = ""

    with ioc_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            # Section header
            if line.startswith("[") and line.endswith("]"):
                current_section = line[1:-1].strip()
                continue
            # Key=value line (skip comment-like lines starting with # or ;)
            if line.startswith(("#", ";")):
                continue
            if "=" in line:
                key, sep, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                section_key = f"{current_section}.{key}" if current_section else key
                result[section_key] = value

    return result


def parse_ioc(ioc_path: Path) -> IocConfig:
    """Parse a .ioc file and extract MCU configuration.

    Args:
        ioc_path: Path to the .ioc file

    Returns:
        IocConfig with extracted MCU and project settings

    Raises:
        FileNotFoundError: If .ioc file does not exist
        ValueError: If required fields are missing
    """
    if not ioc_path.exists():
        raise FileNotFoundError(f".ioc file not found: {ioc_path}")

    raw = _parse_ioc_raw(ioc_path)

    # Extract MCU info
    mcu_name = raw.get("Mcu.Name", "")
    mcu_family = raw.get("Mcu.Family", "")
    mcu_package = raw.get("Mcu.Package", "")

    # Extract project info
    project_name = raw.get("ProjectManager.ProjectName", "")
    hal_version = raw.get("ProjectManager.FirmwarePackage", "")
    toolchain = raw.get("ProjectManager.TargetToolchain", "")
    c_standard = raw.get("ProjectManager.CompilerLinker", "GCC")
    heap_size = raw.get("ProjectManager.HeapSize", "0x200")
    stack_size = raw.get("ProjectManager.StackSize", "0x400")

    # Extract defines
    defines_raw = raw.get("PreviousLibFiles.CDefines", "")
    defines = [d.strip() for d in defines_raw.split(";") if d.strip()]

    return IocConfig(
        mcu_name=mcu_name,
        mcu_family=mcu_family,
        mcu_package=mcu_package,
        hal_version=hal_version,
        project_name=project_name,
        toolchain=toolchain,
        c_standard=c_standard,
        heap_size=heap_size,
        stack_size=stack_size,
        defines=defines,
    )


def get_chip_series(mcu_name: str) -> str:
    """Extract chip series from MCU name (e.g., STM32G070xx -> G0).

    Args:
        mcu_name: Full MCU name like STM32G070xx

    Returns:
        Series identifier (G0, F4, H7, etc.)
    """
    if mcu_name.startswith("STM32") and len(mcu_name) >= 7:
        return mcu_name[5:7].upper()
    return "UNKNOWN"


def get_chip_target(mcu_name: str) -> str:
    """Get OpenOCD target name from MCU name.

    Args:
        mcu_name: Full MCU name like STM32G070xx

    Returns:
        OpenOCD target config name
    """
    series = get_chip_series(mcu_name)
    # Map series to OpenOCD target names
    target_map = {
        "G0": "stm32g0x",
        "F0": "stm32f0x",
        "F1": "stm32f1x",
        "F2": "stm32f2x",
        "F3": "stm32f3x",
        "F4": "stm32f4x",
        "F7": "stm32f7x",
        "H7": "stm32h7x",
        "L0": "stm32l0x",
        "L1": "stm32l1x",
        "L4": "stm32l4x",
        "WB": "stm32wbx",
        "WL": "stm32wlx",
    }
    return target_map.get(series, f"stm32{series.lower()}x")
