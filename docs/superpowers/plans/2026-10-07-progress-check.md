# Progress Check Sections Implementation Plan

> Historical implementation plan. The original no-GitHub/no-deployment constraint applied during development. The user subsequently authorized the public Cloudflare deployment and this GitHub source update on 2026-10-07. School saves and submissions remain outside this update.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. This session uses the available collaboration tools within the user's authorized scope. No GitHub update or school write is authorized.

**Goal:** Support the two confirmed HZAU progress-check editor fields alongside the existing application form in both the browser and local application.

**Architecture:** Select a school form before conversion. Pass `documentType` through the existing conversion and recovery transport, then use separate confirmed-heading maps in the shared section splitter. Reuse scoped preview, image mapping, copy and ZIP export without changing the full document.

**Tech Stack:** Existing JavaScript UI, Node/local Response APIs, shared OOXML/Pandoc core, Pandoc WASM worker, Node tests and Playwright CLI.

## Global Constraints

- Do not commit, push, update GitHub, deploy publicly, log into school or save/submit school materials.
- `documentType` is `application` (default) or `progress`; no automatic guess between forms.
- Progress fields are `progress-check`: 项目进展检查（项目执行的进展情况，取得了哪些成绩，是否达到预期效果，以及在项目的开展过程中还存在哪些问题）; `later-work-plan`: 项目后期具体工作计划.
- Recognize 项目进展检查 as the short Word heading for the first field; normalize trailing colons, spaces and parentheses. Preserve internal text, source formatting, formulas, figures, numbering and the whole-document export.
- Keep the existing application fields separate. Require confident sibling headings for automatic splitting and retain ambiguous content.
- Input and output remain local. Use synthetic progress documents for acceptance; include no private materials in the static/source package.

### Task 1: Form-specific sectioning

**Files:** `src/sections.mjs`, `src/convert-core.mjs`, `tests/sections.test.mjs` and a focused progress conversion test if needed.

**Interface:**
```js
splitCampusSections(fragment, { assets, documentType: 'progress' });
convertDocx(input, { formulaFormat: 'mathml', documentType: 'progress' });
// result.manifest.options.documentType === 'progress'
// field ids: ['progress-check', 'later-work-plan']
```

- [x] Add a separate progress heading map and validate the two allowed types.
- [x] Test long/short titles, punctuation variants, removed outer labels, retained nested headings/MathML/images and unchanged full HTML.
- [x] Test form isolation, duplicate/mixed-level headings and invalid types. Keep current application tests passing.

### Task 2: UI and transports

**Files:** `public/index.html`, `public/app.js`, `public/style.css` if necessary, `src/server.mjs`, `browser/local-api.js`, `tests/browser-local-api.test.mjs`, `tests/server-section-copy.test.mjs` or dedicated transport tests, `tools/build-browser.mjs`, README and browser documentation.

**Conversion query:**
```js
new URLSearchParams({ documentType: 'progress', formulaFormat: 'mathml', fontMode: 'word', fontSize: '14' });
// Both conversion APIs forward documentType; job recovery keeps the same query.
```

- [x] Add “学校表单” with “申报书” / “项目进展检查”; explain the two Word heading names when progress is selected.
- [x] Pass and validate the option in native/browser APIs; preserve application defaults and reject unknown types before conversion.
- [x] Lock form choice during conversion/demo loading. Keep a short first-field label in the dropdown/button, with its full school wording available as a title/help description.
- [x] Update local documentation and add transport tests proving forwarding and scoped copy.

### Task 3: Browser acceptance and package

- [x] Run focused section and transport tests, then the full existing suite once changes are complete.
- [x] Build with `npm run build:browser`; run a synthetic progress DOCX in independent Edge at `http://127.0.0.1:4318/`.
- [x] Verify both fields, text-only copy while another field has pictures, picture confirmation and mapped copy, whole copy and ZIP section metadata. Confirm no document upload/network school write.
- [x] Check narrow-screen controls and a switch back to application mode, update the static package, and leave GitHub HEAD unchanged.
