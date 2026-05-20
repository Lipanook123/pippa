"""
PIPPA — core triage engine (Python port)
Pure functions only. No I/O, no side effects.
JavaScript counterpart: core/triage.js (keep in sync)

Function naming: snake_case mirrors camelCase in triage.js exactly.
"""

from __future__ import annotations
import math
from typing import Any

# ── Section 1: Constants ──────────────────────────────────────────────────────

class ROLE:
    PRIMARY       = "Primary"
    SUPPLEMENTARY = "Supplementary"
    IGNORED       = "Ignored"

class STATE:
    USE        = "USE"
    BORDERLINE = "BORDERLINE"
    MUST       = "MUST"
    MISSING    = "MISSING"

class DECISION:
    USE        = "Use as-is"
    BORDERLINE = "Borderline"
    MUST       = "Must cleanup or repeat"

VALID_ROLES = {ROLE.PRIMARY, ROLE.SUPPLEMENTARY, ROLE.IGNORED}

# ── Section 2: Default config (Standard preset values) ────────────────────────

DEFAULT_CONFIG: dict[str, Any] = {
    "conservatism":                0.5,
    "downstream_tolerance":        0.3,
    "role_nanodrop_conc":          ROLE.PRIMARY,
    "role_a260_280":               ROLE.PRIMARY,
    "role_a260_230":               ROLE.PRIMARY,
    "role_fluor_conc":             ROLE.IGNORED,
    "fluor_assay_label":           "Fluorescence",
    "nd_conc_must_threshold":      10,
    "nd_conc_borderline_threshold":20,
    "a280_must_threshold":         1.60,
    "a280_borderline_threshold":   1.70,
    "a280_upper_threshold":        2.20,
    "a230_must_threshold":         1.20,
    "a230_borderline_threshold":   1.60,
    "fl_conc_must_threshold":      10,
    "fl_conc_borderline_threshold":20,
    "conc_discrepancy_pct":        30,
}

# ── Section 3: Config loading / merging ──────────────────────────────────────

def load_config(partial: dict | None = None) -> dict:
    """Merge partial config over Standard defaults. Validates and returns full config."""
    config = {**DEFAULT_CONFIG, **(partial or {})}
    validate_config(config)
    return config


def validate_config(config: dict) -> None:
    """Raise ValueError on invalid config values."""
    for key in ("role_nanodrop_conc", "role_a260_280", "role_a260_230", "role_fluor_conc"):
        if config[key] not in VALID_ROLES:
            raise ValueError(
                f"Invalid role value for {key}: {config[key]!r}. "
                "Must be Primary, Supplementary, or Ignored."
            )
    if not (0 <= config["conservatism"] <= 1):
        raise ValueError(f"conservatism must be in [0, 1], got {config['conservatism']}")
    if not (0 <= config["downstream_tolerance"] <= 1):
        raise ValueError(f"downstream_tolerance must be in [0, 1], got {config['downstream_tolerance']}")
    roles = [config[k] for k in ("role_nanodrop_conc", "role_a260_280", "role_a260_230", "role_fluor_conc")]
    if ROLE.PRIMARY not in roles:
        raise ValueError("At least one metric must have role Primary.")

# ── Section 4: NetStrict and effective thresholds ─────────────────────────────

def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def compute_net_strict(config: dict) -> float:
    """NetStrict = clamp(conservatism − downstream_tolerance, −1, +1)"""
    return _clamp(config["conservatism"] - config["downstream_tolerance"], -1.0, 1.0)


def compute_effective_thresholds(config: dict) -> dict:
    """Apply NetStrict shifts to user-configured base thresholds."""
    ns = compute_net_strict(config)
    return {
        "nd_must":         config["nd_conc_must_threshold"]         + 5.0    * ns,
        "nd_borderline":   config["nd_conc_borderline_threshold"]   + 5.0    * ns,
        "a280_must":       config["a280_must_threshold"]            + 0.10   * ns,
        "a280_borderline": config["a280_borderline_threshold"]      + 0.10   * ns,
        "a280_upper":      config["a280_upper_threshold"],                          # unchanged
        "a230_must":       config["a230_must_threshold"]            + 0.25   * ns,
        "a230_borderline": config["a230_borderline_threshold"]      + 0.25   * ns,
        "fl_must":         config["fl_conc_must_threshold"]         + 5.0    * ns,
        "fl_borderline":   config["fl_conc_borderline_threshold"]   + 5.0    * ns,
    }

# ── Section 5: Per-metric classifiers ─────────────────────────────────────────

def _is_absent(v: Any) -> bool:
    if v is None:
        return True
    try:
        return math.isnan(float(v))
    except (TypeError, ValueError):
        return True


def classify_nd_conc(value: Any, thresholds: dict) -> dict:
    """Classify NanoDrop concentration. Returns {state, rationale}."""
    if _is_absent(value):
        return {"state": STATE.MISSING, "rationale": "NanoDrop concentration: no value provided."}
    v = float(value)
    if v < thresholds["nd_must"]:
        return {
            "state": STATE.MUST,
            "rationale": (
                f"NanoDrop concentration ({v:.1f} ng/µL) is below the must-cleanup threshold "
                f"({thresholds['nd_must']:.1f} ng/µL) — ratio interpretation unreliable at very low concentrations."
            ),
        }
    if v < thresholds["nd_borderline"]:
        return {
            "state": STATE.BORDERLINE,
            "rationale": (
                f"NanoDrop concentration ({v:.1f} ng/µL) is borderline "
                f"(threshold: {thresholds['nd_borderline']:.1f} ng/µL) — ratios may be less reliable; handle with care."
            ),
        }
    return {
        "state": STATE.USE,
        "rationale": f"NanoDrop concentration ({v:.1f} ng/µL) is acceptable.",
    }


def classify_a280(value: Any, thresholds: dict) -> dict:
    """Classify A260/A280. Returns {state, rationale, high_ratio_note}."""
    if _is_absent(value):
        return {"state": STATE.MISSING, "rationale": "A260/A280: no value provided.", "high_ratio_note": None}
    v = float(value)
    high_ratio_note = (
        f"A260/A280 ({v:.2f}) is above the upper bound ({thresholds['a280_upper']:.2f}) "
        "— possible RNA co-purification or baseline artefact."
        if v > thresholds["a280_upper"] else None
    )
    if v < thresholds["a280_must"]:
        return {
            "state": STATE.MUST,
            "rationale": (
                f"A260/A280 ({v:.2f}) is below the must-cleanup threshold "
                f"({thresholds['a280_must']:.2f}) — likely protein or phenol-type contamination."
            ),
            "high_ratio_note": high_ratio_note,
        }
    if v < thresholds["a280_borderline"]:
        return {
            "state": STATE.BORDERLINE,
            "rationale": (
                f"A260/A280 ({v:.2f}) is borderline (threshold: {thresholds['a280_borderline']:.2f}) "
                "— mild contamination possible."
            ),
            "high_ratio_note": high_ratio_note,
        }
    return {
        "state": STATE.USE,
        "rationale": f"A260/A280 ({v:.2f}) is acceptable.",
        "high_ratio_note": high_ratio_note,
    }


def classify_a230(value: Any, thresholds: dict) -> dict:
    """Classify A260/A230. Returns {state, rationale}."""
    if _is_absent(value):
        return {"state": STATE.MISSING, "rationale": "A260/A230: no value provided."}
    v = float(value)
    if v < thresholds["a230_must"]:
        return {
            "state": STATE.MUST,
            "rationale": (
                f"A260/A230 ({v:.2f}) is below the must-cleanup threshold "
                f"({thresholds['a230_must']:.2f}) — likely chaotropic salt or phenol carryover affecting downstream analysis."
            ),
        }
    if v < thresholds["a230_borderline"]:
        return {
            "state": STATE.BORDERLINE,
            "rationale": (
                f"A260/A230 ({v:.2f}) is borderline (threshold: {thresholds['a230_borderline']:.2f}) "
                "— elevated risk of reagent carryover; bead cleanup likely to rescue."
            ),
        }
    return {
        "state": STATE.USE,
        "rationale": f"A260/A230 ({v:.2f}) is acceptable.",
    }


def classify_fl_conc(value: Any, thresholds: dict, assay_label: str) -> dict:
    """Classify fluorescence concentration. Returns {state, rationale}."""
    label = assay_label or "Fluorescence"
    if _is_absent(value):
        return {"state": STATE.MISSING, "rationale": f"{label} concentration: no value provided."}
    v = float(value)
    if v < thresholds["fl_must"]:
        return {
            "state": STATE.MUST,
            "rationale": (
                f"{label} concentration ({v:.1f} ng/µL) is below the must-cleanup threshold "
                f"({thresholds['fl_must']:.1f} ng/µL) — insufficient material for reliable library preparation."
            ),
        }
    if v < thresholds["fl_borderline"]:
        return {
            "state": STATE.BORDERLINE,
            "rationale": (
                f"{label} concentration ({v:.1f} ng/µL) is borderline "
                f"(threshold: {thresholds['fl_borderline']:.1f} ng/µL) — consider concentrating before sequencing."
            ),
        }
    return {
        "state": STATE.USE,
        "rationale": f"{label} concentration ({v:.1f} ng/µL) is acceptable.",
    }

# ── Section 6: Hierarchical combination ──────────────────────────────────────

def classify_metrics(metrics: dict, config: dict, thresholds: dict) -> dict:
    """
    Classify all four metrics for one sample.
    Ignored metrics are excluded from the returned dict.
    Returns: { metric_key: { state, rationale, role, ... } }
    """
    roles = {
        "nd_conc":  config["role_nanodrop_conc"],
        "a260_280": config["role_a260_280"],
        "a260_230": config["role_a260_230"],
        "fl_conc":  config["role_fluor_conc"],
    }
    result = {}
    for key, role in roles.items():
        if role == ROLE.IGNORED:
            continue
        if key == "nd_conc":
            classified = classify_nd_conc(metrics.get("nd_conc"), thresholds)
        elif key == "a260_280":
            classified = classify_a280(metrics.get("a260_280"), thresholds)
        elif key == "a260_230":
            classified = classify_a230(metrics.get("a260_230"), thresholds)
        elif key == "fl_conc":
            classified = classify_fl_conc(metrics.get("fl_conc"), thresholds, config["fluor_assay_label"])
        result[key] = {**classified, "role": role}
    return result


def combine_decision(classified: dict) -> dict:
    """
    Apply five-rule hierarchy to Primary metrics.
    Returns { decision, primary_rationale: list[str] }
    """
    primary = [(k, m) for k, m in classified.items() if m["role"] == ROLE.PRIMARY]

    # Rule 0: no primary metrics, or all MISSING
    all_missing = all(m["state"] == STATE.MISSING for _, m in primary)
    if not primary or all_missing:
        return {
            "decision": DECISION.USE,
            "primary_rationale": ["No primary metrics were provided; no quality assessment performed."],
        }

    primary_with_values = [(k, m) for k, m in primary if m["state"] != STATE.MISSING]

    # Rule 1: concentration MUST
    conc_must = next(
        ((k, m) for k, m in primary_with_values if k in ("nd_conc", "fl_conc") and m["state"] == STATE.MUST),
        None,
    )
    if conc_must:
        return {
            "decision": DECISION.MUST,
            "primary_rationale": [conc_must[1]["rationale"], "Ratio interpretation is unreliable at low concentration."],
        }

    # Rule 2: A260/A230 MUST
    a230_must = next((m for k, m in primary_with_values if k == "a260_230" and m["state"] == STATE.MUST), None)
    if a230_must:
        return {"decision": DECISION.MUST, "primary_rationale": [a230_must["rationale"]]}

    # Rule 3: A260/A280 MUST
    a280_must = next((m for k, m in primary_with_values if k == "a260_280" and m["state"] == STATE.MUST), None)
    if a280_must:
        return {"decision": DECISION.MUST, "primary_rationale": [a280_must["rationale"]]}

    # Rule 4: any BORDERLINE
    borderline = [m for _, m in primary_with_values if m["state"] == STATE.BORDERLINE]
    if borderline:
        return {"decision": DECISION.BORDERLINE, "primary_rationale": [m["rationale"] for m in borderline]}

    # Rule 5: all USE
    return {
        "decision": DECISION.USE,
        "primary_rationale": [m["rationale"] for _, m in primary_with_values],
    }

# ── Section 7: Supplementary warnings ────────────────────────────────────────

def build_supplementary_warnings(classified: dict) -> list[str]:
    """Return advisory warning strings for Supplementary metrics in MUST or BORDERLINE state."""
    warnings = []
    for m in classified.values():
        if m["role"] != ROLE.SUPPLEMENTARY:
            continue
        if m["state"] == STATE.MISSING:
            continue
        if m["state"] == STATE.MUST:
            prefix = m["rationale"].split("(")[0].strip()
            warnings.append(
                f"{prefix} — note for your records (advisory only; has not changed the overall decision)."
            )
        elif m["state"] == STATE.BORDERLINE:
            warnings.append(f"Advisory: {m['rationale']}")
    # Surface A260/A280 high-ratio notes from any active metric
    for m in classified.values():
        if m.get("high_ratio_note"):
            warnings.append(m["high_ratio_note"])
    return warnings

# ── Section 8: Concentration discrepancy ─────────────────────────────────────

def check_conc_discrepancy(metrics: dict, config: dict) -> dict:
    """
    Check if NanoDrop and fluorescence concentrations differ by more than conc_discrepancy_pct.
    Both metrics must be active (Primary or Supplementary).
    Returns { flagged: bool, rationale: str|None }
    """
    nd_role = config["role_nanodrop_conc"]
    fl_role = config["role_fluor_conc"]
    nd_active = nd_role in (ROLE.PRIMARY, ROLE.SUPPLEMENTARY)
    fl_active = fl_role in (ROLE.PRIMARY, ROLE.SUPPLEMENTARY)
    if not nd_active or not fl_active:
        return {"flagged": False, "rationale": None}

    try:
        nd = float(metrics.get("nd_conc"))
        fl = float(metrics.get("fl_conc"))
    except (TypeError, ValueError):
        return {"flagged": False, "rationale": None}

    if not (math.isfinite(nd) and math.isfinite(fl)):
        return {"flagged": False, "rationale": None}

    max_val = max(nd, fl)
    if max_val == 0:
        return {"flagged": False, "rationale": None}

    pct = abs(nd - fl) / max_val * 100
    if pct > config["conc_discrepancy_pct"]:
        label = config["fluor_assay_label"] or "Fluorescence"
        return {
            "flagged": True,
            "rationale": (
                f"NanoDrop ({nd:.1f} ng/µL) and {label} ({fl:.1f} ng/µL) concentrations "
                f"differ by {pct:.0f}% — possible UV-absorbing contamination, RNA co-purification, or DNA degradation."
            ),
        }
    return {"flagged": False, "rationale": None}

# ── Section 9: Output assembly ────────────────────────────────────────────────

_ACTIONS = {
    DECISION.USE:       "Proceed to library preparation.",
    DECISION.BORDERLINE:"Consider bead or column cleanup before library preparation; re-measure after cleanup to confirm quality.",
    DECISION.MUST:      "Do not proceed. Perform bead or column cleanup (or repeat extraction), then re-measure. If the sample fails again, consider a fresh extraction.",
}


def generate_output(
    decision: str,
    primary_rationale: list[str],
    supplementary_warnings: list[str],
    discrepancy: dict,
) -> dict:
    """Compose the final three output columns."""
    parts = list(primary_rationale)
    parts.extend(supplementary_warnings)
    if discrepancy["flagged"] and discrepancy["rationale"]:
        parts.append(discrepancy["rationale"])

    action = _ACTIONS[decision]
    if decision == DECISION.BORDERLINE:
        context = " ".join(primary_rationale)
        if "A260/A230" in context:
            action = "Bead or column cleanup recommended (target: reagent carryover); re-measure before proceeding."
        elif "A260/A280" in context:
            action = "Cleanup recommended if possible; otherwise proceed with caution and flag for review."
        elif "concentration" in context:
            action = "Consider concentrating or re-quantifying; proceed only if you can normalise confidently."

    return {
        "decision": decision,
        "rationale": " ".join(parts),
        "recommended_action": action,
    }

# ── Section 10: Top-level entry points ───────────────────────────────────────

def triage_sample(raw_metrics: dict, config: dict) -> dict:
    """
    Run the full triage algorithm for one sample.

    Args:
        raw_metrics: { nd_conc, a260_280, a260_230, fl_conc } (each float or None)
        config:      result of load_config()

    Returns:
        { decision: str, rationale: str, recommended_action: str }
    """
    thresholds = compute_effective_thresholds(config)
    classified = classify_metrics(raw_metrics, config, thresholds)
    combined = combine_decision(classified)
    warnings = build_supplementary_warnings(classified)
    discrepancy = check_conc_discrepancy(raw_metrics, config)
    return generate_output(combined["decision"], combined["primary_rationale"], warnings, discrepancy)


def triage_all(rows: list[dict], config: dict) -> list[dict]:
    """Run triage_sample on a list of metric dicts."""
    return [triage_sample(row, config) for row in rows]
