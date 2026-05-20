"""
PIPPA core triage engine — pytest test suite
Run: cd /home/user/pippa && python -m pytest tests/test_triage.py -v

Mirrors test_triage.js test-for-test using the same fixture data.
"""

import json
import math
import pathlib
import pytest

from core.triage import (
    ROLE, STATE, DECISION,
    DEFAULT_CONFIG,
    load_config, validate_config,
    compute_net_strict, compute_effective_thresholds,
    classify_nd_conc, classify_a280, classify_a230, classify_fl_conc,
    classify_metrics,
    combine_decision,
    build_supplementary_warnings,
    check_conc_discrepancy,
    triage_sample,
    triage_all,
)

FIXTURES_PATH = pathlib.Path(__file__).parent / "fixtures" / "sample_rows.json"
FIXTURES = json.loads(FIXTURES_PATH.read_text())

APPROX = pytest.approx  # shorthand


# ── load_config / validate_config ─────────────────────────────────────────────

class TestLoadConfig:
    def test_empty_partial_returns_standard_defaults(self):
        c = load_config()
        assert c["conservatism"] == 0.5
        assert c["downstream_tolerance"] == 0.3
        assert c["role_nanodrop_conc"] == ROLE.PRIMARY
        assert c["role_fluor_conc"] == ROLE.IGNORED

    def test_partial_override_merges_correctly(self):
        c = load_config({"conservatism": 0.8})
        assert c["conservatism"] == 0.8
        assert c["downstream_tolerance"] == 0.3  # unchanged

    def test_invalid_role_raises(self):
        with pytest.raises(ValueError, match="Invalid role"):
            load_config({"role_a260_280": "Optional"})

    def test_no_primary_metrics_raises(self):
        with pytest.raises(ValueError, match="Primary"):
            load_config({
                "role_nanodrop_conc": ROLE.IGNORED,
                "role_a260_280":      ROLE.IGNORED,
                "role_a260_230":      ROLE.IGNORED,
                "role_fluor_conc":    ROLE.IGNORED,
            })

    def test_conservatism_out_of_range_raises(self):
        with pytest.raises(ValueError, match="conservatism"):
            load_config({"conservatism": 1.5})

    def test_tolerance_out_of_range_raises(self):
        with pytest.raises(ValueError, match="downstream_tolerance"):
            load_config({"downstream_tolerance": -0.1})


# ── compute_net_strict ────────────────────────────────────────────────────────

class TestNetStrict:
    def test_standard(self):
        assert compute_net_strict(load_config()) == APPROX(0.2, abs=1e-10)

    def test_research(self):
        assert compute_net_strict(load_config({"conservatism": 0.2, "downstream_tolerance": 0.6})) == APPROX(-0.4, abs=1e-10)

    def test_service_lab(self):
        assert compute_net_strict(load_config({"conservatism": 0.8, "downstream_tolerance": 0.1})) == APPROX(0.7, abs=1e-10)

    def test_clamp_positive(self):
        assert compute_net_strict(load_config({"conservatism": 1.0, "downstream_tolerance": 0.0})) == 1.0

    def test_clamp_negative(self):
        assert compute_net_strict(load_config({"conservatism": 0.0, "downstream_tolerance": 1.0})) == -1.0


# ── compute_effective_thresholds ──────────────────────────────────────────────

class TestEffectiveThresholds:
    def test_ns_zero_leaves_thresholds_unchanged(self):
        config = load_config({"conservatism": 0.5, "downstream_tolerance": 0.5})  # NS=0
        t = compute_effective_thresholds(config)
        assert t["nd_must"] == APPROX(10, abs=1e-10)
        assert t["a230_borderline"] == APPROX(1.60, abs=1e-10)
        assert t["a280_must"] == APPROX(1.60, abs=1e-10)

    def test_ns_plus1_full_shift(self):
        config = load_config({"conservatism": 1.0, "downstream_tolerance": 0.0})
        t = compute_effective_thresholds(config)
        assert t["nd_must"] == APPROX(15, abs=1e-10)
        assert t["a230_must"] == APPROX(1.45, abs=1e-10)
        assert t["a280_borderline"] == APPROX(1.80, abs=1e-10)

    def test_ns_minus1_full_shift(self):
        config = load_config({"conservatism": 0.0, "downstream_tolerance": 1.0})
        t = compute_effective_thresholds(config)
        assert t["nd_must"] == APPROX(5, abs=1e-10)
        assert t["a230_borderline"] == APPROX(1.35, abs=1e-10)

    def test_a280_upper_never_shifts(self):
        config = load_config({"conservatism": 1.0, "downstream_tolerance": 0.0})
        t = compute_effective_thresholds(config)
        assert t["a280_upper"] == APPROX(2.20, abs=1e-10)


# ── classify_nd_conc ──────────────────────────────────────────────────────────

class TestClassifyNdConc:
    def setup_method(self):
        self.t = compute_effective_thresholds(load_config())

    def test_none_is_missing(self):
        assert classify_nd_conc(None, self.t)["state"] == STATE.MISSING

    def test_nan_is_missing(self):
        assert classify_nd_conc(float("nan"), self.t)["state"] == STATE.MISSING

    def test_below_must(self):
        assert classify_nd_conc(5, self.t)["state"] == STATE.MUST

    def test_at_must_boundary_is_borderline(self):
        t = compute_effective_thresholds(load_config({"conservatism": 0.5, "downstream_tolerance": 0.5}))
        assert classify_nd_conc(9.999, t)["state"] == STATE.MUST
        assert classify_nd_conc(10, t)["state"] == STATE.BORDERLINE

    def test_borderline_range(self):
        assert classify_nd_conc(15, self.t)["state"] == STATE.BORDERLINE

    def test_acceptable(self):
        assert classify_nd_conc(85, self.t)["state"] == STATE.USE

    def test_rationale_contains_value(self):
        r = classify_nd_conc(5, self.t)
        assert "5.0" in r["rationale"]


# ── classify_a280 ─────────────────────────────────────────────────────────────

class TestClassifyA280:
    def setup_method(self):
        self.t = compute_effective_thresholds(load_config())

    def test_none_is_missing(self):
        assert classify_a280(None, self.t)["state"] == STATE.MISSING

    def test_below_must(self):
        assert classify_a280(1.50, self.t)["state"] == STATE.MUST

    def test_borderline_range(self):
        t = compute_effective_thresholds(load_config({"conservatism": 0.5, "downstream_tolerance": 0.5}))
        assert classify_a280(1.65, t)["state"] == STATE.BORDERLINE

    def test_acceptable(self):
        assert classify_a280(1.85, self.t)["state"] == STATE.USE

    def test_above_upper_bound_is_use_with_note(self):
        r = classify_a280(2.50, self.t)
        assert r["state"] == STATE.USE
        assert r["high_ratio_note"] is not None
        assert "upper bound" in r["high_ratio_note"]

    def test_within_range_no_high_ratio_note(self):
        r = classify_a280(1.85, self.t)
        assert r["high_ratio_note"] is None


# ── classify_a230 ─────────────────────────────────────────────────────────────

class TestClassifyA230:
    def setup_method(self):
        self.t = compute_effective_thresholds(load_config())

    def test_none_is_missing(self):
        assert classify_a230(None, self.t)["state"] == STATE.MISSING

    def test_below_must(self):
        assert classify_a230(1.05, self.t)["state"] == STATE.MUST

    def test_borderline_range(self):
        t = compute_effective_thresholds(load_config({"conservatism": 0.5, "downstream_tolerance": 0.5}))
        assert classify_a230(1.40, t)["state"] == STATE.BORDERLINE

    def test_acceptable(self):
        assert classify_a230(2.10, self.t)["state"] == STATE.USE


# ── classify_fl_conc ──────────────────────────────────────────────────────────

class TestClassifyFlConc:
    def setup_method(self):
        self.t = compute_effective_thresholds(load_config())

    def test_none_is_missing(self):
        assert classify_fl_conc(None, self.t, "Qubit")["state"] == STATE.MISSING

    def test_uses_assay_label(self):
        r = classify_fl_conc(5, self.t, "Qubit")
        assert "Qubit" in r["rationale"]

    def test_below_must(self):
        assert classify_fl_conc(4, self.t, "Qubit")["state"] == STATE.MUST

    def test_acceptable(self):
        assert classify_fl_conc(50, self.t, "Qubit")["state"] == STATE.USE


# ── combine_decision ──────────────────────────────────────────────────────────

class TestCombineDecision:
    def _classify(self, metrics, override=None):
        config = load_config(override or {})
        thresholds = compute_effective_thresholds(config)
        return classify_metrics(metrics, config, thresholds)

    def test_rule_1_conc_must(self):
        classified = self._classify({"nd_conc": 5, "a260_280": 1.82, "a260_230": 2.10, "fl_conc": None})
        assert combine_decision(classified)["decision"] == DECISION.MUST

    def test_rule_2_a230_must(self):
        classified = self._classify({"nd_conc": 85, "a260_280": 1.82, "a260_230": 1.05, "fl_conc": None})
        assert combine_decision(classified)["decision"] == DECISION.MUST

    def test_rule_3_a280_must(self):
        classified = self._classify({"nd_conc": 85, "a260_280": 1.42, "a260_230": 2.10, "fl_conc": None})
        assert combine_decision(classified)["decision"] == DECISION.MUST

    def test_rule_4_borderline(self):
        classified = self._classify({"nd_conc": 85, "a260_280": 1.82, "a260_230": 1.40, "fl_conc": None})
        assert combine_decision(classified)["decision"] == DECISION.BORDERLINE

    def test_rule_5_all_use(self):
        classified = self._classify({"nd_conc": 85, "a260_280": 1.82, "a260_230": 2.10, "fl_conc": None})
        assert combine_decision(classified)["decision"] == DECISION.USE

    def test_rule_0_all_missing(self):
        classified = self._classify({"nd_conc": None, "a260_280": None, "a260_230": None, "fl_conc": None})
        result = combine_decision(classified)
        assert result["decision"] == DECISION.USE
        assert "No primary metrics" in result["primary_rationale"][0]

    def test_supplementary_must_does_not_change_decision(self):
        classified = self._classify(
            {"nd_conc": 5, "a260_280": 1.82, "a260_230": 2.10, "fl_conc": None},
            override={"role_nanodrop_conc": ROLE.SUPPLEMENTARY, "role_a260_280": ROLE.PRIMARY,
                      "role_a260_230": ROLE.PRIMARY, "role_fluor_conc": ROLE.IGNORED},
        )
        assert combine_decision(classified)["decision"] == DECISION.USE


# ── check_conc_discrepancy ────────────────────────────────────────────────────

class TestConcDiscrepancy:
    def test_both_ignored_not_flagged(self):
        config = load_config()
        result = check_conc_discrepancy({"nd_conc": 100, "fl_conc": 50}, config)
        assert result["flagged"] is False

    def test_over_threshold_flagged(self):
        config = load_config({
            "role_nanodrop_conc": ROLE.SUPPLEMENTARY,
            "role_fluor_conc": ROLE.PRIMARY,
            "role_a260_280": ROLE.PRIMARY,
            "role_a260_230": ROLE.PRIMARY,
        })
        result = check_conc_discrepancy({"nd_conc": 100, "fl_conc": 50}, config)
        assert result["flagged"] is True
        assert "differ by" in result["rationale"]

    def test_within_threshold_not_flagged(self):
        config = load_config({
            "role_nanodrop_conc": ROLE.SUPPLEMENTARY,
            "role_fluor_conc": ROLE.PRIMARY,
            "role_a260_280": ROLE.PRIMARY,
            "role_a260_230": ROLE.PRIMARY,
        })
        result = check_conc_discrepancy({"nd_conc": 85, "fl_conc": 75}, config)
        assert result["flagged"] is False

    def test_missing_value_not_flagged(self):
        config = load_config({
            "role_nanodrop_conc": ROLE.SUPPLEMENTARY,
            "role_fluor_conc": ROLE.PRIMARY,
            "role_a260_280": ROLE.PRIMARY,
            "role_a260_230": ROLE.PRIMARY,
        })
        result = check_conc_discrepancy({"nd_conc": None, "fl_conc": 50}, config)
        assert result["flagged"] is False


# ── triage_sample integration ─────────────────────────────────────────────────

class TestTriageSample:
    def test_all_good_use_as_is(self):
        config = load_config()
        result = triage_sample({"nd_conc": 150, "a260_280": 1.82, "a260_230": 2.10, "fl_conc": None}, config)
        assert result["decision"] == DECISION.USE

    def test_a230_contamination_must(self):
        config = load_config()
        result = triage_sample({"nd_conc": 85, "a260_280": 1.82, "a260_230": 1.05, "fl_conc": None}, config)
        assert result["decision"] == DECISION.MUST
        assert "A260/A230" in result["rationale"]

    def test_borderline_concentration(self):
        config = load_config()
        result = triage_sample({"nd_conc": 15, "a260_280": 1.82, "a260_230": 2.10, "fl_conc": None}, config)
        assert result["decision"] == DECISION.BORDERLINE

    def test_output_has_all_three_keys(self):
        config = load_config()
        result = triage_sample({"nd_conc": 85, "a260_280": 1.82, "a260_230": 2.10, "fl_conc": None}, config)
        assert "decision" in result
        assert "rationale" in result
        assert "recommended_action" in result

    def test_triage_all_returns_list(self):
        config = load_config()
        rows = [
            {"nd_conc": 85, "a260_280": 1.82, "a260_230": 2.10, "fl_conc": None},
            {"nd_conc": 5,  "a260_280": 1.82, "a260_230": 2.10, "fl_conc": None},
        ]
        results = triage_all(rows, config)
        assert len(results) == 2
        assert results[0]["decision"] == DECISION.USE
        assert results[1]["decision"] == DECISION.MUST


# ── Fixture-driven parity tests ───────────────────────────────────────────────

class TestFixtureParity:
    @pytest.mark.parametrize("fx", FIXTURES, ids=[f["id"] for f in FIXTURES])
    def test_fixture(self, fx):
        config = load_config(fx.get("config_override") or {})
        result = triage_sample(fx["input"], config)
        expected = fx["expected"]

        if "decision" in expected:
            assert result["decision"] == expected["decision"], (
                f"{fx['id']}: expected decision={expected['decision']!r}, got {result['decision']!r}"
            )
        for needle in expected.get("rationale_includes", []):
            assert needle in result["rationale"], (
                f"{fx['id']}: expected rationale to include {needle!r}\n  Got: {result['rationale']!r}"
            )
        for needle in expected.get("rationale_not_includes", []):
            assert needle not in result["rationale"], (
                f"{fx['id']}: expected rationale NOT to include {needle!r}"
            )
