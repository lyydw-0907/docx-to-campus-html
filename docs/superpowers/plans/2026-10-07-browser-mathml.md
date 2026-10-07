# Browser MathML Implementation Plan

> Historical implementation plan. The original no-GitHub constraint applied during development. The user subsequently authorized the public Cloudflare deployment and this GitHub source update on 2026-10-07.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. This session executes the authorized work with the available collaboration agents and root review; no additional approval or GitHub write is required.

**Goal:** Make the existing HZAU Word-to-HTML workflow work in a browser without uploading documents, initially supporting MathML only.

**Architecture:** Keep the existing Node application working. Extract the converter's document transformation logic behind a runtime interface, implement a Pandoc WASM runtime in a worker, and adapt the existing UI to a local in-memory API. Generate a complete static distribution with its own WASM and dependencies, so deployment needs no conversion server.

**Tech Stack:** Existing JSZip/Cheerio/OOXML style restoration, official pandoc-wasm, buffer, fflate, esbuild, browser Worker/Blob/Web Crypto.

## Global Constraints

- 本轮不更新 GitHub：不提交、不推送、不更改远程仓库或 Release。
- Only 华中农业大学大创系统; no school login, saves, or submission.
- First browser version supports `formulaFormat: 'mathml'`; reject unsupported PNG explicitly.
- Preserve source font sizes, bold and explicit normal, indentation, alignment, table widths/rules, image layout, equations and existing numbering, section copying and image mapping.
- Documents, pasted school source, and conversion results stay in memory on the device; fetch only bundled static engine/assets and the public synthetic demo.
- Keep 20 MB input, ZIP structural/actual expansion checks, 1000 formulas, 500 images, cancellation/timeouts, and explicit failure rather than omitted formulas.
- Never add private input, credentials, school image URLs, or output to the static distribution.
- Existing Node API and tests remain compatible. Build products stay ignored under `output/browser/`.

---

### Task 1: Shared conversion core and browser runtime

**Files:** create `src/convert-core.mjs`, `src/browser-convert.mjs`; modify `src/convert.mjs`; add focused tests for runtime/output parity.

**Interfaces:**

```js
// Native public API remains unchanged.
export async function convertDocx(input, options = {}) { /* existing Node behavior */ }
// Browser API consumed by the Worker bridge.
export async function convertDocxInBrowser(input, options = {}) { /* MathML result */ }
// result = {fragment, preview, manifest, assets, sections}
// assets[i].data is Uint8Array-compatible; retain source image bytes.
```

- [x] Extract existing transformation functions and style restoration into a runtime-based core; Node wrapper provides its current Pandoc and filesystem implementation.
- [x] Browser runtime reads DOCX and writes Pandoc AST/MathML through `pandoc-wasm.convert(options, stdin, files)`; SHA-256 uses Web Crypto and image metadata uses browser image decoding.
- [x] Keep ZIP preflight and check actual inflated bytes before invoking JSZip/Pandoc; retain all native formula-count and sanitization checks.
- [x] Run `npm test`, expecting the existing native checks to remain green; compare synthetic fixture text, math structures/numbering, source styles, and asset bytes across engines.

### Task 2: Local API and export behavior

**Files:** create `browser/local-api.js`, `browser/compare.js`, and meaningful local API tests.

**Interfaces:**

```js
const api = createBrowserApi({ convert, demoUrl, onProgress });
await api.request('/api/convert?formulaFormat=mathml', { method: 'POST', body: bytes });
api.assetUrl(jobId, filename);
```

- [x] Implement the actual UI endpoints: convert/demo/probe/compare/import-images/upload-images/assets/export, returning browser Response objects.
- [x] Scope mapping/export to the chosen section while preserving entire-document and unassigned-reference copying; validate unique HTTP(S) image mappings without requesting them.
- [x] Store results in short-lived in-memory jobs, release Blob URLs, and produce ZIP packages with raw assets and per-section HTML.
- [x] Test scoped copy without irrelevant image mappings, imported URLs/order confirmation, and ZIP contents plus error paths.

### Task 3: Static UI, Worker, and build

**Files:** create `browser/client.js`, `browser/worker.js`, `tools/build-browser.mjs`, `tools/serve-browser.mjs`; add browser build/preview scripts to `package.json`, update lockfile and third-party notes.

**Worker protocol:**

```js
// Main -> Worker; preserve caller bytes for recovery.
worker.postMessage({ id, type: 'convert', input: bytes, options });
// Worker -> Main
postMessage({ id, type: 'result', result });
postMessage({ id, type: 'error', message });
```

- [x] Bundle existing UI with `localRequest` and `assetUrl`; inject the local API into recovery and order preview paths. Keep original `public/` files usable by Node.
- [x] Present browser-specific loading/progress text and MathML-only selection; label document processing as local to the browser.
- [x] Bundle Cheerio's slim entry and Buffer; copy official WASM, synthetic demo, license notices and every static dependency to `output/browser/`.
- [x] Provide `npm run build:browser` and `npm run preview:browser`; preview server serves static files only and rejects conversion POST requests.

### Task 4: Browser acceptance and documentation

**Files:** meaningful browser acceptance fixture/scripts in ignored `output/browser-checks/`; `docs/browser-version.md` and README entry.

- [x] In a separate Edge session run synthetic demo and complex Word fixture conversion, choose/copy scopes, map numbered school-style image URLs, adjust order, and download the exported ZIP.
- [x] Observe all network requests: only static GETs permitted; no DOCX, source HTML, results, or school image fetch in the API layer.
- [x] Exercise invalid/non-DOCX input, explicit unsupported mode, timeout recovery, and changing files while conversion is pending.
- [x] Verify actual MathML rendering and image/caption/table layout visually, retain screenshots privately, and record measured comparison results without implying new school-side validation.
- [x] Deliver the local preview URL and deployable static package; report precisely whether a public HTTPS deployment was made. Leave GitHub untouched.


## Execution result — 2026-10-07

Completed local browser implementation, static build and independent Edge acceptance. Final complete suite: 301 passed, 0 failed, 0 skipped. Browser demo, advanced MathML, scoped/whole/reference copying, image-order swapping, mapping ZIP, cancellation, deadline and back navigation recovery verified. Local authorized Word comparison retained 189 formulas, 9 numbers and 9 images; no private materials were added to the static/source packages.

Preview: http://127.0.0.1:4318/. Distribution: output/campus-mathml-browser.zip. Source and full component license/copyright texts included. No public HTTPS deployment was made; Git HEAD remains 03bb465cf8e514cf507b01fb83ebfc13669dbd53, with no commit/push/remote update.
