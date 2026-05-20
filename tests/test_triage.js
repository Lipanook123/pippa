/**
 * PIPPA core engine test suite — Node.js (ES module)
 * Run: node tests/test_triage.js
 * Or open tests/test_triage.html in a browser (served over HTTP).
 */

import {
  ROLE, STATE, DECISION,
  DEFAULT_CONFIG,
  loadConfig, validateConfig,
  computeNetStrict, computeEffectiveThresholds,
  classifyNdConc, classifyA280, classifyA230, classifyFlConc,
  classifyMetrics,
  combineDecision,
  buildSupplementaryWarnings,
  checkConcDiscrepancy,
  triageSample,
  triageAll,
} from '../core/triage.js';

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Minimal test harness ──────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`FAIL: ${name}\n      ${e.message}`);
  }
}

function assertEqual(actual, expected, label = '') {
  if (actual !== expected) {
    throw new Error(`${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertApprox(actual, expected, tolerance, label = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label ? label + ': ' : ''}expected ~${expected}, got ${actual}`);
  }
}

function assertIncludes(haystack, needle, label = '') {
  if (!haystack.includes(needle)) {
    throw new Error(`${label ? label + ': ' : ''}expected string to include "${needle}"\n      Got: "${haystack}"`);
  }
}

function assertNotIncludes(haystack, needle, label = '') {
  if (haystack.includes(needle)) {
    throw new Error(`${label ? label + ': ' : ''}expected string NOT to include "${needle}"`);
  }
}

function assertThrows(fn, label = '') {
  try { fn(); } catch (e) { return; }
  throw new Error(`${label ? label + ': ' : ''}expected an error to be thrown`);
}

// ── loadConfig / validateConfig ───────────────────────────────────────────────

test('loadConfig: empty partial returns Standard defaults', () => {
  const c = loadConfig();
  assertEqual(c.conservatism, 0.5);
  assertEqual(c.downstream_tolerance, 0.3);
  assertEqual(c.role_nanodrop_conc, ROLE.PRIMARY);
  assertEqual(c.role_fluor_conc, ROLE.IGNORED);
});

test('loadConfig: partial override merges correctly', () => {
  const c = loadConfig({ conservatism: 0.8 });
  assertEqual(c.conservatism, 0.8);
  assertEqual(c.downstream_tolerance, 0.3); // unchanged
});

test('loadConfig: invalid role throws', () => {
  assertThrows(() => loadConfig({ role_a260_280: 'Optional' }), 'invalid role');
});

test('loadConfig: no Primary metrics throws', () => {
  assertThrows(() => loadConfig({
    role_nanodrop_conc: ROLE.IGNORED,
    role_a260_280:      ROLE.IGNORED,
    role_a260_230:      ROLE.IGNORED,
    role_fluor_conc:    ROLE.IGNORED,
  }), 'no primary metrics');
});

test('loadConfig: conservatism out of range throws', () => {
  assertThrows(() => loadConfig({ conservatism: 1.5 }), 'conservatism > 1');
});

// ── computeNetStrict ──────────────────────────────────────────────────────────

test('computeNetStrict: Standard (0.5 - 0.3 = 0.2)', () => {
  assertApprox(computeNetStrict(loadConfig()), 0.2, 1e-10, 'Standard');
});

test('computeNetStrict: Research (0.2 - 0.6 = -0.4)', () => {
  assertApprox(computeNetStrict(loadConfig({ conservatism: 0.2, downstream_tolerance: 0.6 })), -0.4, 1e-10, 'Research');
});

test('computeNetStrict: Service Lab (0.8 - 0.1 = 0.7)', () => {
  assertApprox(computeNetStrict(loadConfig({ conservatism: 0.8, downstream_tolerance: 0.1 })), 0.7, 1e-10, 'Service Lab');
});

test('computeNetStrict: clamps at +1', () => {
  assertEqual(computeNetStrict(loadConfig({ conservatism: 1.0, downstream_tolerance: 0.0 })), 1.0);
});

test('computeNetStrict: clamps at -1', () => {
  assertEqual(computeNetStrict(loadConfig({ conservatism: 0.0, downstream_tolerance: 1.0 })), -1.0);
});

// ── computeEffectiveThresholds ────────────────────────────────────────────────

test('computeEffectiveThresholds: NS=0 leaves thresholds unchanged', () => {
  const config = loadConfig({ conservatism: 0.5, downstream_tolerance: 0.5 }); // NS=0
  const t = computeEffectiveThresholds(config);
  assertApprox(t.nd_must, 10, 1e-10, 'nd_must NS=0');
  assertApprox(t.a230_borderline, 1.60, 1e-10, 'a230_borderline NS=0');
  assertApprox(t.a280_must, 1.60, 1e-10, 'a280_must NS=0');
});

test('computeEffectiveThresholds: NS=+1 shifts up by full delta', () => {
  const config = loadConfig({ conservatism: 1.0, downstream_tolerance: 0.0 });
  const t = computeEffectiveThresholds(config);
  assertApprox(t.nd_must, 15, 1e-10, 'nd_must NS=+1');
  assertApprox(t.a230_must, 1.45, 1e-10, 'a230_must NS=+1');
  assertApprox(t.a280_borderline, 1.80, 1e-10, 'a280_borderline NS=+1');
});

test('computeEffectiveThresholds: NS=-1 shifts down by full delta', () => {
  const config = loadConfig({ conservatism: 0.0, downstream_tolerance: 1.0 });
  const t = computeEffectiveThresholds(config);
  assertApprox(t.nd_must, 5, 1e-10, 'nd_must NS=-1');
  assertApprox(t.a230_borderline, 1.35, 1e-10, 'a230_borderline NS=-1');
});

test('computeEffectiveThresholds: a280_upper is never shifted', () => {
  const config = loadConfig({ conservatism: 1.0, downstream_tolerance: 0.0 });
  const t = computeEffectiveThresholds(config);
  assertApprox(t.a280_upper, 2.20, 1e-10, 'a280_upper unchanged');
});

// ── classifyNdConc ────────────────────────────────────────────────────────────

test('classifyNdConc: null → MISSING', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyNdConc(null, t).state, STATE.MISSING);
});

test('classifyNdConc: below must → MUST', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyNdConc(5, t).state, STATE.MUST);
});

test('classifyNdConc: exactly at must boundary → MUST', () => {
  const config = loadConfig({ conservatism: 0.5, downstream_tolerance: 0.5 }); // NS=0 → must=10
  const t = computeEffectiveThresholds(config);
  // value < 10 → MUST; value = 9.999 → MUST; value = 10 → BORDERLINE
  assertEqual(classifyNdConc(9.999, t).state, STATE.MUST);
  assertEqual(classifyNdConc(10, t).state, STATE.BORDERLINE);
});

test('classifyNdConc: in borderline range → BORDERLINE', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyNdConc(15, t).state, STATE.BORDERLINE);
});

test('classifyNdConc: at or above borderline threshold → USE', () => {
  const config = loadConfig({ conservatism: 0.5, downstream_tolerance: 0.5 });
  const t = computeEffectiveThresholds(config);
  assertEqual(classifyNdConc(20, t).state, STATE.USE);
  assertEqual(classifyNdConc(200, t).state, STATE.USE);
});

// ── classifyA280 ──────────────────────────────────────────────────────────────

test('classifyA280: null → MISSING', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyA280(null, t).state, STATE.MISSING);
});

test('classifyA280: below must → MUST', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyA280(1.50, t).state, STATE.MUST);
});

test('classifyA280: borderline range → BORDERLINE', () => {
  const config = loadConfig({ conservatism: 0.5, downstream_tolerance: 0.5 }); // NS=0 → must=1.60 borderline=1.70
  const t = computeEffectiveThresholds(config);
  assertEqual(classifyA280(1.65, t).state, STATE.BORDERLINE);
});

test('classifyA280: acceptable range → USE', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyA280(1.85, t).state, STATE.USE);
});

test('classifyA280: above upper bound → USE with highRatioNote', () => {
  const t = computeEffectiveThresholds(loadConfig());
  const result = classifyA280(2.50, t);
  assertEqual(result.state, STATE.USE);
  if (!result.highRatioNote || !result.highRatioNote.includes('upper bound')) {
    throw new Error('Expected highRatioNote about upper bound');
  }
});

// ── classifyA230 ──────────────────────────────────────────────────────────────

test('classifyA230: null → MISSING', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyA230(null, t).state, STATE.MISSING);
});

test('classifyA230: below must → MUST', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyA230(1.05, t).state, STATE.MUST);
});

test('classifyA230: borderline range → BORDERLINE', () => {
  const config = loadConfig({ conservatism: 0.5, downstream_tolerance: 0.5 });
  const t = computeEffectiveThresholds(config);
  assertEqual(classifyA230(1.40, t).state, STATE.BORDERLINE);
});

test('classifyA230: acceptable → USE', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyA230(2.10, t).state, STATE.USE);
});

// ── classifyFlConc ────────────────────────────────────────────────────────────

test('classifyFlConc: null → MISSING', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyFlConc(null, t, 'Qubit').state, STATE.MISSING);
});

test('classifyFlConc: uses assay label in rationale', () => {
  const t = computeEffectiveThresholds(loadConfig());
  const result = classifyFlConc(5, t, 'Qubit');
  assertIncludes(result.rationale, 'Qubit', 'assay label in rationale');
});

test('classifyFlConc: below must → MUST', () => {
  const t = computeEffectiveThresholds(loadConfig());
  assertEqual(classifyFlConc(4, t, 'Qubit').state, STATE.MUST);
});

// ── combineDecision ───────────────────────────────────────────────────────────

test('combineDecision rule 1: concentration MUST overrides all', () => {
  const config = loadConfig();
  const t = computeEffectiveThresholds(config);
  const classified = classifyMetrics({ nd_conc: 5, a260_280: 1.82, a260_230: 2.10, fl_conc: null }, config, t);
  assertEqual(combineDecision(classified).decision, DECISION.MUST);
});

test('combineDecision rule 2: A230 MUST', () => {
  const config = loadConfig();
  const t = computeEffectiveThresholds(config);
  const classified = classifyMetrics({ nd_conc: 85, a260_280: 1.82, a260_230: 1.05, fl_conc: null }, config, t);
  assertEqual(combineDecision(classified).decision, DECISION.MUST);
});

test('combineDecision rule 3: A280 MUST', () => {
  const config = loadConfig();
  const t = computeEffectiveThresholds(config);
  const classified = classifyMetrics({ nd_conc: 85, a260_280: 1.42, a260_230: 2.10, fl_conc: null }, config, t);
  assertEqual(combineDecision(classified).decision, DECISION.MUST);
});

test('combineDecision rule 4: any BORDERLINE', () => {
  const config = loadConfig();
  const t = computeEffectiveThresholds(config);
  const classified = classifyMetrics({ nd_conc: 85, a260_280: 1.82, a260_230: 1.40, fl_conc: null }, config, t);
  assertEqual(combineDecision(classified).decision, DECISION.BORDERLINE);
});

test('combineDecision rule 5: all USE', () => {
  const config = loadConfig();
  const t = computeEffectiveThresholds(config);
  const classified = classifyMetrics({ nd_conc: 85, a260_280: 1.82, a260_230: 2.10, fl_conc: null }, config, t);
  assertEqual(combineDecision(classified).decision, DECISION.USE);
});

test('combineDecision rule 0: all Primary MISSING → USE with note', () => {
  const config = loadConfig();
  const t = computeEffectiveThresholds(config);
  const classified = classifyMetrics({ nd_conc: null, a260_280: null, a260_230: null, fl_conc: null }, config, t);
  const result = combineDecision(classified);
  assertEqual(result.decision, DECISION.USE);
  assertIncludes(result.primaryRationale[0], 'No primary metrics');
});

test('combineDecision: Supplementary MUST does not override Primary USE', () => {
  const config = loadConfig({
    role_nanodrop_conc: ROLE.SUPPLEMENTARY,
    role_a260_280: ROLE.PRIMARY,
    role_a260_230: ROLE.PRIMARY,
    role_fluor_conc: ROLE.IGNORED,
  });
  const t = computeEffectiveThresholds(config);
  const classified = classifyMetrics({ nd_conc: 5, a260_280: 1.82, a260_230: 2.10, fl_conc: null }, config, t);
  assertEqual(combineDecision(classified).decision, DECISION.USE);
});

// ── checkConcDiscrepancy ──────────────────────────────────────────────────────

test('checkConcDiscrepancy: both ignored → not flagged', () => {
  const config = loadConfig();
  assertEqual(checkConcDiscrepancy({ nd_conc: 100, fl_conc: 50 }, config).flagged, false);
});

test('checkConcDiscrepancy: >30% difference flagged', () => {
  const config = loadConfig({
    role_nanodrop_conc: ROLE.SUPPLEMENTARY,
    role_fluor_conc: ROLE.PRIMARY,
    role_a260_280: ROLE.PRIMARY,
    role_a260_230: ROLE.PRIMARY,
  });
  const result = checkConcDiscrepancy({ nd_conc: 100, fl_conc: 50 }, config);
  assertEqual(result.flagged, true);
  assertIncludes(result.rationale, 'differ by');
});

test('checkConcDiscrepancy: <30% difference not flagged', () => {
  const config = loadConfig({
    role_nanodrop_conc: ROLE.SUPPLEMENTARY,
    role_fluor_conc: ROLE.PRIMARY,
    role_a260_280: ROLE.PRIMARY,
    role_a260_230: ROLE.PRIMARY,
  });
  assertEqual(checkConcDiscrepancy({ nd_conc: 85, fl_conc: 75 }, config).flagged, false);
});

// ── triageSample integration ──────────────────────────────────────────────────

test('triageSample: all-good → Use as-is', () => {
  const config = loadConfig();
  const result = triageSample({ nd_conc: 150, a260_280: 1.82, a260_230: 2.10, fl_conc: null }, config);
  assertEqual(result.decision, DECISION.USE);
});

test('triageSample: A230 contamination → Must cleanup', () => {
  const config = loadConfig();
  const result = triageSample({ nd_conc: 85, a260_280: 1.82, a260_230: 1.05, fl_conc: null }, config);
  assertEqual(result.decision, DECISION.MUST);
  assertIncludes(result.rationale, 'A260/A230');
});

test('triageSample: borderline concentration → Borderline', () => {
  const config = loadConfig();
  const result = triageSample({ nd_conc: 15, a260_280: 1.82, a260_230: 2.10, fl_conc: null }, config);
  assertEqual(result.decision, DECISION.BORDERLINE);
});

test('triageSample: research preset passes values borderline under standard', () => {
  const config = loadConfig({ conservatism: 0.2, downstream_tolerance: 0.6 });
  const result = triageSample({ nd_conc: 18, a260_280: 1.68, a260_230: 1.50, fl_conc: null }, config);
  assertEqual(result.decision, DECISION.USE, 'research preset should pass');
});

test('triageSample: service-lab fails A280=1.66 (MUST at ns=+0.7, threshold=1.67)', () => {
  const config = loadConfig({ conservatism: 0.8, downstream_tolerance: 0.1 });
  const result = triageSample({ nd_conc: 100, a260_280: 1.66, a260_230: 2.10, fl_conc: null }, config);
  assertEqual(result.decision, DECISION.MUST, 'service-lab should fail a280=1.66');
});

// ── Fixture-driven tests ──────────────────────────────────────────────────────

function runFixtures() {
  const fixturesPath = join(__dirname, 'fixtures', 'sample_rows.json');
  const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

  for (const fx of fixtures) {
    test(`fixture: ${fx.id}`, () => {
      const config = loadConfig(fx.config_override || {});
      const result = triageSample(fx.input, config);
      const { expected } = fx;

      if (expected.decision !== undefined) {
        assertEqual(result.decision, expected.decision, `${fx.id} decision`);
      }
      for (const needle of (expected.rationale_includes || [])) {
        assertIncludes(result.rationale, needle, `${fx.id} rationale should include "${needle}"`);
      }
      for (const needle of (expected.rationale_not_includes || [])) {
        assertNotIncludes(result.rationale, needle, `${fx.id} rationale should NOT include "${needle}"`);
      }
    });
  }
}

runFixtures();

// ── Summary ───────────────────────────────────────────────────────────────────

for (const f of failures) console.error(f);
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
