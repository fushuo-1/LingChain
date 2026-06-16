"""MCP Server entry point for Stdio transport."""

from mcp_server.server import mcp


def main() -> None:
    """Run the MCP server via Stdio transport."""
    mcp.run()


if __name__ == "__main__":
    main()