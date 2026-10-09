# Save and Restore Work Progress Implementation Plan

> **For agentic workers:** Implement the authorized feature with available collaboration agents and root integration/review. Complete local and live acceptance, existing Cloudflare publication and GitHub synchronization.

**Goal:** Download one progress file containing the original Word and working state, then restore it after reload without repeating picture mapping or losing unconfirmed order edits.

**Architecture:** A versioned ZIP stores only `source.docx` and `progress.json`, using STORE entries and bounded parsing. On import, read and verify the original Word, reconvert using saved settings, compare a canonical conversion fingerprint, validate the mapping snapshot against fresh assets/sections, and finally replace the current workspace. Failed or cancelled imports keep the existing workspace.

**Tech Stack:** Existing browser/native JavaScript UI, Web Crypto, a fixed two-entry ZIP codec without new dependencies, Node tests, Playwright CLI with independent Edge, existing Cloudflare Pages/D1 and GitHub connector.

## Global Constraints

- Original DOCX at most 20 MiB, metadata at most 16 MiB, progress archive at most 38 MiB. Only STORE, two unique fixed file paths, matching central/local headers, exact sizes and valid CRC are accepted; reject encrypted, ZIP64, multipart, compressed, extra or overlapping entries before allocating decoded contents.
- `progress.json` uses `format: 'campus-work-progress'`, `version: 1`, `sourceName`, `sourceSha256`, `conversionSha256`, `params`, `selectedSectionId` and `mapping`. Unsupported versions fail clearly. No job IDs or cached converted HTML are restored.
- Conversion settings come from the successful remembered conversion, never from settings changed in the UI for the next conversion. Keep MathML-only restriction online; local PNG progress can only resume in compatible local runtime.
- Map all restored scopes/assets against trusted fresh conversion metadata. Preserve confirmed addresses, current scope, per-scope pasted source/page URL, and exact unconfirmed order selections/pending filename subsets. Preserve unfinished manual address text without making unsafe strings clickable or copyable.
- Confirmation never upgrades an unfinished draft. Confirmed row choices must equal stored global addresses and be complete/valid; shared confirmed rows may coexist with other pending rows. Malformed image-choice URLs, unknown scope/filename, duplicate selection/index, contradictory confirmation flags or dangerous object keys fail before changing the workspace.
- Saving captures one coherent state. A document/state change before completion discards the stale download. Restoration locks editing, supports cancellation, and commits only after all checks pass. Changing document/file or cancelling invalidates pending work, even if the old scope is later reselected.
- The progress file contains the original Word and entered content and is user-downloaded; no automatic persistent browser storage, external upload, school request or submission. The public package contains only the existing synthetic Word examples. Preserve existing production site, D1 binding and visit counter.

## Task 1: Bounded progress package

**Files:** create `public/work-progress.js`, `tests/work-progress.test.mjs`; root adds canonical identity export to `public/job-recovery.js`.

**Interfaces:**

```js
export async function createWorkProgress({ input, name, params, result, mapping, selectedSectionId }) {} // Uint8Array
export async function readWorkProgress(input) {} // { source: Uint8Array, progress }
export async function fingerprintConversion(result) {} // SHA-256 hex
export async function validateRestoredProgress(progress, result) {} // asserts fingerprint/params/selected scope
// job-recovery.js
export function conversionIdentity(result) {} // existing canonical JSON identity, excludes jobId/preview
```

- [x] Write failing tests: complete/partial snapshots roundtrip, Unicode filename, source tampering, unsupported version, malformed metadata, wrong conversion/scopes/settings, cancellation-independent pure codec, size/bounds/CRC/overlap/compression/path violations.
- [x] Implement strict fixed-entry STORE ZIP encoder/reader, bounded UTF-8 metadata, source digest verification and conversion fingerprint checks. Only metadata passes to mapping validation, never executable HTML.
- [x] Run `node --test tests/work-progress.test.mjs`; all tests must pass without networking.

## Task 2: Mapping snapshot and restoration

**Files:** modify `public/image-mapping.js`, `public/image-order.js`, `tests/image-mapping-scope.test.mjs`, `tests/image-order.test.mjs`.

**Interfaces:**

```js
// createImageMapping return methods; validateState does not access or mutate DOM.
mapping.exportState();
mapping.validateState(snapshot, freshResult);
mapping.restoreState(snapshot); // validates against current, then synchronous apply
// Snapshot
({ version: 1, urls: { filename: 'entered text' },
   sources: [{ sectionId, html, pageUrl }],
   orders: [{ sectionId, images: [{ index, url }],
     rows: [{ filename, selection, existingUrl, keepUrl }],
     pendingFilenames: ['filename'], confirmed: false }] });
```

- [x] Add production-module tests for per-scope source, manual URLs, confirmed reversed order, unconfirmed adjusted rows and shared partially-confirmed rows surviving roundtrip.
- [x] Validate unknown/duplicate IDs and choice indices, invalid clickable URLs, false confirmation upgrades, exact trusted assets and row consistency without fetching saved URLs. Allow unfinished manual text but keep validation blocking its copy.
- [x] Restore mapping by building fresh controls with current local thumbnails, incrementing revision, discarding async operation references and clearing mapped-copy caches. Retain the builder's exact asset source adaptation line.
- [x] Run `node --test tests/image-mapping-scope.test.mjs tests/image-order.test.mjs`.

## Task 3: Controls and transactional integration

**Files:** root creates `public/progress-actions.js`, `tests/progress-actions.test.mjs`; modifies `public/app.js`, `public/job-recovery.js`, `public/index.html`, `public/style.css`, `tools/build-browser.mjs` and focused integration tests as needed.

**Interfaces:**

```js
createProgressActions({ capture, isCurrent, convert, validate, commit,
  download, status, busy, cancelConversion }); // save(), restore(input), cancel(), isBusy()
jobRecovery.getInput(); // { input, params } for the current successful conversion
// Import ordering:
const candidate = await readWorkProgress(file);
const result = await convert(candidate.source, candidate.progress.params, signal);
await validateRestoredProgress(candidate.progress, result);
validateMapping(candidate.progress.mapping, result);
commit(result, candidate); // only now showResult, mapping.restoreState and remember
```

- [x] Add save/restore controls with native file input; disable save before successful conversion and show that progress files include the original Word and entered content.
- [x] Capture remembered Word/settings and exact mapping/selected scope; save only if its context remains current. Preserve the successful input filename separately from any newly selected file.
- [x] Restoration converts a candidate without clearing old UI. Lock editable controls, provide cancellation, validate completely and apply synchronous state last; errors/unsupported settings/cancellation leave old workspace and selection intact.
- [x] Update browser bundler module resolution/adaptations; preserve local/native behavior and existing browser cancellation.
- [x] Test stale saves, failed/cancelled/mismatched imports, successful commit ordering, concurrent actions and setting preservation using real production controller callbacks.

## Task 4: Acceptance and publication

**Files:** root updates `README.md`, `docs/browser-version.md`, this plan; generated QA records remain in ignored `output/`.

- [x] Run complete `npm test`, `npm run build:cloudflare`, package/source/license/CRC audit and independent review.
- [x] Independent Edge: save a three-image multi-field synthetic document with one confirmed field and one pending reversed draft, reload, import only the progress file, verify form/settings/scope/URLs/sources/order state and actual copy; confirm unfinished order and finish full copy/download. Save partially invalid manual text and restore it still blocked. Reject mismatched/tampered files while keeping existing work. Cancellation/retry and text-only progress also work. Record zero school image requests.
- [x] Publish the existing Cloudflare site with the existing D1 configuration, verify live bundle hashes and resume workflow, retain the counter. GitHub synchronization and CI are recorded in the release proof when completed.
- [x] Update usage/documentation with the progress workflow, local-file data handling and actual validation evidence; deliver the existing online link.

