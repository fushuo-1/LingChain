"""Tests for Keil MDK build tools."""

import json
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

from mcp_server.keil import (
    _resolve_project,
    _get_target_name,
    keil_build_impl,
    keil_clean_impl,
    keil_flash_impl,
    keil_rebuild_impl,
)


# ── Fixtures ──────────────────────────────────────────────────

@pytest.fixture
def keil_project(tmp_path):
    """Create a minimal Keil project structure for testing."""
    mdk = tmp_path / "MDK-ARM"
    mdk.mkdir()
    uvprojx = mdk / "test.uvprojx"
    uvprojx.write_text(
        '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>'
        "<Project>"
        "  <Targets>"
        "    <Target>"
        "      <TargetName>my_target</TargetName>"
        "    </Target>"
        "  </Targets>"
        "</Project>",
        encoding="utf-8",
    )
    return tmp_path, uvprojx


# ── _resolve_project ──────────────────────────────────────────

class TestResolveProject:
    """Tests for project path resolution."""

    def test_direct_uvprojx(self, keil_project):
        """Should accept a .uvprojx file path directly."""
        _, uvprojx = keil_project
        result = _resolve_project(str(uvprojx))
        assert result == uvprojx.resolve()

    def test_directory(self, keil_project):
        """Should find .uvprojx in directory."""
        project_dir, uvprojx = keil_project
        result = _resolve_project(str(project_dir))
        assert result == uvprojx.resolve()

    def test_not_found(self, tmp_path):
        """Should raise FileNotFoundError when no .uvprojx found."""
        with pytest.raises(FileNotFoundError):
            _resolve_project(str(tmp_path))

    def test_multiple_raises(self, tmp_path):
        """Should raise ValueError when multiple .uvprojx found."""
        mdk = tmp_path / "MDK-ARM"
        mdk.mkdir()
        (mdk / "a.uvprojx").touch()
        (mdk / "b.uvprojx").touch()
        with pytest.raises(ValueError, match="Multiple"):
            _resolve_project(str(tmp_path))


# ── _get_target_name ──────────────────────────────────────────

class TestGetTargetName:
    """Tests for target name extraction."""

    def test_valid_xml(self, keil_project):
        """Should extract target name from .uvprojx XML."""
        _, uvprojx = keil_project
        assert _get_target_name(uvprojx) == "my_target"

    def test_invalid_xml(self, tmp_path):
        """Should return empty string for invalid XML."""
        bad = tmp_path / "bad.uvprojx"
        bad.write_text("not xml", encoding="utf-8")
        assert _get_target_name(bad) == ""

    def test_no_target(self, tmp_path):
        """Should return empty string when no TargetName element."""
        no_target = tmp_path / "no_target.uvprojx"
        no_target.write_text("<Project></Project>", encoding="utf-8")
        assert _get_target_name(no_target) == ""


# ── keil_build_impl ───────────────────────────────────────────

class TestKeilBuildImpl:
    """Tests for keil_build_impl."""

    def test_uv4_not_found(self, keil_project):
        """Should return error when UV4.exe not found."""
        project_dir, _ = keil_project
        with patch("mcp_server.keil.find_uv4", return_value=None):
            result = json.loads(keil_build_impl(str(project_dir)))
            assert result["success"] is False
            assert "UV4.exe not found" in result["error"]

    def test_no_project(self, tmp_path):
        """Should return error when no .uvprojx found."""
        with patch("mcp_server.keil.find_uv4", return_value=Path("/fake/UV4.exe")):
            result = json.loads(keil_build_impl(str(tmp_path)))
            assert result["success"] is False
            assert "No .uvprojx" in result["error"]

    def test_build_success(self, keil_project, tmp_path):
        """Should return success result after successful build."""
        project_dir, uvprojx = keil_project
        fake_uv4 = tmp_path / "UV4.exe"
        fake_uv4.touch()

        mock_result = MagicMock()
        mock_result.returncode = 0

        with (
            patch("mcp_server.keil.find_uv4", return_value=fake_uv4),
            patch("mcp_server.keil.subprocess.run", return_value=mock_result),
        ):
            result = json.loads(keil_build_impl(str(project_dir)))
            assert "success" in result
            assert "output_files" in result

    def test_build_with_errors(self, keil_project, tmp_path):
        """Should return error details when build has errors."""
        project_dir, uvprojx = keil_project
        fake_uv4 = tmp_path / "UV4.exe"
        fake_uv4.touch()

        # Create output directory and log with errors
        output_dir = uvprojx.parent / "my_target"
        output_dir.mkdir(parents=True, exist_ok=True)
        log_path = output_dir / "my_target.build_log.htm"
        log_path.write_text(
            '<html><body><pre>'
            "compiling main.c...\n"
            "Core/Src/main.c(42): error: undeclared identifier\n"
            '"my_target\\my_target.axf" - 1 Error(s), 0 Warning(s).\n'
            "</pre></body></html>",
            encoding="utf-8",
        )

        mock_result = MagicMock()
        mock_result.returncode = 2  # errors

        with (
            patch("mcp_server.keil.find_uv4", return_value=fake_uv4),
            patch("mcp_server.keil.subprocess.run", return_value=mock_result),
        ):
            result = json.loads(keil_build_impl(str(project_dir)))
            assert result["success"] is False
            assert result["errors"] == 1
            assert len(result["error_details"]) == 1


# ── keil_clean_impl ───────────────────────────────────────────

class TestKeilCleanImpl:
    """Tests for keil_clean_impl."""

    def test_uv4_not_found(self, keil_project):
        """Should return error when UV4.exe not found."""
        project_dir, _ = keil_project
        with patch("mcp_server.keil.find_uv4", return_value=None):
            result = json.loads(keil_clean_impl(str(project_dir)))
            assert result["success"] is False

    def test_clean_success(self, keil_project, tmp_path):
        """Should return success with clean message."""
        project_dir, _ = keil_project
        fake_uv4 = tmp_path / "UV4.exe"
        fake_uv4.touch()

        mock_result = MagicMock()
        mock_result.returncode = 0

        with (
            patch("mcp_server.keil.find_uv4", return_value=fake_uv4),
            patch("mcp_server.keil.subprocess.run", return_value=mock_result),
        ):
            result = json.loads(keil_clean_impl(str(project_dir)))
            assert result["success"] is True
            assert "cleaned" in result["message"].lower()


# ── keil_flash_impl ───────────────────────────────────────────

class TestKeilFlashImpl:
    """Tests for keil_flash_impl."""

    def test_uv4_not_found(self, keil_project):
        """Should return error when UV4.exe not found."""
        project_dir, _ = keil_project
        with patch("mcp_server.keil.find_uv4", return_value=None):
            result = json.loads(keil_flash_impl(str(project_dir)))
            assert result["success"] is False


# ── keil_rebuild_impl ─────────────────────────────────────────

class TestKeilRebuildImpl:
    """Tests for keil_rebuild_impl."""

    def test_uv4_not_found(self, keil_project):
        """Should return error when UV4.exe not found."""
        project_dir, _ = keil_project
        with patch("mcp_server.keil.find_uv4", return_value=None):
            result = json.loads(keil_rebuild_impl(str(project_dir)))
            assert result["success"] is False
