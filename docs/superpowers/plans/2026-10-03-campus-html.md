# Campus HTML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a local, open source DOCX converter with clear formula images and an explicit school-editor verification workflow.

**Architecture:** Pandoc reads DOCX into a JSON document tree. A formula renderer replaces mathematics with self-contained images. A local UI exports a preview, a pasteable fragment, images and a manifest; a separate probe and comparison tool measures what survives saving in an actual editor.

**Tech Stack:** Node.js 22+, Pandoc 3.6.4 portable, MathJax 3.2.2, sharp 0.34.5, JSZip 3.10.1, cheerio 1.0.0, Node test runner.

## Global Constraints

- Never collect credentials or submit formal applications.
- Validate editor persistence only with a disposable test draft, when one is accessible.
- Never claim school compatibility based solely on local rendering.
- Keep assets, math sizing and baseline metadata exportable; do not assume data URLs or SVG survive school filtering.
- Unsupported or missing native equations must be reported, not silently dropped.
- All conversion runs locally; application server binds to 127.0.0.1.

## File Structure

- `tools/network-check.ps1`, `docs/access-report.md`: repeatable HTTP/HTTPS observations and minimal required local evidence.
- `src/math.mjs`: TeX to self-contained SVG or PNG; logical dimensions and baseline depth.
- `src/convert.mjs`: DOCX inspection, Pandoc tree conversion, HTML safety and asset manifest.
- `src/fixtures.mjs`: deterministic DOCX fixture containing real OMML, text, table and image.
- `src/cli.mjs`: filesystem export for conversion.
- `src/probe.mjs`: editor test fragment and before/after comparison.
- `src/server.mjs`, `public/`: local conversion UI.
- `tools/setup-pandoc.mjs`, `tools/demo.mjs`: portable engine setup and example export.
- `tests/`: equation, end-to-end conversion, comparison and HTTP validation.
- `README.md`, `.github/workflows/test.yml`, `LICENSE`: reproducible open source packaging.

### Task 1: Establish access facts

- [x] Request all three endpoints with GET, separately over HTTP and HTTPS; record failures by DNS/TCP/TLS/HTTP layer.
- [x] Inspect publicly available login markup and portal resources without entering credentials.
- [x] Save `docs/access-report.md` with observations and an uncertainty statement for campus-network/VPN causality.
- [x] Supply `tools/network-check.ps1` so the user can repeat only public connectivity checks locally.

### Task 2: Render native mathematics

**Interface:** `renderFormula(tex, {display, fontSize, scale, format})` returns image bytes, MIME, extension, logical width, height and depth.

- [x] Test fractions, indexed symbols, matrices and integrals with `node --test tests/math.test.mjs`.
- [x] Render with MathJax SVG using local paths and no external font cache; rasterize at 3x logical resolution with sharp.
- [x] Fail explicitly on unsupported mathematical input; preserve the full canvas when calculating inline baseline alignment.

### Task 3: Convert and export a complete example

**Interface:** `convertDocx(buffer, options)` returns fragment, preview, assets and manifest. `makeDemoDocx()` returns a complete OOXML ZIP buffer.

- [x] Download the pinned portable engine using `npm run setup:pandoc`.
- [x] Read DOCX as JSON with `pandoc --from=docx --to=json`, extract embedded media into an isolated temporary folder and compare OMML counts.
- [x] Replace AST math nodes with generated image tags; write HTML5 with Pandoc, then allow only supported candidate structural tags and safe image references.
- [x] Preserve source equation numbering; provide embedded, local-file and uploaded-URL image modes with explicit portability warnings.
- [x] Run `node --test tests/converter.test.mjs`; generate the fixture and export with `npm run demo`.

### Task 4: Make compatibility measurable

- [x] Generate labeled probe content covering tags, inline styles, PNG/SVG, baseline and equation numbering.
- [x] Compare supplied before/after fragments with a DOM-based report; distinguish attribute preservation from visual and loaded-image verification.
- [x] Test loss of image source, dimensions, math tags and styles with `node --test tests/probe.test.mjs`.
- [x] Add a localhost UI for file conversion, source export and save/reopen comparison, then run `npm start`.
- [x] Inspect the demo in an isolated Playwright session and check the browser console and all image loads.

### Task 5: Package the reproducible prototype

- [x] Run `npm test`; document exact quick-start commands and unsupported Word layout features.
- [x] Include MIT source licensing and separate Pandoc GPL-2.0-or-later / MathJax Apache-2.0 attribution; never commit the portable binary or user documents.
- [x] Initialize a local `codex/initial-prototype` branch, inspect the final changes and keep GitHub publication pending a known target repository.
