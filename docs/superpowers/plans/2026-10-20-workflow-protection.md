# Workflow Protection Implementation Plan

> **For agentic workers:** Execute the authorized changes with the available collaboration agents and root integration, review, browser acceptance and publication.

**Goal:** Explain image-free scopes, preserve current work when a new conversion fails, show unsaved progress and make section processing easier to follow.

**Architecture:** Keep conversion candidates separate from the displayed result until success. A small in-memory revision tracker reports unsaved work and guards page exit; the existing ZIP remains the only persistent user progress. Mapping exposes read-only scope readiness and change notifications, allowing clear empty states and section progress without changing copy validation.

**Tech Stack:** Existing JavaScript modules, Node test runner, native and WASM conversion APIs, Playwright CLI/Edge, existing Cloudflare Pages/D1 and GitHub connector.

## Global Constraints

- Preserve MathML-only online and MathML/PNG locally. No new dependencies, private document fixtures, automatic browser persistence, school uploads or submissions.
- Conversion error, cancellation or demo-fetch failure must retain old result, original successful input/settings, image source, addresses, unconfirmed order, selection and usable thumbnails. Only a successful candidate replaces them.
- New successful conversion starts unsaved. Actual mapping/source/order changes mark dirty. ZIP download clears dirty only for the same document/revision; failed, cancelled or stale saves do not. Successful ZIP import starts clean. Copies, exports and previews never mark saved.
- Selecting a copy scope alone is navigation, not an unsaved content edit. New conversion settings apply to the next conversion and do not dirty saved current work. No school-save claims: copied status means clipboard success only.
- Attach beforeunload protection only while there is unsaved current work. Respect native browser confirmation behavior; do not implement a custom dialog or disable leaving.
- No-image scopes hide upload/import/order/manual controls and show a local explanation plus an explicit switch-to-whole-images action. Keep scope-specific pasted source and image drafts when switching; do not move another scope's pasted source automatically.
- Preserve old global/scoped validation, shared image behavior, job expiry recovery, ZIP compatibility and existing visitor counter/database.

## Task 1: Mapping empty states and section readiness

**Files:** `public/image-mapping.js`, `public/index.html`, `public/style.css`, `tests/image-mapping-scope.test.mjs`.

**Interfaces:** `createImageMapping` gains optional `onChange()` and `onScopeSelect(id)` callbacks, plus `scopeStatus(id)` returning `{empty, imageCount, missingCount, unconfirmed, ready}` without changing selection or caches. DOM includes `image-empty-state`, `image-empty-message`, `show-whole-images`, `mapping-image-controls`, `progress-state`, `next-section` and `mapping-next-section`.

- [x] Add focused tests for no-image message/hidden controls, whole-image switch preserving pasted text, scope status for missing/duplicate/pending/shared pictures, and change notification coverage without refresh/copy false positives.
- [x] Implement local empty-state presentation, pure readiness query and mutation notifications. Root supplies the selection and dirty callbacks.
- [x] Run `node --test tests/image-mapping-scope.test.mjs tests/image-order.test.mjs`.

## Task 2: Unsaved revision tracking and save observers

**Files:** create `public/progress-guard.js`, `tests/progress-guard.test.mjs`; modify `public/progress-actions.js`, `tests/progress-actions.test.mjs`.

**Interfaces:** `createProgressGuard({onChange, now})` returns `newDocument()`, `changed()`, `capture()`, `saved(stamp)`, `restored()`, `snapshot()` and `beforeUnload(event)`. Observer callbacks `onSaved(snapshot)` and `onRestored()` fire in `createProgressActions` only after successful download/commit.

- [x] Test initial/new/changed/saved/restored state, actual save timestamp, stale document/revision saves, no-document changes, beforeunload preventDefault only when dirty, and observers skipped on errors/cancellation.
- [x] Implement an in-memory document/revision tracker with no DOM/storage dependencies; callbacks must not change operation success semantics.
- [x] Run `node --test tests/progress-guard.test.mjs tests/progress-actions.test.mjs`.

## Task 3: Candidate conversion and application integration

**Files:** root adds `public/conversion-actions.js` and `tests/conversion-actions.test.mjs`; modifies `public/app.js`, `public/section-view.js`, `tools/build-browser.mjs`, `src/server.mjs` and appropriate focused tests. Replacement rollback uses the private `imageMapping.captureForReplacement()` closure to retain oversized unfinished text without accepting unvalidated external progress.

- [x] Keep old UI/result/job input intact during new conversion; freeze editing temporarily, capture conversion settings once, pass `preserveJobId` to local browser conversion and commit/remember only on success. Error/cancel restores usability of the old state. Test real API and browser failure/retry.
- [x] Connect guard to successful conversion, mapping mutation callbacks and ZIP observers. Render persistent save status and add/remove beforeunload listener when dirty changes. Settings and copy/cache changes do not fake content edits or saved progress.
- [x] Render per-section missing/pending/ready/copied labels and next-field buttons, clear copied markers after content edits and never claim school persistence. Mark copied only after clipboard success.
- [x] Resolve new browser modules and local static routes. Run focused tests and full `npm test` with native temporary-directory permissions as needed.

## Task 4: Acceptance and existing-site update

**Files:** README/browser usage docs; ignored QA artifacts in `output/playwright/workflow-protection/`.

- [x] Independent Edge: no-image scope explains itself, switching to whole does not lose source, first complete field copy is independent of another pending field, next-field labels work and clipboard success alone marks copied.
- [x] Save ZIP -> clean status/no exit prompt; edit school source/manual URL/order -> dirty prompt; stay on beforeunload keeps work; completed ZIP download/import restores clean status; cancelled/failed/stale save/import cannot clear dirty status.
- [x] Invalid DOCX, cancelled WASM conversion and failed demo fetch preserve old source, selected section, image mappings/order, remembered original Word and usable thumbnails; successful retry replaces them and marks new work dirty. Verify mobile layout and zero school requests.
- [x] Build/audit static and Cloudflare packages, publish the original Cloudflare project with its existing D1 binding, verify live hashes and flows, record GitHub synchronization against a checked expected main parent and CI success in the separate ignored release proof.

