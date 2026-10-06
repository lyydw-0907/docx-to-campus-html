# Current Section Copy and Performance Repair Plan

**Goal:** Make the confirmed-image workflow copy the selected field even when it has no images, with clear progress and without loading school images in the preview.

**Architecture:** Share one section-copy action between both controls. Add a compatible scoped JSON export for only the current body, cache mapped bodies per field, keep original local previews and reuse existing image-order controls when confirming.

**Constraints:** Preserve field selection, mathematical/image subtrees, draft inputs and stale-response checks. No school requests, uploads or submissions; use synthetic URLs in tests and keep actual Word artifacts ignored.

- [x] Add scoped `sectionId` JSON export and tests in `src/server.mjs` and `tests/server-section-copy.test.mjs`; legacy full JSON/ZIP remains supported. Validate the existing complete image mapping, then rewrite only the requested fragment.
- [x] Add `setMappedSection()` and cache content eligibility in `public/section-view.js`; keep previews local for both old/full and new/scoped mapping. Test cached bodies, invalidation and malformed section identity.
- [x] Add a synchronized bottom field selector and help text in `public/index.html`/`style.css`/`app.js`. Share direct copy with the top control; no-image copy bypasses image mapping.
- [x] Update `public/image-mapping.js` with explicit busy state, scoped export, cached direct copy, contextual button guidance and confirmed-order DOM reuse. Preserve mapping revision and field tokens. Synchronize the retained manual-address option when confirming numeric choices.
- [x] Verify real confirmation/copy controls in isolated local Edge using the actual document and synthetic image URLs; cover delay/reselection, no external preview requests, same thumbnail nodes after confirmation, download compatibility, clipboard fallback and replacing a retained manual address.
- [x] Run appropriate tests, record evidence in `docs/verification.md`, update README, rebuild and privacy-check the source archive, leave the local tool running. Full suite: 259 passed, zero failed/skipped; source ZIP excludes private inputs and ignored artifacts.
