/**
 * PIPPA — core triage engine
 * Pure functions only. No DOM access, no imports, no side effects.
 * Python counterpart: core/triage.py (keep in sync)
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 David Walker — https://github.com/Lipanook123/pippa
 */

// ── Section 1: Constants ──────────────────────────────────────────────────────

const ROLE = Object.freeze({
  PRIMARY:      'Primary',
  SUPPLEMENTARY: 'Supplementary',
  IGNORED:      'Ignored',
});

const STATE = Object.freeze({
  USE:        'USE',
  BORDERLINE: 'BORDERLINE',
  MUST:       'MUST',
  MISSING:    'MISSING',   // internal sentinel for null/undefined/NaN inputs
});

const DECISION = Object.freeze({
  USE:       'Use as-is',
  BORDERLINE: 'Borderline',
  MUST:      'Must cleanup or repeat',
});

// ── Section 2: Default config (Standard preset values) ────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  conservatism:               0.5,
  downstream_tolerance:       0.3,
  role_nanodrop_conc:         ROLE.PRIMARY,
  role_a260_280:              ROLE.PRIMARY,
  role_a260_230:              ROLE.PRIMARY,
  role_fluor_conc:            ROLE.IGNORED,
  fluor_assay_label:          'Fluorescence',
  nd_conc_must_threshold:     10,
  nd_conc_borderline_threshold: 20,
  a280_must_threshold:        1.60,
  a280_borderline_threshold:  1.70,
  a280_upper_threshold:       2.20,
  a230_must_threshold:        1.20,
  a230_borderline_threshold:  1.60,
  fl_conc_must_threshold:     10,
  fl_conc_borderline_threshold: 20,
  conc_discrepancy_pct:       30,
});

const VALID_ROLES = new Set(Object.values(ROLE));

// ── Section 3: Config loading / merging ──────────────────────────────────────

/**
 * Merge a partial config over the Standard defaults.
 * Returns a fully-populated, validated config object.
 * Throws on invalid role values or out-of-range tuning knobs.
 */
function loadConfig(partial = {}) {
  const config = Object.assign({}, DEFAULT_CONFIG, partial);
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  for (const key of ['role_nanodrop_conc', 'role_a260_280', 'role_a260_230', 'role_fluor_conc']) {
    if (!VALID_ROLES.has(config[key])) {
      throw new Error(`Invalid role value for ${key}: "${config[key]}". Must be Primary, Supplementary, or Ignored.`);
    }
  }
  if (config.conservatism < 0 || config.conservatism > 1) {
    throw new Error(`conservatism must be in [0, 1], got ${config.conservatism}`);
  }
  if (config.downstream_tolerance < 0 || config.downstream_tolerance > 1) {
    throw new Error(`downstream_tolerance must be in [0, 1], got ${config.downstream_tolerance}`);
  }
  const hasPrimary = [
    config.role_nanodrop_conc,
    config.role_a260_280,
    config.role_a260_230,
    config.role_fluor_conc,
  ].some(r => r === ROLE.PRIMARY);
  if (!hasPrimary) {
    throw new Error('At least one metric must have role Primary.');
  }
}

// ── Section 4: NetStrict and effective thresholds ─────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * NetStrict = clamp(conservatism − downstream_tolerance, −1, +1)
 * Positive → stricter; Negative → more permissive.
 */
function computeNetStrict(config) {
  return clamp(config.conservatism - config.downstream_tolerance, -1, 1);
}

/**
 * Apply NetStrict shifts to the user-configured base thresholds.
 * Returns effective threshold values for all four metrics.
 */
function computeEffectiveThresholds(config) {
  const ns = computeNetStrict(config);
  return {
    nd_must:        config.nd_conc_must_threshold        + 5    * ns,
    nd_borderline:  config.nd_conc_borderline_threshold  + 5    * ns,
    a280_must:      config.a280_must_threshold           + 0.10 * ns,
    a280_borderline:config.a280_borderline_threshold     + 0.10 * ns,
    a280_upper:     config.a280_upper_threshold,                       // unchanged
    a230_must:      config.a230_must_threshold           + 0.25 * ns,
    a230_borderline:config.a230_borderline_threshold     + 0.25 * ns,
    fl_must:        config.fl_conc_must_threshold        + 5    * ns,
    fl_borderline:  config.fl_conc_borderline_threshold  + 5    * ns,
  };
}

// ── Section 5: Per-metric classifiers ─────────────────────────────────────────

function isAbsent(v) {
  return v === null || v === undefined || (typeof v === 'number' && isNaN(v));
}

/**
 * Classify NanoDrop concentration.
 * Returns { state, rationale }
 */
function classifyNdConc(value, thresholds) {
  if (isAbsent(value)) {
    return { state: STATE.MISSING, rationale: 'NanoDrop concentration: no value provided.' };
  }
  const v = Number(value);
  if (v < thresholds.nd_must) {
    return {
      state: STATE.MUST,
      rationale: `NanoDrop concentration (${v.toFixed(1)} ng/µL) is below the must-cleanup threshold (${thresholds.nd_must.toFixed(1)} ng/µL) — ratio interpretation unreliable at very low concentrations.`,
    };
  }
  if (v < thresholds.nd_borderline) {
    return {
      state: STATE.BORDERLINE,
      rationale: `NanoDrop concentration (${v.toFixed(1)} ng/µL) is borderline (threshold: ${thresholds.nd_borderline.toFixed(1)} ng/µL) — ratios may be less reliable; handle with care.`,
    };
  }
  return {
    state: STATE.USE,
    rationale: `NanoDrop concentration (${v.toFixed(1)} ng/µL) is acceptable.`,
  };
}

/**
 * Classify A260/A280.
 * Returns { state, rationale, highRatioNote }
 */
function classifyA280(value, thresholds) {
  if (isAbsent(value)) {
    return { state: STATE.MISSING, rationale: 'A260/A280: no value provided.', highRatioNote: null };
  }
  const v = Number(value);
  const highRatioNote = v > thresholds.a280_upper
    ? `A260/A280 (${v.toFixed(2)}) is above the upper bound (${thresholds.a280_upper.toFixed(2)}) — possible RNA co-purification or baseline artefact.`
    : null;

  if (v < thresholds.a280_must) {
    return {
      state: STATE.MUST,
      rationale: `A260/A280 (${v.toFixed(2)}) is below the must-cleanup threshold (${thresholds.a280_must.toFixed(2)}) — likely protein or phenol-type contamination.`,
      highRatioNote,
    };
  }
  if (v < thresholds.a280_borderline) {
    return {
      state: STATE.BORDERLINE,
      rationale: `A260/A280 (${v.toFixed(2)}) is borderline (threshold: ${thresholds.a280_borderline.toFixed(2)}) — mild contamination possible.`,
      highRatioNote,
    };
  }
  return {
    state: STATE.USE,
    rationale: `A260/A280 (${v.toFixed(2)}) is acceptable.`,
    highRatioNote,
  };
}

/**
 * Classify A260/A230.
 * Returns { state, rationale }
 */
function classifyA230(value, thresholds) {
  if (isAbsent(value)) {
    return { state: STATE.MISSING, rationale: 'A260/A230: no value provided.' };
  }
  const v = Number(value);
  if (v < thresholds.a230_must) {
    return {
      state: STATE.MUST,
      rationale: `A260/A230 (${v.toFixed(2)}) is below the must-cleanup threshold (${thresholds.a230_must.toFixed(2)}) — likely chaotropic salt or phenol carryover affecting downstream analysis.`,
    };
  }
  if (v < thresholds.a230_borderline) {
    return {
      state: STATE.BORDERLINE,
      rationale: `A260/A230 (${v.toFixed(2)}) is borderline (threshold: ${thresholds.a230_borderline.toFixed(2)}) — elevated risk of reagent carryover; bead cleanup likely to rescue.`,
    };
  }
  return {
    state: STATE.USE,
    rationale: `A260/A230 (${v.toFixed(2)}) is acceptable.`,
  };
}

/**
 * Classify fluorescence-derived concentration.
 * Returns { state, rationale }
 */
function classifyFlConc(value, thresholds, assayLabel) {
  const label = assayLabel || 'Fluorescence';
  if (isAbsent(value)) {
    return { state: STATE.MISSING, rationale: `${label} concentration: no value provided.` };
  }
  const v = Number(value);
  if (v < thresholds.fl_must) {
    return {
      state: STATE.MUST,
      rationale: `${label} concentration (${v.toFixed(1)} ng/µL) is below the must-cleanup threshold (${thresholds.fl_must.toFixed(1)} ng/µL) — insufficient material for reliable library preparation.`,
    };
  }
  if (v < thresholds.fl_borderline) {
    return {
      state: STATE.BORDERLINE,
      rationale: `${label} concentration (${v.toFixed(1)} ng/µL) is borderline (threshold: ${thresholds.fl_borderline.toFixed(1)} ng/µL) — consider concentrating before sequencing.`,
    };
  }
  return {
    state: STATE.USE,
    rationale: `${label} concentration (${v.toFixed(1)} ng/µL) is acceptable.`,
  };
}

// ── Section 6: Hierarchical combination (Primary metrics only) ────────────────

/**
 * Classify all four metrics for one sample.
 * Metrics with role Ignored are excluded from the returned map.
 *
 * @param {object} metrics - { nd_conc, a260_280, a260_230, fl_conc } (each number|null)
 * @param {object} config  - full config object
 * @param {object} thresholds - result of computeEffectiveThresholds(config)
 * @returns {object} map of metricKey → { state, rationale, role, highRatioNote? }
 */
function classifyMetrics(metrics, config, thresholds) {
  const roles = {
    nd_conc:  config.role_nanodrop_conc,
    a260_280: config.role_a260_280,
    a260_230: config.role_a260_230,
    fl_conc:  config.role_fluor_conc,
  };
  const result = {};
  for (const [key, role] of Object.entries(roles)) {
    if (role === ROLE.IGNORED) continue;
    let classified;
    switch (key) {
      case 'nd_conc':  classified = classifyNdConc(metrics.nd_conc, thresholds);  break;
      case 'a260_280': classified = classifyA280(metrics.a260_280, thresholds);    break;
      case 'a260_230': classified = classifyA230(metrics.a260_230, thresholds);    break;
      case 'fl_conc':  classified = classifyFlConc(metrics.fl_conc, thresholds, config.fluor_assay_label); break;
    }
    result[key] = Object.assign({ role }, classified);
  }
  return result;
}

/**
 * Apply the five-rule hierarchical combination to Primary metrics.
 * Returns { decision, primaryRationale[] }
 */
function combineDecision(classified) {
  const primary = Object.entries(classified).filter(([, m]) => m.role === ROLE.PRIMARY);

  // Rule 0: no Primary metrics have values (all MISSING)
  const allMissing = primary.every(([, m]) => m.state === STATE.MISSING);
  if (primary.length === 0 || allMissing) {
    return {
      decision: DECISION.USE,
      primaryRationale: ['No primary metrics were provided; no quality assessment performed.'],
    };
  }

  const primaryWithValues = primary.filter(([, m]) => m.state !== STATE.MISSING);

  // Rule 1: concentration MUST (nd_conc or fl_conc)
  const concMust = primaryWithValues.find(
    ([k, m]) => (k === 'nd_conc' || k === 'fl_conc') && m.state === STATE.MUST
  );
  if (concMust) {
    return {
      decision: DECISION.MUST,
      primaryRationale: [concMust[1].rationale, 'Ratio interpretation is unreliable at low concentration.'],
    };
  }

  // Rule 2: A260/A230 MUST
  const a230Must = primaryWithValues.find(([k, m]) => k === 'a260_230' && m.state === STATE.MUST);
  if (a230Must) {
    return {
      decision: DECISION.MUST,
      primaryRationale: [a230Must[1].rationale],
    };
  }

  // Rule 3: A260/A280 MUST
  const a280Must = primaryWithValues.find(([k, m]) => k === 'a260_280' && m.state === STATE.MUST);
  if (a280Must) {
    return {
      decision: DECISION.MUST,
      primaryRationale: [a280Must[1].rationale],
    };
  }

  // Rule 4: any Primary BORDERLINE
  const anyBorderline = primaryWithValues.filter(([, m]) => m.state === STATE.BORDERLINE);
  if (anyBorderline.length > 0) {
    return {
      decision: DECISION.BORDERLINE,
      primaryRationale: anyBorderline.map(([, m]) => m.rationale),
    };
  }

  // Rule 5: all Primary USE (or MISSING treated as neutral)
  return {
    decision: DECISION.USE,
    primaryRationale: primaryWithValues.map(([, m]) => m.rationale),
  };
}

// ── Section 7: Supplementary warnings ─────────────────────────────────────────

function buildSupplementaryWarnings(classified) {
  const warnings = [];
  for (const [, m] of Object.entries(classified)) {
    if (m.role !== ROLE.SUPPLEMENTARY) continue;
    if (m.state === STATE.MISSING) continue;
    if (m.state === STATE.MUST) {
      warnings.push(`${m.rationale.split('(')[0].trim()} — note for your records (advisory only; has not changed the overall decision).`);
    } else if (m.state === STATE.BORDERLINE) {
      warnings.push(`Advisory: ${m.rationale}`);
    }
  }
  // Collect A260/A280 high-ratio notes from any active metric
  for (const [, m] of Object.entries(classified)) {
    if (m.highRatioNote) warnings.push(m.highRatioNote);
  }
  return warnings;
}

// ── Section 8: Concentration discrepancy ─────────────────────────────────────

/**
 * Check discrepancy between NanoDrop and fluorescence concentrations.
 * Both metrics must be active (Primary or Supplementary) and have values.
 * Returns { flagged: bool, rationale: string|null }
 */
function checkConcDiscrepancy(metrics, config) {
  const ndRole = config.role_nanodrop_conc;
  const flRole = config.role_fluor_conc;
  const ndActive = ndRole === ROLE.PRIMARY || ndRole === ROLE.SUPPLEMENTARY;
  const flActive = flRole === ROLE.PRIMARY || flRole === ROLE.SUPPLEMENTARY;
  if (!ndActive || !flActive) return { flagged: false, rationale: null };

  const nd = Number(metrics.nd_conc);
  const fl = Number(metrics.fl_conc);
  if (!isFinite(nd) || !isFinite(fl)) return { flagged: false, rationale: null };

  const maxVal = Math.max(nd, fl);
  if (maxVal === 0) return { flagged: false, rationale: null };

  const pct = Math.abs(nd - fl) / maxVal * 100;
  if (pct > config.conc_discrepancy_pct) {
    const label = config.fluor_assay_label || 'Fluorescence';
    return {
      flagged: true,
      rationale: `NanoDrop (${nd.toFixed(1)} ng/µL) and ${label} (${fl.toFixed(1)} ng/µL) concentrations differ by ${pct.toFixed(0)}% — possible UV-absorbing contamination, RNA co-purification, or DNA degradation.`,
    };
  }
  return { flagged: false, rationale: null };
}

// ── Section 9: Output assembly ────────────────────────────────────────────────

const ACTION = Object.freeze({
  [DECISION.USE]:       'Proceed to library preparation.',
  [DECISION.BORDERLINE]:'Consider bead or column cleanup before library preparation; re-measure after cleanup to confirm quality.',
  [DECISION.MUST]:      'Do not proceed. Perform bead or column cleanup (or repeat extraction), then re-measure. If the sample fails again, consider a fresh extraction.',
});

/**
 * Compose the final three output columns.
 * Returns { decision, rationale, recommended_action }
 */
function generateOutput(decision, primaryRationale, supplementaryWarnings, discrepancy) {
  const parts = [...primaryRationale];
  if (supplementaryWarnings.length > 0) {
    parts.push(...supplementaryWarnings);
  }
  if (discrepancy.flagged && discrepancy.rationale) {
    parts.push(discrepancy.rationale);
  }

  let action = ACTION[decision];
  if (decision === DECISION.BORDERLINE) {
    // Append targeted advice based on which metrics were borderline
    const context = primaryRationale.join(' ');
    if (context.includes('A260/A230')) action = 'Bead or column cleanup recommended (target: reagent carryover); re-measure before proceeding.';
    else if (context.includes('A260/A280')) action = 'Cleanup recommended if possible; otherwise proceed with caution and flag for review.';
    else if (context.includes('concentration')) action = 'Consider concentrating or re-quantifying; proceed only if you can normalise confidently.';
  }

  return {
    decision,
    rationale: parts.join(' '),
    recommended_action: action,
  };
}

// ── Section 10: Top-level entry points ───────────────────────────────────────

/**
 * Run the full triage algorithm for a single sample.
 *
 * @param {object} rawMetrics - { nd_conc?, a260_280?, a260_230?, fl_conc? }
 * @param {object} config     - result of loadConfig()
 * @returns {{ decision: string, rationale: string, recommended_action: string }}
 */
function triageSample(rawMetrics, config) {
  const thresholds = computeEffectiveThresholds(config);
  const classified = classifyMetrics(rawMetrics, config, thresholds);
  const { decision, primaryRationale } = combineDecision(classified);
  const supplementaryWarnings = buildSupplementaryWarnings(classified);
  const discrepancy = checkConcDiscrepancy(rawMetrics, config);
  return generateOutput(decision, primaryRationale, supplementaryWarnings, discrepancy);
}

/**
 * Run triage on an array of raw metric objects.
 * @param {object[]} rows
 * @param {object}   config
 * @returns {object[]}
 */
function triageAll(rows, config) {
  return rows.map(row => triageSample(row, config));
}

// ── Export (ES module + CommonJS dual-mode) ───────────────────────────────────

const _exports = {
  ROLE, STATE, DECISION,
  DEFAULT_CONFIG,
  loadConfig, validateConfig,
  computeNetStrict, computeEffectiveThresholds,
  classifyNdConc, classifyA280, classifyA230, classifyFlConc,
  classifyMetrics,
  combineDecision,
  buildSupplementaryWarnings,
  checkConcDiscrepancy,
  generateOutput,
  triageSample,
  triageAll,
};

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = _exports;
} else {
  // ES module export — make available as globalThis.PIPPA for non-module script tags
  /* eslint-disable no-undef */
  if (typeof globalThis !== 'undefined') globalThis.PIPPA = _exports;
}

export {
  ROLE, STATE, DECISION,
  DEFAULT_CONFIG,
  loadConfig, validateConfig,
  computeNetStrict, computeEffectiveThresholds,
  classifyNdConc, classifyA280, classifyA230, classifyFlConc,
  classifyMetrics,
  combineDecision,
  buildSupplementaryWarnings,
  checkConcDiscrepancy,
  generateOutput,
  triageSample,
  triageAll,
};
