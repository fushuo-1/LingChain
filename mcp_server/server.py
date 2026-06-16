"""LingChain MCP Server - STM32 CMake build chain tools.

This MCP server provides tools for LLM-controlled STM32 development:
- init:      Scan project (.ioc) and configure toolchain
- configure: Run cmake --preset
- build:     Compile the project
- flash:     Flash firmware via OpenOCD
- debug:     Start debugging session
- analyze:   Analyze firmware size/symbols
"""

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("lingchain-mcp")


@mcp.tool()
def init(project_dir: str) -> str:
    """Initialize STM32 CMake project by scanning .ioc file and checking toolchain.

    Args:
        project_dir: Path to STM32CubeMX generated project directory

    Returns:
        Project summary with chip info and toolchain status
    """
    return f"[init] Placeholder - will scan {project_dir} for STM32CubeMX project"


@mcp.tool()
def configure(project_dir: str, preset: str = "Debug") -> str:
    """Configure CMake build system for STM32 project.

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)

    Returns:
        Build directory path and configuration result
    """
    return f"[configure] Placeholder - will run cmake --preset {preset} in {project_dir}"


@mcp.tool()
def build(project_dir: str, preset: str = "Debug") -> str:
    """Build STM32 project using CMake.

    Args:
        project_dir: Path to STM32 project directory
        preset: CMake preset name (Debug/Release)

    Returns:
        Build result with errors, warnings, and output paths
    """
    return f"[build] Placeholder - will compile {project_dir} with preset {preset}"


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