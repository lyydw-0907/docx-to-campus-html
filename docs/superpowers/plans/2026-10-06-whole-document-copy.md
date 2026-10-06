# Whole Document Copy Implementation Plan

**Goal:** Let users copy the original complete converted document as well as each school field, with all existing image-confirmation checks.

**Architecture:** Treat `whole` as a copyable selection with its own mapped-body cache. Reuse the body-only export route; resolve `whole` from the original full fragment before selecting a field, without parsing previews or concatenating field bodies. Keep image validation, selection tokens, stale-response cancellation and original local previews.

**Tech Stack:** Node.js, browser ES modules, Cheerio, node:test, isolated local Edge via Playwright CLI.

## Global Constraints

- Preserve original Word, formulas, tables, images, cover and unassigned content.
- No school access, uploads, saves or submissions; no remote publication.
- Actual document evidence stays in ignored output. Public tests use synthetic inputs.
- Copying a whole document does not automatically distribute it among school editors; explain their separate fields in the selection hint.

### Task 1: Verify the old restriction and cover the new behavior

**Files:** `tests/section-view.test.mjs`, `tests/server-section-copy.test.mjs`.

- [x] Add state checks for no-image whole copy, complete whole image mapping, separate field/whole caches, reset, empty body and stale selection tokens. Update the assertions which deliberately refused `whole` in sectioned documents.
- [x] Add body-only whole mapping/HTTP checks using `mapSectionCopy(result, 'whole', urls)`, compare against `mapExport(result, 'mapped', urls).fragment`, and keep missing/duplicate/unsafe-image and no-preview assertions.
- [x] Run `node --test tests/section-view.test.mjs tests/server-section-copy.test.mjs`; confirm the new whole-copy behavior fails before implementation and passes after it.

### Task 2: Open complete-document copy in state and API

**Files:** `public/section-view.js`, `src/server.mjs`.

- [x] Replace snapshot eligibility with `const eligible = original.kind === 'field' || whole;` and remove only the `whole` rejection from mapped-body identity validation. Keep metadata/asset validation, content checks and tokens.
- [x] In `mapSectionCopy`, use `sectionId === 'whole' ? {id:'whole',title:'整篇文档',kind:'whole',fragment:result.fragment,assetFilenames:result.assets.map(a=>a.filename),formulaCount:result.manifest.formulas?.length??0,imageCount:result.assets.filter(a=>a.kind!=='formula').length} : sections.find(s=>s.id===sectionId&&s.kind==='field')`. Retain complete source-map validation and the `{section}` response without previews.

### Task 3: Make copy actions and hints explicit

**Files:** `public/app.js`, `public/image-mapping.js`, `public/section-view.js`, `public/index.html`.

- [x] Name the selection `整篇文档`; use `复制整篇 HTML` and `替换图片并复制整篇 HTML` for this selection. Retain existing field button names.
- [x] Explain that complete HTML contains the cover and all fields, and school field editors can still receive their respective sections. Show mapping progress/confirmation for the full document through the existing workflow.
- [x] Use the selected scope for clipboard success and Ctrl+C fallback; preserve original local previews and all in-flight response guards.

### Task 4: Validate and deliver the local change

**Files:** `README.md`, `docs/verification.md`; ignored local browser evidence and source archive.

- [x] Run full `npm test`, then check real local UI whole-copy before/after image confirmation, field/whole switching, cache invalidation and clipboard fallback. Use synthetic external image URLs without visiting them.
- [x] Compare whole copied fragment to the existing full mapped export, including full formula/image counts. Keep source Word unchanged.
- [x] Update documentation, rebuild/privacy-check source ZIP, keep the local tool running, and tell the user to preserve their school image source before refreshing to apply the new UI.

Validation: focused tests 18 passed/11 failed before repair, then29/29 passed. Full regressions277/277 passed. Local Edge whole-copy evidence confirms189 formulas/9 images, only image src changed, no external requests or script errors, independent caches, confirmation and clipboard fallback. Source Word and image bytes unchanged; source archive includes only public project files.
