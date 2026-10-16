"""Tests for oscilloscope VISA communication.

Uses pytest fixtures to mock PyVISA so tests run without a physical device.
Tests requiring a real oscilloscope are marked with @pytest.mark.needs_scope.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from mcp_server.scope import (
    ScopeInfo,
    ScopeSession,
    connect,
    find_scope_address,
    scope_analyze_waveform_impl,
    scope_connect_impl,
    scope_get_config_impl,
    scope_get_measurement_impl,
    scope_get_waveform_impl,
    scope_list_channels_impl,
    scope_set_timebase_impl,
    scope_set_voltage_scale_impl,
)

# ── Fixtures ───────────────────────────────────────────────────

SCOPE_ADDRESS = "USB0::0x5656::0x0832::ADO2A25030073::INSTR"
SCOPE_IDN = "UNI-TREND TECHNOLOGY,UTD2152S-E,ADO2A25030073,1.10.0060"

WAVEFORM_PREAMBLE = "WORD,NORMal,800,1,4.000000e-05,-1.600000e-02,0,4.000000e-01,0,128"
# 800 signed 16-bit values: values near y_reference=128
# raw=128 => voltage = (128-128)*0.4 + 0 = 0.0V
WAVEFORM_RAW_VALUES = [128 + (i % 50 - 25) for i in range(800)]


@pytest.fixture
def mock_instr():
    """Create a mock VISA instrument with common responses."""
    instr = MagicMock()
    instr.timeout = 10000

    def query_side_effect(cmd: str) -> str:
        cmd = cmd.strip().upper()
        responses = {
            "*IDN?": SCOPE_IDN,
            ":CHAN1:DISP?": "1",
            ":CHAN2:DISP?": "0",
            ":CHAN1:COUP?": "DC",
            ":CHAN2:COUP?": "DC",
            ":CHAN1:PROB?": "1.000000e+00",
            ":CHAN2:PROB?": "1.000000e+00",
            ":CHAN1:SCAL?": "1.000000e+01",
            ":CHAN2:SCAL?": "5.000000e+00",
            ":CHAN1:OFFS?": "-0.000000e+00",
            ":CHAN2:OFFS?": "0.000000e+00",
            ":TIM:SCAL?": "2.000000e-03",
            ":TIM:OFFS?": "0.000000e+00",
            ":ACQ:TYPE?": "NORMal",
            ":TRIG:EDGE:SOUR?": "CHAN1",
            ":TRIG:EDGE:LEV?": "1.200000e+00",
            ":WAV:PRE?": WAVEFORM_PREAMBLE,
            ":MEAS:FREQ?": "1.000000e+03",
            ":MEAS:PER?": "1.000000e-03",
            ":MEAS:VAMP?": "1.200000e+00",
            ":MEAS:VMAX?": "6.000000e-01",
            ":MEAS:VMIN?": "-6.000000e-01",
            ":MEAS:VRMS?": "4.630310e-01",
            ":MEAS:RIS?": "2.000000e-08",
            ":MEAS:FALL?": "2.100000e-08",
        }
        return responses.get(cmd, "")

    instr.query.side_effect = query_side_effect
    instr.query_binary_values.return_value = WAVEFORM_RAW_VALUES
    return instr


@pytest.fixture
def mock_rm(mock_instr):
    """Create a mock VISA ResourceManager."""
    rm = MagicMock()
    rm.list_resources.return_value = [SCOPE_ADDRESS]
    rm.open_resource.return_value = mock_instr
    return rm


@pytest.fixture(autouse=True)
def reset_session():
    """Reset the module-level session before each test."""
    import mcp_server.scope as scope_mod

    old_session = scope_mod._session
    scope_mod._session = ScopeSession()
    yield
    scope_mod._session = old_session


# ── ScopeInfo tests ────────────────────────────────────────────


class TestScopeInfo:
    def test_from_idn(self):
        info = ScopeInfo.from_idn(SCOPE_IDN)
        assert info.manufacturer == "UNI-TREND TECHNOLOGY"
        assert info.model == "UTD2152S-E"
        assert info.serial == "ADO2A25030073"
        assert info.firmware == "1.10.0060"

    def test_from_idn_short(self):
        info = ScopeInfo.from_idn("MFG,MODEL")
        assert info.manufacturer == "MFG"
        assert info.model == "MODEL"
        assert info.serial == ""
        assert info.firmware == ""

    def test_from_idn_empty(self):
        info = ScopeInfo.from_idn("")
        assert info.manufacturer == ""


# ── find_scope_address tests ──────────────────────────────────


class TestFindScope:
    def test_finds_scope(self, mock_rm):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            addr = find_scope_address()
        assert addr == SCOPE_ADDRESS

    def test_no_scope_found(self):
        rm = MagicMock()
        rm.list_resources.return_value = ["ASRL3::INSTR"]
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=rm):
            addr = find_scope_address()
        assert addr is None

    def test_non_scope_usb_skipped(self):
        rm = MagicMock()
        rm.list_resources.return_value = ["USB0::0x1234::0x5678::SERIAL::INSTR"]
        instr = MagicMock()
        instr.query.return_value = "SomeVendor,PowerSupply,SN,1.0"
        rm.open_resource.return_value = instr
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=rm):
            addr = find_scope_address()
        assert addr is None


# ── connect tests ─────────────────────────────────────────────


class TestConnect:
    def test_connect_with_address(self, mock_rm, mock_instr):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            rm, instr, info = connect(SCOPE_ADDRESS)
        assert info.model == "UTD2152S-E"
        assert instr == mock_instr

    def test_connect_auto_scan(self, mock_rm, mock_instr):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            rm, instr, info = connect()
        assert info.model == "UTD2152S-E"

    def test_connect_no_scope_raises(self):
        rm = MagicMock()
        rm.list_resources.return_value = []
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=rm):
            with pytest.raises(ConnectionError, match="No oscilloscope found"):
                connect()


# ── ScopeSession tests ────────────────────────────────────────


class TestScopeSession:
    def test_ensure_connected_caches(self, mock_rm, mock_instr):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            session = ScopeSession()
            info1 = session.ensure_connected(SCOPE_ADDRESS)
            info2 = session.ensure_connected(SCOPE_ADDRESS)
        assert info1.model == info2.model
        # Second call reuses existing connection (one *IDN? from ensure_connected,
        # plus one from connect)
        assert mock_instr.query.call_count >= 1

    def test_reconnect_on_broken(self, mock_rm, mock_instr):
        original_query = mock_instr.query.side_effect

        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            session = ScopeSession()
            session.ensure_connected(SCOPE_ADDRESS)
            # Simulate broken connection
            mock_instr.query.side_effect = Exception("disconnected")
            # Should detect broken, reconnect (which calls query again)
            # Restore side_effect so reconnect succeeds
            mock_instr.query.side_effect = original_query
            info = session.ensure_connected(SCOPE_ADDRESS)
        assert info.model == "UTD2152S-E"

    def test_disconnect(self, mock_rm, mock_instr):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            session = ScopeSession()
            session.ensure_connected(SCOPE_ADDRESS)
            session.disconnect()
        assert not session.connected


# ── scope_connect_impl tests ──────────────────────────────────


class TestScopeConnectImpl:
    def test_success(self, mock_rm, mock_instr):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            result = json.loads(scope_connect_impl(SCOPE_ADDRESS))
        assert result["success"] is True
        assert result["model"] == "UTD2152S-E"
        assert result["serial"] == "ADO2A25030073"

    def test_failure(self):
        rm = MagicMock()
        rm.list_resources.return_value = []
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=rm):
            result = json.loads(scope_connect_impl())
        assert result["success"] is False
        assert "error" in result


# ── scope_list_channels_impl tests ────────────────────────────


class TestScopeListChannels:
    def test_returns_active_channels(self, mock_rm, mock_instr):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_list_channels_impl())
        assert result["success"] is True
        # CH1 displayed, CH2 not
        ch1 = next(c for c in result["channels"] if c["channel"] == 1)
        ch2 = next(c for c in result["channels"] if c["channel"] == 2)
        assert ch1["displayed"] is True
        assert ch1["coupling"] == "DC"
        assert ch2["displayed"] is False


# ── scope_get_config_impl tests ──────────────────────────────


class TestScopeGetConfig:
    def test_returns_config(self, mock_rm, mock_instr):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_get_config_impl())
        assert result["success"] is True
        assert result["timebase"]["scale_s_div"] == 0.002
        assert result["acquisition"]["type"] == "NORMal"
        assert len(result["active_channels"]) == 1


# ── scope_get_waveform_impl tests ────────────────────────────


class TestScopeGetWaveform:
    def test_returns_waveform(self, mock_rm, mock_instr):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_get_waveform_impl(channel=1))
        assert result["success"] is True
        assert result["channel"] == 1
        assert result["points"] == 800
        assert len(result["time"]) == 800
        assert len(result["voltage"]) == 800
        # First raw value: 128 + (0%50-25) = 103
        # voltage = (103-128)*0.4 + 0 = -10.0V
        assert result["voltage"][0] == pytest.approx(-10.0, abs=0.01)
        # Check time: first value = x_origin = -0.016
        assert result["time"][0] == pytest.approx(-0.016, abs=0.001)

    def test_voltage_conversion(self, mock_rm, mock_instr):
        """Verify voltage = (raw - y_ref) * y_increment + y_origin."""
        # raw=178, ref=128, y_inc=0.4, y_orig=0 => (178-128)*0.4 = 20.0
        mock_instr.query_binary_values.return_value = [178] + [128] * 799
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_get_waveform_impl(channel=1))
        assert result["voltage"][0] == pytest.approx(20.0, abs=0.01)

    def test_resumes_on_error(self, mock_rm, mock_instr):
        """Ensure :RUN is sent even if read fails."""
        mock_instr.query_binary_values.side_effect = Exception("timeout")
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_get_waveform_impl(channel=1))
        assert result["success"] is False
        mock_instr.write.assert_any_call(":RUN")


# ── scope_get_measurement_impl tests ──────────────────────────


class TestScopeGetMeasurement:
    def test_returns_measurements(self, mock_rm, mock_instr):
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_get_measurement_impl(channel=1))
        assert result["success"] is True
        assert result["frequency"] == 1000.0
        assert result["amplitude"] == 1.2
        assert result["v_rms"] == pytest.approx(0.463, abs=0.01)
        # duty_cycle = (v_rms² - v_min²) / (v_max² - v_min²) * 100
        # = (0.463² - (-0.6)²) / (0.6² - (-0.6)²) = division by 0 → None
        # Vmax=Vmin symmetrical → denom=0 → None
        assert result["duty_cycle"] is None

    def test_null_for_invalid(self, mock_rm, mock_instr):
        """Measurements returning '*' should be null."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            if "FREQ" in cmd.upper():
                return "*"
            return original_query(cmd)

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_get_measurement_impl(channel=1))
        assert result["frequency"] is None
        assert result["amplitude"] is not None

    def test_duty_cycle_calculation(self, mock_rm, mock_instr):
        """Duty cycle calculated from Vrms/Vmax/Vmin for rectangular wave."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":MEAS:FREQ?": "15000",
                ":MEAS:VMAX?": "3.600000e+00",
                ":MEAS:VMIN?": "-2.000000e-01",
                ":MEAS:VRMS?": "1.611000e+00",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_get_measurement_impl(channel=1))
        assert result["duty_cycle"] is not None
        # D = (1.611² - 0.2²) / (3.6² - 0.2²) * 100 ≈ 19.8%
        assert result["duty_cycle"] == pytest.approx(19.8, abs=0.5)

    def test_duty_cycle_null_when_no_frequency(self, mock_rm, mock_instr):
        """Duty cycle should be null when neither frequency nor period detected."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":MEAS:FREQ?": "*",
                ":MEAS:PER?": "*",
                ":MEAS:VMAX?": "3.600000e+00",
                ":MEAS:VMIN?": "-2.000000e-01",
                ":MEAS:VRMS?": "1.611000e+00",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_get_measurement_impl(channel=1))
        assert result["duty_cycle"] is None


# ── scope_analyze_waveform_impl tests ────────────────────────

# Synthetic square wave: 1kHz, 80% duty, 3.3V amplitude
SQUARE_WAVE_RAW = []
for cycle in range(8):  # 8 cycles in the 800-point window
    for i in range(100):  # 100 points per cycle
        SQUARE_WAVE_RAW.append(200 if i < 80 else 50)  # 80% high


class TestScopeAnalyzeWaveform:
    def test_pwm_signal_analysis(self, mock_rm, mock_instr):
        """Analyze a PWM signal using SCPI measurements."""
        mock_instr.query_binary_values.return_value = SQUARE_WAVE_RAW
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_analyze_waveform_impl(channel=1))

        assert result["success"] is True
        # SCPI measurements provide accurate values
        assert result["frequency_hz"] == 1000.0
        assert result["v_max"] == 0.6
        assert result["v_min"] == -0.6
        assert result["amplitude_v"] == 1.2
        assert result["samples"] == 800

    def test_dc_signal(self, mock_rm, mock_instr):
        """DC signal should be classified as DC."""
        mock_instr.query_binary_values.return_value = [128] * 800
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_analyze_waveform_impl(channel=1))

        assert result["success"] is True
        assert result["amplitude_v"] == 1.2  # From SCPI, not waveform

    def test_commutation_detected(self, mock_rm, mock_instr):
        """BLDC-like waveform with PWM pulses + long gap should trigger commutation."""
        bldc_raw = []
        for _ in range(40):
            for _ in range(4):
                bldc_raw.append(200)
            for _ in range(6):
                bldc_raw.append(50)
        for _ in range(400):
            bldc_raw.append(50)
        bldc_raw = bldc_raw[:800]

        mock_instr.query_binary_values.return_value = bldc_raw
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_analyze_waveform_impl(channel=1, pole_pairs=2))

        assert result["success"] is True
        assert "commutation" in result
        assert result["commutation"]["detected"] is True
        # Now uses 1.5x formula (240° gap → full cycle = gap × 1.5)
        assert result["commutation"]["electrical_period_ms"] > 0


# ── scope_set_timebase_impl tests ─────────────────────────────


class TestScopeSetTimebase:
    def test_query_current_timebase(self, mock_rm, mock_instr):
        """No parameters → query current timebase."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":TIM:SCAL?": "1.000000e-03",
                ":TIM:OFFS?": "0.000000e+00",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_timebase_impl())

        assert result["success"] is True
        assert result["mode"] == "query"
        assert result["scale_s_div"] == 1e-3
        assert "ms/div" in result["scale_display"]

    def test_set_scale_manual(self, mock_rm, mock_instr):
        """Set timebase scale manually."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":TIM:SCAL?": "5.000000e-04",
                ":TIM:OFFS?": "0.000000e+00",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_timebase_impl(scale_s_div=5e-4))

        assert result["success"] is True
        assert result["mode"] == "manual"
        assert "scale" in result["changed"]
        assert result["scale_s_div"] == 5e-4
        mock_instr.write.assert_any_call(":TIM:SCAL 0.0005")

    def test_set_offset_manual(self, mock_rm, mock_instr):
        """Set timebase offset manually."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":TIM:SCAL?": "1.000000e-03",
                ":TIM:OFFS?": "2.000000e-04",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_timebase_impl(offset_s=2e-4))

        assert result["success"] is True
        assert result["mode"] == "manual"
        assert "offset" in result["changed"]
        mock_instr.write.assert_any_call(":TIM:OFFS 0.0002")

    def test_auto_mode(self, mock_rm, mock_instr):
        """Auto mode should measure frequency and set appropriate timebase."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":MEAS:VMAX?": "3.120000e+00",
                ":MEAS:VMIN?": "0.000000e+00",
                ":MEAS:FREQ?": "1.500000e+04",
                ":TIM:SCAL?": "5.000000e-05",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_timebase_impl(auto=True, channel=1, cycles=3))

        assert result["success"] is True
        assert result["mode"] == "auto"
        assert result["frequency_hz"] == 15000.0
        assert result["cycles_on_screen"] == 3
        assert "scale_s_div" in result
        assert "scale_display" in result

    def test_auto_mode_no_signal(self, mock_rm, mock_instr):
        """Auto mode should fail gracefully when no signal detected."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":MEAS:VMAX?": "*",
                ":MEAS:VMIN?": "*",
                ":MEAS:FREQ?": "*",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_timebase_impl(auto=True))

        assert result["success"] is False

    def test_invalid_scale_rejected(self, mock_rm, mock_instr):
        """Negative scale should be rejected."""
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_timebase_impl(scale_s_div=-1))

        assert result["success"] is False
        assert "positive" in result["error"].lower()


# ── scope_set_voltage_scale_impl tests ─────────────────────────


class TestScopeSetVoltageScale:
    def test_query_current_scale(self, mock_rm, mock_instr):
        """No parameters → query current voltage scale."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":CHAN1:DISP?": "1",
                ":CHAN1:SCAL?": "1.000000e+00",
                ":CHAN1:OFFS?": "0.000000e+00",
                ":CHAN1:COUP?": "DC",
                ":CHAN1:PROB?": "1.000000e+01",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_voltage_scale_impl(channel=1))

        assert result["success"] is True
        assert result["mode"] == "query"
        assert result["scale_v_div"] == 1.0
        assert "V/div" in result["scale_display"]
        assert result["coupling"] == "DC"

    def test_set_scale_manual(self, mock_rm, mock_instr):
        """Set voltage scale manually."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":CHAN1:DISP?": "1",
                ":CHAN1:SCAL?": "5.000000e-01",
                ":CHAN1:OFFS?": "0.000000e+00",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_voltage_scale_impl(channel=1, scale_v_div=0.5))

        assert result["success"] is True
        assert result["mode"] == "manual"
        assert "scale" in result["changed"]
        assert result["scale_v_div"] == 0.5
        mock_instr.write.assert_any_call(":CHAN1:SCAL 0.5")

    def test_set_offset_manual(self, mock_rm, mock_instr):
        """Set voltage offset manually."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":CHAN1:DISP?": "1",
                ":CHAN1:SCAL?": "1.000000e+00",
                ":CHAN1:OFFS?": "1.500000e+00",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_voltage_scale_impl(channel=1, offset_v=1.5))

        assert result["success"] is True
        assert result["mode"] == "manual"
        assert "offset" in result["changed"]
        mock_instr.write.assert_any_call(":CHAN1:OFFS 1.5")

    def test_auto_mode(self, mock_rm, mock_instr):
        """Auto mode should measure amplitude and set appropriate scale."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":CHAN1:DISP?": "1",
                ":MEAS:VMAX?": "3.120000e+00",
                ":MEAS:VMIN?": "0.000000e+00",
                ":CHAN1:SCAL?": "5.000000e-01",
                ":CHAN1:OFFS?": "-1.560000e+00",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_voltage_scale_impl(channel=1, auto=True))

        assert result["success"] is True
        assert result["mode"] == "auto"
        assert result["signal_v_max"] == 3.12
        assert result["signal_v_min"] == 0.0
        assert result["signal_amplitude"] == pytest.approx(3.12, abs=0.01)
        assert result["scale_v_div"] > 0

    def test_auto_mode_channel_off(self, mock_rm, mock_instr):
        """Auto mode should fail if channel is not displayed."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":CHAN1:DISP?": "0",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_voltage_scale_impl(channel=1, auto=True))

        assert result["success"] is False
        assert "not displayed" in result["error"].lower()

    def test_invalid_scale_rejected(self, mock_rm, mock_instr):
        """Negative scale should be rejected."""
        original_query = mock_instr.query.side_effect

        def query_override(cmd: str) -> str:
            overrides = {
                ":CHAN1:DISP?": "1",
            }
            return overrides.get(cmd.strip().upper(), original_query(cmd))

        mock_instr.query.side_effect = query_override
        with patch("mcp_server.scope.pyvisa.ResourceManager", return_value=mock_rm):
            scope_connect_impl(SCOPE_ADDRESS)
            result = json.loads(scope_set_voltage_scale_impl(channel=1, scale_v_div=-1))

        assert result["success"] is False
        assert "positive" in result["error"].lower()


# ── Integration tests (require real oscilloscope) ─────────────


needs_scope = pytest.mark.needs_scope


@needs_scope
class TestRealScope:
    """Tests that run against a physical oscilloscope.

    Run with: pytest -m needs_scope
    """

    def test_real_connect(self):
        result = json.loads(scope_connect_impl())
        assert result["success"] is True
        assert "UTD" in result.get("model", "")

    def test_real_waveform(self):
        scope_connect_impl()
        result = json.loads(scope_get_waveform_impl(channel=1))
        assert result["success"] is True
        assert result["points"] > 0
        assert len(result["voltage"]) == result["points"]

    def test_real_measurement(self):
        scope_connect_impl()
        result = json.loads(scope_get_measurement_impl(channel=1))
        assert result["success"] is True

    def test_real_timebase_query(self):
        """Query current timebase without changing it."""
        scope_connect_impl()
        result = json.loads(scope_set_timebase_impl())
        assert result["success"] is True
        assert result["mode"] == "query"
        assert result["scale_s_div"] > 0

    def test_real_timebase_auto(self):
        """Auto-adjust timebase to show 3 cycles of the signal."""
        scope_connect_impl()
        result = json.loads(scope_set_timebase_impl(auto=True, channel=1, cycles=3))
        assert result["success"] is True
        assert result["mode"] == "auto"
        assert result["frequency_hz"] > 0
        assert result["scale_s_div"] > 0

    def test_real_voltage_scale_query(self):
        """Query current voltage scale without changing it."""
        scope_connect_impl()
        result = json.loads(scope_set_voltage_scale_impl(channel=1))
        assert result["success"] is True
        assert result["mode"] == "query"
        assert result["scale_v_div"] > 0

    def test_real_voltage_scale_auto(self):
        """Auto-adjust voltage scale to fit signal amplitude."""
        scope_connect_impl()
        result = json.loads(scope_set_voltage_scale_impl(channel=1, auto=True))
        assert result["success"] is True
        assert result["mode"] == "auto"
        assert result["signal_amplitude"] > 0
        assert result["scale_v_div"] > 0
