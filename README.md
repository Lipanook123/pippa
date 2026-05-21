# PIPPA

**Purity Interpretation and Processing for Pre-sequencing Assessment**

A configurable DNA quality triage tool that turns NanoDrop spectrophotometry (and optional fluorescence quantification) into clear, consistent go/no-go decisions for each sample.

## Features

- Classifies each sample as **Use as-is**, **Borderline**, or **Must cleanup or repeat**
- Three built-in presets: Research (permissive), Standard, Service Lab (strict)
- Configurable thresholds, metric roles, and conservatism/downstream-tolerance sliders
- Auto-detects column headers from your NanoDrop export
- Exports results as a colour-coded `.xlsx` file
- Runs entirely in the browser — no server, no data leaves your machine

## Usage

1. Open `index.html` via a local HTTP server (required for ES modules):
   ```
   python -m http.server 8080
   ```
   Then visit `http://localhost:8080`.
2. Select a preset or adjust thresholds in the Advanced panel.
3. Upload your NanoDrop export (`.xlsx` or `.xls`).
4. Confirm column mapping, then click **Run Triage**.
5. Download the annotated results spreadsheet.

A sample input file can be downloaded from the **How to use PIPPA** panel on the page.

## Repository

<https://github.com/Lipanook123/pippa>

## License

MIT © 2026 David Walker — see [LICENSE](LICENSE).
