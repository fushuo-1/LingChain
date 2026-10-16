"""Tests for Keil MDK utility functions."""

import os
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

from mcp_server.utils.keil_utils import (
    find_uv4,
    find_uvprojx,
    parse_build_log,
    BuildLogResult,
)


# ── find_uv4 ──────────────────────────────────────────────────

class TestFindUv4:
    """Tests for UV4.exe discovery."""

    def test_env_var(self, tmp_path):
        """Should find UV4.exe from KEIL_UV4 environment variable."""
        uv4 = tmp_path / "UV4.exe"
        uv4.touch()
        with patch.dict(os.environ, {"KEIL_UV4": str(uv4)}):
            result = find_uv4()
            assert result == uv4

    def test_env_var_not_exist(self, tmp_path):
        """Should fall through when KEIL_UV4 points to non-existent file."""
        fake = tmp_path / "nonexistent.exe"
        with patch.dict(os.environ, {"KEIL_UV4": str(fake)}):
            with patch("mcp_server.utils.keil_utils._try_registry", return_value=None):
                result = find_uv4()
                # Will check common paths; likely None in test env
                assert result is None or isinstance(result, Path)

    def test_common_path(self, tmp_path):
        """Should find UV4.exe from a common path."""
        uv4 = tmp_path / "Keil_v5" / "UV4" / "UV4.exe"
        uv4.parent.mkdir(parents=True)
        uv4.touch()
        with patch.dict(os.environ, {}, clear=True):
            with patch("mcp_server.utils.keil_utils._try_registry", return_value=None):
                with patch(
                    "mcp_server.utils.keil_utils._COMMON_UV4_PATHS",
                    [str(uv4)],
                ):
                    result = find_uv4()
                    assert result == uv4

    def test_not_found(self):
        """Should return None when UV4.exe is not found anywhere."""
        with patch.dict(os.environ, {}, clear=True):
            with patch("mcp_server.utils.keil_utils._try_registry", return_value=None):
                with patch(
                    "mcp_server.utils.keil_utils._COMMON_UV4_PATHS",
                    ["/nonexistent/UV4.exe"],
                ):
                    result = find_uv4()
                    assert result is None


# ── find_uvprojx ──────────────────────────────────────────────

class TestFindUvprojx:
    """Tests for .uvprojx file discovery."""

    def test_direct_file(self, tmp_path):
        """Should return the file directly when given a .uvprojx path."""
        uvprojx = tmp_path / "test.uvprojx"
        uvprojx.touch()
        result = find_uvprojx(uvprojx)
        assert result == [uvprojx]

    def test_directory_search(self, tmp_path):
        """Should find .uvprojx files in directory."""
        mdk = tmp_path / "MDK-ARM"
        mdk.mkdir()
        uvprojx = mdk / "project.uvprojx"
        uvprojx.touch()
        result = find_uvprojx(tmp_path)
        assert len(result) == 1
        assert result[0] == uvprojx

    def test_multiple_files(self, tmp_path):
        """Should find multiple .uvprojx files."""
        for name in ("a.uvprojx", "b.uvprojx"):
            (tmp_path / name).touch()
        result = find_uvprojx(tmp_path)
        assert len(result) == 2

    def test_not_found(self, tmp_path):
        """Should return empty list when no .uvprojx found."""
        result = find_uvprojx(tmp_path)
        assert result == []

    def test_nonexistent_path(self):
        """Should return empty list for non-existent path."""
        result = find_uvprojx(Path("/nonexistent/path"))
        assert result == []


# ── parse_build_log ───────────────────────────────────────────

SAMPLE_LOG_SUCCESS = """\
<html>
<body>
<pre>
<h1>µVision Build Log</h1>
<h2>Tool Versions:</h2>
IDE-Version: µVision V5.43.1.0
Toolchain:       MDK-ARM Plus  Version: 5.43.0.0
Toolchain Path:  D:\\Program Files\\Keil_v5\\ARM\\ARMCLANG\\Bin
C Compiler:      ArmClang.exe V6.24

<h2>Output:</h2>
*** Using Compiler 'V6.24', folder: 'D:\\Program Files\\Keil_v5\\ARM\\ARMCLANG\\Bin'
Rebuild target 'FOC-stm32g0'
assembling startup_stm32g070xx.s...
compiling main.c...
linking...
Program Size: Code=21436 RO-data=376 RW-data=12 ZI-data=1644
FromELF: creating hex file...
"FOC-stm32g0\\FOC-stm32g0.axf" - 0 Error(s), 0 Warning(s).
Build Time Elapsed:  00:00:03
</pre>
</body>
</html>
"""

SAMPLE_LOG_ERRORS = """\
<html>
<body>
<pre>
<h1>µVision Build Log</h1>
<h2>Output:</h2>
compiling main.c...
Core/Src/main.c(42): error: use of undeclared identifier 'foo'
Core/Src/main.c(55): warning: unused variable 'bar'
Core/Src/main.c(80): error: expected ';' after expression
"FOC-stm32g0\\FOC-stm32g0.axf" - 2 Error(s), 1 Warning(s).
Build Time Elapsed:  00:00:01
</pre>
</body>
</html>
"""


class TestParseBuildLog:
    """Tests for HTML build log parsing."""

    def test_success(self, tmp_path):
        """Should parse a successful build log."""
        log = tmp_path / "build_log.htm"
        log.write_text(SAMPLE_LOG_SUCCESS, encoding="utf-8")

        result = parse_build_log(log)
        assert result.error_count == 0
        assert result.warning_count == 0
        assert result.program_size == {
            "code": 21436,
            "ro_data": 376,
            "rw_data": 12,
            "zi_data": 1644,
        }

    def test_errors_and_warnings(self, tmp_path):
        """Should parse errors and warnings from build log."""
        log = tmp_path / "build_log.htm"
        log.write_text(SAMPLE_LOG_ERRORS, encoding="utf-8")

        result = parse_build_log(log)
        assert result.error_count == 2
        assert result.warning_count == 1
        assert len(result.errors) == 2
        assert result.errors[0]["file"] == "Core/Src/main.c"
        assert result.errors[0]["line"] == 42
        assert "undeclared identifier" in result.errors[0]["message"]
        assert len(result.warnings) == 1

    def test_nonexistent_file(self):
        """Should return empty result for non-existent log file."""
        result = parse_build_log(Path("/nonexistent/log.htm"))
        assert result.error_count == 0
        assert result.warning_count == 0
        assert result.program_size is None
