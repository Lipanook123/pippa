/**
 * PIPPA web application controller
 * Imports core triage engine; drives all UI interactions.
 * Requires SheetJS (XLSX global) loaded before this module.
 */

import {
  loadConfig,
  triageAll,
  DECISION,
} from '../core/triage.js';

// ── Section 1: App state ──────────────────────────────────────────────────────

const state = {
  config:       null,   // current merged config object
  workbook:     null,   // raw SheetJS workbook
  sheetName:    null,   // active sheet name
  headers:      [],     // string[] — column headers from the uploaded file
  inputRows:    [],     // object[] — raw row data from SheetJS
  columnMap:    {},     // { nd_conc, a260_280, a260_230, fl_conc } → header string or ''
  results:      [],     // triageAll() output
  presets:      {},     // { research, standard, 'service-lab' } → config objects
  activePreset: null,   // name of the currently active preset button
};

// ── Section 2: Preset loading ─────────────────────────────────────────────────

const PRESET_NAMES = ['research', 'standard', 'service-lab'];

async function loadPresets() {
  for (const name of PRESET_NAMES) {
    try {
      const resp = await fetch(`./presets/${name}.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      state.presets[name] = await resp.json();
    } catch (e) {
      console.warn(`Could not load preset "${name}":`, e);
    }
  }
}

function applyPreset(name) {
  const preset = state.presets[name];
  if (!preset) return;
  try {
    state.config = loadConfig(preset);
    state.activePreset = name;
    renderConfigForm();
    renderPresetButtons();
  } catch (e) {
    console.error('Failed to apply preset:', e);
  }
}

// ── Section 3: Config form rendering / reading ────────────────────────────────

function renderPresetButtons() {
  const container = document.getElementById('preset-buttons');
  container.innerHTML = '';
  for (const name of PRESET_NAMES) {
    const preset = state.presets[name];
    if (!preset) continue;
    const btn = document.createElement('button');
    btn.className = 'preset-btn' + (state.activePreset === name ? ' active' : '');
    btn.textContent = preset.label || name;
    btn.title = preset.description || '';
    btn.addEventListener('click', () => applyPreset(name));
    container.appendChild(btn);
  }
}

function renderConfigForm() {
  const c = state.config;
  if (!c) return;

  // Roles
  setSelect('role-nd-conc', c.role_nanodrop_conc);
  setSelect('role-a280',    c.role_a260_280);
  setSelect('role-a230',    c.role_a260_230);
  setSelect('role-fl-conc', c.role_fluor_conc);
  setVal('fluor-label', c.fluor_assay_label);

  // Sliders
  setRange('slider-conservatism', c.conservatism);
  setRange('slider-tolerance', c.downstream_tolerance);
  document.getElementById('val-conservatism').textContent = c.conservatism.toFixed(2);
  document.getElementById('val-tolerance').textContent   = c.downstream_tolerance.toFixed(2);
  setVal('conc-discrepancy', c.conc_discrepancy_pct);

  // Thresholds
  setVal('nd-must',        c.nd_conc_must_threshold);
  setVal('nd-borderline',  c.nd_conc_borderline_threshold);
  setVal('a280-must',      c.a280_must_threshold);
  setVal('a280-borderline',c.a280_borderline_threshold);
  setVal('a280-upper',     c.a280_upper_threshold);
  setVal('a230-must',      c.a230_must_threshold);
  setVal('a230-borderline',c.a230_borderline_threshold);
  setVal('fl-must',        c.fl_conc_must_threshold);
  setVal('fl-borderline',  c.fl_conc_borderline_threshold);
}

function setSelect(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}
function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}
function setRange(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function readConfigFromForm() {
  const partial = {
    role_nanodrop_conc:          getSelect('role-nd-conc'),
    role_a260_280:               getSelect('role-a280'),
    role_a260_230:               getSelect('role-a230'),
    role_fluor_conc:             getSelect('role-fl-conc'),
    fluor_assay_label:           getStr('fluor-label') || 'Fluorescence',
    conservatism:                getFloat('slider-conservatism'),
    downstream_tolerance:        getFloat('slider-tolerance'),
    conc_discrepancy_pct:        getFloat('conc-discrepancy'),
    nd_conc_must_threshold:      getFloat('nd-must'),
    nd_conc_borderline_threshold:getFloat('nd-borderline'),
    a280_must_threshold:         getFloat('a280-must'),
    a280_borderline_threshold:   getFloat('a280-borderline'),
    a280_upper_threshold:        getFloat('a280-upper'),
    a230_must_threshold:         getFloat('a230-must'),
    a230_borderline_threshold:   getFloat('a230-borderline'),
    fl_conc_must_threshold:      getFloat('fl-must'),
    fl_conc_borderline_threshold:getFloat('fl-borderline'),
  };
  return loadConfig(partial);
}

function getSelect(id) { return document.getElementById(id)?.value ?? ''; }
function getStr(id)    { return document.getElementById(id)?.value ?? ''; }
function getFloat(id)  { return parseFloat(document.getElementById(id)?.value ?? 0); }

// ── Section 4: File upload + SheetJS parsing ──────────────────────────────────

function handleFileUpload(file) {
  if (!file) return;
  const statusEl = document.getElementById('upload-status');
  statusEl.textContent = `Reading ${file.name}…`;
  statusEl.className = 'upload-status';

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      state.workbook  = wb;
      state.sheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[state.sheetName];
      const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

      if (rows.length < 2) {
        statusEl.textContent = 'Error: sheet appears to have no data rows.';
        statusEl.className = 'upload-status err';
        return;
      }

      state.headers   = (rows[0] || []).map(h => h === null ? '' : String(h).trim());
      state.inputRows = rows.slice(1).map(row => {
        const obj = {};
        state.headers.forEach((h, i) => { obj[h] = row[i] ?? null; });
        return obj;
      }).filter(row => Object.values(row).some(v => v !== null && v !== ''));

      statusEl.textContent = `✓ Loaded "${file.name}" — ${state.inputRows.length} data rows, ${state.headers.length} columns`;
      statusEl.className = 'upload-status ok';

      state.columnMap = autoDetectColumns(state.headers);
      renderMappingTable();
      showSection('step-mapping');
      showSection('step-run');
    } catch (err) {
      statusEl.textContent = `Error reading file: ${err.message}`;
      statusEl.className = 'upload-status err';
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ── Section 5: Column auto-detection ─────────────────────────────────────────

const COLUMN_HINTS = {
  nd_conc:  [/ng[\s\/]?[uµ]l/i, /nanodrop/i, /nd[\s_-]?conc/i, /nucleic\s*acid/i],
  a260_280: [/260[\s\/]?280/i, /a260[\s\/]?a280/i],
  a260_230: [/260[\s\/]?230/i, /a260[\s\/]?a230/i],
  fl_conc:  [/qubit/i, /picogreen/i, /pico\s*green/i, /fluor/i, /fl[\s_-]?conc/i],
};

function autoDetectColumns(headers) {
  const map = { nd_conc: '', a260_280: '', a260_230: '', fl_conc: '' };
  const used = new Set();

  // Priority: exact metric names first, then fuzzy
  for (const [metric, patterns] of Object.entries(COLUMN_HINTS)) {
    for (const pattern of patterns) {
      const match = headers.find(h => !used.has(h) && pattern.test(h));
      if (match) {
        // Avoid matching a 260/230 hint to the 260/280 column and vice-versa
        if (metric === 'nd_conc' && (COLUMN_HINTS.a260_280.some(p => p.test(match)) || COLUMN_HINTS.a260_230.some(p => p.test(match)))) continue;
        map[metric] = match;
        used.add(match);
        break;
      }
    }
  }
  return map;
}

// ── Section 6: Column mapping UI ─────────────────────────────────────────────

const METRIC_LABELS = {
  nd_conc:  { name: 'NanoDrop Concentration', unit: 'ng/µL' },
  a260_280: { name: 'A260/A280',              unit: 'ratio' },
  a260_230: { name: 'A260/A230',              unit: 'ratio' },
  fl_conc:  { name: 'Fluorescence Conc.',     unit: 'ng/µL' },
};

function renderMappingTable() {
  const tbody = document.querySelector('#mapping-table tbody');
  tbody.innerHTML = '';

  for (const [metric, info] of Object.entries(METRIC_LABELS)) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.innerHTML = `<span class="metric-name">${info.name}</span><br><span class="metric-unit">${info.unit}</span>`;
    tr.appendChild(tdName);

    const tdSelect = document.createElement('td');
    const sel = document.createElement('select');
    sel.id = `map-${metric}`;

    const optNone = document.createElement('option');
    optNone.value = '';
    optNone.textContent = '— not mapped —';
    sel.appendChild(optNone);

    for (const header of state.headers) {
      if (!header) continue;
      const opt = document.createElement('option');
      opt.value = header;
      opt.textContent = header;
      sel.appendChild(opt);
    }
    sel.value = state.columnMap[metric] || '';
    tdSelect.appendChild(sel);
    tr.appendChild(tdSelect);

    tbody.appendChild(tr);
  }
}

function readColumnMapping() {
  const map = {};
  for (const metric of Object.keys(METRIC_LABELS)) {
    map[metric] = document.getElementById(`map-${metric}`)?.value || '';
  }
  return map;
}

// ── Section 7: Run triage ─────────────────────────────────────────────────────

function runTriage() {
  let config;
  try {
    config = readConfigFromForm();
  } catch (e) {
    alert(`Configuration error: ${e.message}`);
    return;
  }
  state.config = config;

  const mapping = readColumnMapping();

  const rows = state.inputRows.map(row => ({
    nd_conc:  parseMetricValue(row[mapping.nd_conc]),
    a260_280: parseMetricValue(row[mapping.a260_280]),
    a260_230: parseMetricValue(row[mapping.a260_230]),
    fl_conc:  parseMetricValue(row[mapping.fl_conc]),
  }));

  state.results = triageAll(rows, config);
  renderResults(state.inputRows, state.results);
  showSection('step-results');

  // Scroll to results
  document.getElementById('step-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function parseMetricValue(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

// ── Section 8: Results rendering ─────────────────────────────────────────────

const DECISION_CLASS = {
  [DECISION.USE]:       'decision-use',
  [DECISION.BORDERLINE]:'decision-borderline',
  [DECISION.MUST]:      'decision-must',
};

function renderResults(inputRows, results) {
  // Summary badges
  const counts = { [DECISION.USE]: 0, [DECISION.BORDERLINE]: 0, [DECISION.MUST]: 0 };
  for (const r of results) counts[r.decision] = (counts[r.decision] || 0) + 1;

  const summaryEl = document.getElementById('results-summary');
  summaryEl.innerHTML = `
    <span class="summary-badge badge-use">✓ Use as-is: ${counts[DECISION.USE]}</span>
    <span class="summary-badge badge-borderline">⚠ Borderline: ${counts[DECISION.BORDERLINE]}</span>
    <span class="summary-badge badge-must">✗ Must cleanup: ${counts[DECISION.MUST]}</span>
  `;

  // Table header
  const thead = document.getElementById('results-thead');
  const inputCols = state.headers.filter(h => h);
  thead.innerHTML = '';
  for (const h of inputCols) {
    const th = document.createElement('th');
    th.textContent = h;
    thead.appendChild(th);
  }
  for (const label of ['Decision', 'Rationale', 'Recommended Action']) {
    const th = document.createElement('th');
    th.textContent = label;
    thead.appendChild(th);
  }

  // Table body
  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = '';
  for (let i = 0; i < inputRows.length; i++) {
    const row = inputRows[i];
    const result = results[i];
    const tr = document.createElement('tr');

    // Input columns
    for (const h of inputCols) {
      const td = document.createElement('td');
      td.textContent = row[h] !== null && row[h] !== undefined ? row[h] : '';
      tr.appendChild(td);
    }

    // Decision
    const tdDecision = document.createElement('td');
    tdDecision.textContent = result.decision;
    tdDecision.className = DECISION_CLASS[result.decision] || '';
    tr.appendChild(tdDecision);

    // Rationale
    const tdRationale = document.createElement('td');
    tdRationale.textContent = result.rationale;
    tdRationale.className = 'col-rationale';
    tr.appendChild(tdRationale);

    // Recommended action
    const tdAction = document.createElement('td');
    tdAction.textContent = result.recommended_action;
    tdAction.className = 'col-action';
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  }
}

// ── Section 9: Excel export ───────────────────────────────────────────────────

const DECISION_CELL_STYLES = {
  'Use as-is':             { fill: { patternType: 'solid', fgColor: { rgb: 'E8F5E9' } }, font: { bold: true, color: { rgb: '1B5E20' } } },
  'Borderline':            { fill: { patternType: 'solid', fgColor: { rgb: 'FFF3E0' } }, font: { bold: true, color: { rgb: 'E65100' } } },
  'Must cleanup or repeat':{ fill: { patternType: 'solid', fgColor: { rgb: 'FFEBEE' } }, font: { bold: true, color: { rgb: 'B71C1C' } } },
};

function applyDecisionStyles(ws, rowCount) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  let decisionCol = null;
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell && cell.v === 'Decision') { decisionCol = c; break; }
  }
  if (decisionCol === null) return;
  for (let r = 1; r <= rowCount; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: decisionCol });
    const cell = ws[addr];
    if (cell && DECISION_CELL_STYLES[cell.v]) {
      cell.s = DECISION_CELL_STYLES[cell.v];
    }
  }
}

function downloadResults() {
  if (!state.workbook || state.results.length === 0) return;

  const wb = XLSX.utils.book_new();
  const outputRows = state.inputRows.map((row, i) => {
    const result = state.results[i];
    return {
      ...row,
      Decision:             result.decision,
      Rationale:            result.rationale,
      'Recommended Action': result.recommended_action,
    };
  });
  const ws = XLSX.utils.json_to_sheet(outputRows, { header: [...state.headers, 'Decision', 'Rationale', 'Recommended Action'] });
  applyDecisionStyles(ws, state.results.length);
  XLSX.utils.book_append_sheet(wb, ws, 'PIPPA Results');

  const buf  = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'PIPPA_results.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Section 10: Example file generator ───────────────────────────────────────

function generateExampleFile() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Sample ID', 'NanoDrop Conc (ng/µL)', 'A260/A280', 'A260/A230', 'Qubit (ng/µL)'],
    ['DNA-001', 185.4, 1.89, 2.12, ''],
    ['DNA-002', 142.8, 1.84, 1.95, ''],
    ['DNA-003', 67.3,  1.82, 1.45, ''],
    ['DNA-004', 18.6,  1.88, 2.08, ''],
    ['DNA-005', 94.2,  1.58, 2.01, ''],
    ['DNA-006', 89.7,  1.83, 1.08, ''],
    ['DNA-007', 7.4,   1.79, 1.96, ''],
    ['DNA-008', 156.0, 2.31, 2.18, 148.5],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Samples');
  const buf  = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'PIPPA_example_input.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Section 11: Profile save / load ──────────────────────────────────────────

function saveProfile() {
  let config;
  try {
    config = readConfigFromForm();
  } catch (e) {
    alert(`Cannot save — configuration error: ${e.message}`);
    return;
  }
  const profile = {
    profile_name: prompt('Profile name:', 'My Lab Profile') || 'Custom',
    ...config,
  };
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'pippa-profile.json';
  a.click();
  URL.revokeObjectURL(url);
}

function loadProfile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const profile = JSON.parse(e.target.result);
      state.config = loadConfig(profile);
      state.activePreset = null;
      renderConfigForm();
      renderPresetButtons();
    } catch (err) {
      alert(`Failed to load profile: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

// ── Section 12: Utility helpers ───────────────────────────────────────────────

function showSection(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

// ── Section 13: Event wiring ──────────────────────────────────────────────────

function initEventListeners() {
  // File upload — click
  const inputExcel = document.getElementById('input-excel');
  document.getElementById('drop-zone').addEventListener('click', () => inputExcel.click());
  inputExcel.addEventListener('change', e => handleFileUpload(e.target.files[0]));

  // File upload — drag and drop
  const dropZone = document.getElementById('drop-zone');
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop',      e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFileUpload(e.dataTransfer.files[0]);
  });

  // Profile load
  const inputProfile = document.getElementById('input-profile');
  document.getElementById('btn-load-profile').addEventListener('click', () => inputProfile.click());
  inputProfile.addEventListener('change', e => loadProfile(e.target.files[0]));

  // Profile save
  document.getElementById('btn-save-profile').addEventListener('click', saveProfile);

  // Slider live display
  document.getElementById('slider-conservatism').addEventListener('input', e => {
    document.getElementById('val-conservatism').textContent = parseFloat(e.target.value).toFixed(2);
    state.activePreset = null;
    renderPresetButtons();
  });
  document.getElementById('slider-tolerance').addEventListener('input', e => {
    document.getElementById('val-tolerance').textContent = parseFloat(e.target.value).toFixed(2);
    state.activePreset = null;
    renderPresetButtons();
  });

  // Example file download
  document.getElementById('btn-example-file').addEventListener('click', generateExampleFile);

  // Run triage
  document.getElementById('btn-run').addEventListener('click', runTriage);

  // Download
  document.getElementById('btn-download').addEventListener('click', downloadResults);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  await loadPresets();
  applyPreset('standard');   // default preset on load
  initEventListeners();
}

document.addEventListener('DOMContentLoaded', init);
