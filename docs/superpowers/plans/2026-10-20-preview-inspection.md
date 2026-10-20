# Preview and Formula Inspection Implementation Plan

> **For agentic workers:** Execute the authorized first two improvements with available collaboration agents and root integration, browser acceptance and existing-site publication.

**Goal:** Default to a spacious preview with visible copy/download actions, collapsed HTML and readback tools, and actionable formula warnings that reveal the exact formula in local context.

**Architecture:** Keep every existing source/copy/mapping/progress element and API. A new browser-side helper splits valid formula-number warnings from general notes and builds a separate sandboxed inspection preview from the trusted original conversion. Inspection, disclosure toggles and source viewing are navigation only and never change exported HTML, selected copy scope, picture correspondence or save status.

**Tech Stack:** Existing plain JavaScript modules, native details elements, sandboxed Blob iframes, Node tests, Playwright CLI/Edge, existing Cloudflare Pages/D1 and GitHub connector.

## Global Constraints

- Implement preview simplification and formula inspection only; detailed readback text diff remains outside this update.
- Keep the original converter output, formula indices, manifest, export ZIP, section fragments and progress identity byte-for-byte unchanged. No new dependency, format, school request, account or persistence.
- Preserve existing copy/download/preview IDs. Copy and export actions remain visible outside collapsed `source-details`. Clipboard denial opens that disclosure before selecting `source` for manual Ctrl+C.
- Keep all readback inputs and buttons in default-collapsed `compatibility-details`. Generating a probe or performing comparison while inside it continues to work.
- Actionable warnings require exactly one unambiguous positive integer global formula reference that exists in manifest order. Keep every other warning as ordinary text. Never infer a target from an invalid or unavailable index.
- Formula inspection uses only `current.preview` and `manifest.formulas`, never pasted school HTML or mapped school addresses. Inspect the original full document without changing section selection or caches. Display TeX as text, not executable markup.
- The inspection iframe keeps `sandbox=""` and restrictive local-only CSP. Original preview remains sandboxed. No same-origin or script permission, external image fetching or postMessage channel.
- Use exact MathML document-order count/order checks before highlighting. For PNG, identify only when trusted descriptors and image ordering are unambiguous; otherwise show the correct manifest formula text with a clear unavailable-position note instead of guessing.
- Reset/revoke inspection resources on successful new document or progress restore; failed conversions retain current inspection alongside existing work. Recovering expired jobs must not enable external image requests. Close returns focus to the relevant action when possible.
- Native/server static imports, browser builder module resolution and distribution source/license manifests must include the new helper. Preserve existing D1 and visitor count.

## Task 1: Disclosure layout and inspection markup

**Files:** `public/index.html`, `public/style.css`.

- [x] Make `workspace` one column so preview uses available width. Keep `copy` visible in the preview header and `download` outside collapsed source; retain `counts`, `source-note`, `export-note`, `source`, `warnings` once each.
- [x] Add default-closed `source-details` and `compatibility-details`; maintain input labels and keyboard-accessible native summaries. Avoid hiding controls needed for normal copy or image mapping.
- [x] Add initially hidden `formula-warning-panel` with `formula-warning-summary` and `formula-warning-list`. Add initially hidden `formula-inspection` with title `formula-inspection-title`, note `formula-inspection-note`, iframe `formula-inspection-preview`, text-only TeX `formula-inspection-tex`, and button `close-formula-inspection`.
- [x] Style warnings, inspection and disclosures coherently with existing UI; 360 px layout must not overflow.

## Task 2: Formula warning and inspection helper

**Files:** create `public/formula-inspection.js`, `tests/formula-inspection.test.mjs`.

**Interfaces:**

```js
collectFormulaWarnings(result); // { actionable: [{message, index}], general: [message] }
createFormulaInspection(result, index, options); // {index, tex, preview, anchor, available, reason}
// options may inject parseDocument for deterministic structural tests; default
// uses the browser DOMParser on trusted original conversion HTML only.
```

- [x] Test valid/deduplicated warnings, out-of-range/ambiguous/non-numeric references, empty/malformed manifests, Unicode/HTML-like formula text, and index/order validation.
- [x] Return a local inspection preview and safe unique anchor when exact formula location is verified. Add highlight CSS only to the inspection clone. If a location cannot be confirmed, return the exact manifest formula text and a readable reason without a false target.
- [x] Verify browser DOM behavior and rendered highlight with real synthetic MathML and native PNG acceptance; pure Node tests cover warning selection, contracts and defensive validation.

## Task 3: Integration and regression

**Files:** root modifies `public/app.js`, `tools/build-browser.mjs`, `src/server.mjs`, `tests/server-progress-modules.test.mjs` and any meaningful focused regression needed.

- [x] Replace plain warning rendering with actionable buttons plus ordinary notes. Click opens inspection with whole-document formula index and surrounding body, without switching copy scope or changing dirty/correspondence state.
- [x] Allocate/revoke Blob preview resources, handle unavailable locations and close/focus, clear stale inspection when a successful new result commits. Open source-details before clipboard-denied fallback.
- [x] Add the helper to native module routing and browser bundling. Run focused helper/HTTP tests, full `npm test` with native temporary-directory permissions, build Cloudflare package and audit source/license/CRC contents.

## Task 4: Browser acceptance and existing-site update

**Files:** README/browser docs; ignored artifacts under `output/playwright/preview-inspection/`.

- [x] Independent Edge verifies default folded UI, wide preview, accessible copy and download, clipboard-denial fallback expands source, image correspondence and progress save/restore still work.
- [x] Use a synthetic multi-field Word with warnings for at least two distinct global formula indices. Click each warning while another field is selected, verify exact rendered target and nearby context, original scope/mapped HTML/URLs/dirty state unchanged. Close/reopen and successful replacement clear stale resources. Invalid/out-of-range warnings remain text.
- [x] Verify restrictive sandbox/local CSP and zero school/external image requests; use only synthetic source. Inspect 360 px and desktop screenshots.
- [ ] Publish the same Cloudflare project with the same D1 binding, verify live hashes and workflow, sync GitHub against checked latest main and record CI success in separate release proof.

## Implementation acceptance

- Full regression: 460 passed, zero failed or skipped.
- Independent Edge acceptance: 45 checks passed with synthetic multi-field Word, MathML and native PNG; zero external or school image requests and zero runtime errors.
- Source, license and CRC package audit passed; the helper is included in the 60-file source archive.
- Final deployment, GitHub commit and CI receipts are recorded separately under ignored output artifacts.

