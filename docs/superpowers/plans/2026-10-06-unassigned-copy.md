# Unassigned Content Copy Implementation Plan

**Goal:** Enable independent reference/unassigned-content copy while retaining its unresolved school destination.

**Architecture:** Extend existing section eligibility and body-only mapping to the known `unassigned` kind. Keep exact original heading/body and metadata, default field selection, named copy scope, per-section cache, image validation and stale-response guards. A text-only unassigned section copies directly without requiring images in other parts of the document.

**Tech Stack:** Browser ES modules, Node.js/Cheerio, node:test, isolated local Edge via Playwright CLI.

**Constraints:** No school access or submission. Original Word remains read-only; private local evidence stays in ignored output. Do not assign references to a school field or alter source formatting. Keep empty/unknown sections and mismatched mapping identities blocked.

- [x] Add/update synthetic tests in `tests/section-view.test.mjs` and `tests/server-section-copy.test.mjs`: original unassigned heading/body, no-image direct copy, images/cache/reset, empty source, unknown kind, stale scope and body-only HTTP. Keep cross-kind identity checks. Run focused pair before the product change to demonstrate failure, then after it to confirm success.
- [x] In `public/section-view.js`, use `original.kind === 'field' || original.kind === 'unassigned' || whole` for eligibility. In `src/server.mjs`, accept selected registered sections with kinds field/unassigned; retain the original whole branch and source-map validation.
- [x] In `public/app.js` and `public/image-mapping.js`, use the selected unassigned title for copy/progress/fallback and keep `(待分配内容)` in selectors. Explain independent copying and user-chosen placement. Handle empty source before copy guidance; render destination uncertainty as informational rather than a conversion error.
- [x] Run `npm test` and isolated local browser QA: upper/lower reference copy before and after unrelated image confirmation, range switching, whole copy retention and denied-clipboard Ctrl+C fallback. Compare clipboard against exact original reference fragment; verify school requests remain zero.
- [x] Update README/verification, rebuild/privacy-check source archive, and keep the local tool running. Explain how to apply the UI update while reusing school image source/URLs.

Validation: focused tests26/37 passed before repair, then37/37 passed; full regressions285/285 passed. Local Edge copied the exact original reference heading/body through both actions with unrelated images empty/pending/confirmed, preserved destination uncertainty, and used exact Ctrl+C fallback. Whole source retained189 formulas/9images with only img src rewritten; source Word unchanged, external requests and script errors zero.
