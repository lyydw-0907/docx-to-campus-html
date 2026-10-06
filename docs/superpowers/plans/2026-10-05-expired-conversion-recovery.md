# Expired conversion recovery implementation plan

**Goal:** Resume image recognition, image downloads and HTML export after a local conversion expires or the service restarts, without clearing pasted school HTML or changing document/image identity.

**Architecture:** Return `410` with `code: JOB_EXPIRED` for unavailable jobs. A browser client retains the converted input and the exact request parameters, performs one shared recovery conversion, verifies identical embedded HTML and ordered assets, updates only the existing result's job ID, and retries the requested local operation once.

**Tech stack:** Existing Node HTTP server, browser modules, Node test runner, Playwright CLI for local browser verification.

## Constraints

- Do not access, upload to, save or submit anything in the school system.
- Retain the actual converted Blob/File and its parameters, independently of later file/dropdown selections.
- Never use `convert`, `showResult` or `imageMapping.reset` for automatic recovery; preserve school HTML, base URL, manual image URLs and current object identity.
- Recover only on structured `JOB_EXPIRED`; never retry validation errors or ambiguous/mismatched results.
- Single-flight recovery; stale requests cannot replace a newer conversion. Retry each operation once.
- Retained browser input is in memory only; no accounts, cookies or private documents enter source files or archives.

## Task 1: Recovery client and unit verification

Files: `public/job-recovery.js`, `tests/job-recovery.test.mjs`.

Interface: `createJobRecovery({ getCurrent, fetchRequest = fetch, onRecovering, onRecovered })` returns `{ remember(result, input, params), clear(), request(route, init) }`.

- [x] Test an expired image-import request: original input/options are reused, returned job ID changes on the same result object, requested import retries once.
- [x] Test shared recovery for concurrent expired requests, stale conversion rejection, changed fragment/assets rejection, validation errors without retry, and a second expired response without a retry loop.
- [x] Implement the client. `remember` snapshots parameters; `clear` invalidates pending work; recovery checks fragment and ordered assets before mutating `result.jobId`.
- [x] Run `node --test tests/job-recovery.test.mjs`.

## Task 2: Server and browser integration

Files: `src/server.mjs`, `tests/server.test.mjs`, `public/app.js`, `public/image-mapping.js`.

- [x] Add missing-job API coverage for import, upload, assets and export; assert `410` and `JOB_EXPIRED` rather than inferring from Chinese error text.
- [x] Add the module to the static whitelist and use a structured missing-job error from `getJob`.
- [x] Remember successful conversion inputs/options, clear recovery when a new conversion begins, and route import/copy/download requests through the recovery client.
- [x] On recovery update asset thumbnail paths only; keep mapping fields and mathematical content intact.
- [x] Guard exports against a document change while awaiting recovery/download bytes.
- [x] Run targeted tests, then `npm test` once.

## Task 3: Local browser verification and delivery

- [x] Reproduce missing jobs with local fixtures or an intercepted local `410`; verify recovery preserves school-source text and manual values, and still requires explicit confirmation for renamed images.
- [x] Check mapped copy retains every mathematical node and image position; no requests go to school image URLs.
- [x] Verify export recovery after local state eviction and switching documents during a pending recovery.
- [x] Document recovery behavior in README and mark completed work here.
- [x] Restart only the verified project server, check local page/module responses, and tell the user to retain their already-pasted source before refreshing to receive the new code.

