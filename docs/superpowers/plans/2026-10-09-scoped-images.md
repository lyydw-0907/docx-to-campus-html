# Scoped Image Mapping Implementation Plan

> **For agentic workers:** Execute the authorized work with available collaboration agents and root review. This update includes tests, Cloudflare deployment and GitHub synchronization.

**Goal:** Let a user upload, confirm and copy only the pictures used by the selected HZAU form field. Copying the whole document or downloading a complete mapped archive still requires every picture.

**Architecture:** Resolve an optional `sectionId` to the already-produced `assetFilenames` list on both Node and browser APIs. Reuse the importer with scoped asset summaries and the current image-order editor with scoped original images. Keep URLs and confirmed mappings in the document-wide inputs so switching fields does not lose completed work.

**Tech Stack:** Existing JavaScript UI, Node/local Response APIs, JSZip, synthetic Word fixtures, Node regression tests and independent Edge acceptance.

## Global Constraints

- Update only image upload-package scope, image import/confirmation and selected-body copy. Keep Word formatting, formulas, image bytes/positions and form splitting unchanged.
- `sectionId` is optional for import/upload-package APIs; omitted or `whole` keeps the complete-document behavior. Unknown IDs fail. Both `field` and `unassigned` sections may be selected.
- `/api/import-images/:jobId` accepts `sectionId` in JSON. `/api/upload-images/:jobId` accepts it as a query parameter. Selected `/api/export/:jobId` already uses `sectionId` in mapped JSON requests.
- Resolve asset lists from trusted conversion metadata, never from a client-supplied list. Preserve the original document-wide upload filename numbers in filtered ZIPs.
- Validate every required picture URL in the selected scope. Missing/unconfirmed pictures in other scopes must not block it; whole copy and full mapped ZIP continue complete validation. Reject duplicates and invalid URLs within the required list.
- Renamed images need explicit correspondence confirmation; counts/identity ambiguity must not lead to automatic order matching. Capturing a request's section and revision prevents async results from being applied after the user changes scope or document.
- Existing mappings survive changing scope. A pending unconfirmed draft for another section does not block a completed section. Editing URLs continues to invalidate cached mapped HTML.
- Uploaded/pasted school HTML is parsed as text only. Do not upload to school, save/submit school materials, or request mapped school images. Public tests and deployment must contain only synthetic Word and safe test domains.
- Preserve existing production D1 binding and count; no database reset or extra site.

### Task 1: API scope

**Files:** `src/image-scope.mjs`, `src/server.mjs`, `browser/local-api.js`, `tests/server-section-copy.test.mjs`, `tests/browser-local-api.test.mjs`, scoped API tests if needed.

Use a shared selection helper with this contract:

```js
const selected = sectionId === undefined || sectionId === 'whole'
  ? { id: 'whole', assetFilenames: result.assets.map(asset => asset.filename) }
  : result.sections.find(section => section.id === sectionId && ['field', 'unassigned'].includes(section.kind));
if (!selected) throw new Error('该栏目不存在，请重新选择。');
const assets = selected.assetFilenames.map(name => result.assets.find(asset => asset.filename === name));
if (assets.some(asset => !asset)) throw new Error('栏目图片与转换清单不一致，请重新转换。');
```

- [x] Add meaningful tests with two differently imaged fields and a text-only field: one field copies with only its URLs, the other stays blocked, whole copy/ZIP reject incomplete mappings, scoped import and ZIP include only their assets with original numbering, invalid IDs and duplicate URLs reject.
- [x] Implement trusted scoped asset resolution and integrate the three routes in both runtimes.
- [x] Run `node --test tests/server-section-copy.test.mjs tests/browser-local-api.test.mjs` plus new API tests; expect all pass.

### Task 2: Scoped UI

**Files:** `public/image-mapping.js`, `public/image-order.js` if needed, focused UI tests, `public/index.html` if wording requires it.

Capture current copy scope and filter assets, using the existing selection state:

```js
const selected = getCopyState();
const required = new Set(selected.assetFilenames);
const scopedAssets = current.assets.filter(asset => required.has(asset.filename));
const payload = { html, pageUrl, sectionId: selected.id };
const uploadPath = `upload-images?sectionId=${encodeURIComponent(selected.id)}`;
```

- [x] Validate copy readiness using only selected asset inputs, while full mapped download validates all inputs.
- [x] Scope upload ZIP, pasted-source import, editable order rows and confirmation. Preserve document-wide input addresses and original picture numbers across selection changes.
- [x] Guard async import/copy from stale document/section state. Scope pending confirmation and show readiness counts clearly.
- [x] Verify reordered two-image field, another field with missing URLs, text-only field, changing scopes during import, and whole download blocking.

### Task 3: Integration and publication

**Files:** root integration only as needed in `public/app.js`, builder adaptation in `tools/build-browser.mjs`, `README.md`, `docs/browser-version.md`, this plan.

- [x] Run full `npm test`, `npm run build:cloudflare`, and archive/license/source checks.
- [x] Independent Edge: use synthetic multi-field Word, download only selected images, import renamed reversed pictures, confirm/copy one field before preparing other pictures, finish the remaining field, and copy/download whole; mapped school URLs must never be fetched.
- [x] Update usage/API documentation to explain selected-picture scope and complete-document requirements.
- [x] Publish the existing Cloudflare production project with its existing binding/configuration and verify live behavior. Synchronize GitHub against its latest main, preserve existing tutorial, and confirm Actions success.
