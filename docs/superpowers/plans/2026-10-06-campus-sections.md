# Campus Application Sections Implementation Plan

> **For agentic workers:** Implement the bounded tasks below with the current collaboration tools; review the section extraction independently before integration.

**Goal:** Export separate body fragments for the confirmed HZAU application fields without duplicating the system's blue labels.

**Architecture:** Split the already sanitized HTML at sibling headings in a single, confidently identified section container. Keep the existing whole-document fragment intact. The local UI selects a section and uses its own preview, fragment, and referenced assets; image mapping rewrites the same section fragments.

**Tech Stack:** Node.js 22, Cheerio, JSZip, browser ES modules, node:test, isolated Edge verification.

## Global Constraints

- Never alter the original Word or write to the school system.
- Confirmed labels: 研究目的; 国内外研究现状和发展动态; 研究内容; 创新点与项目特色; 技术路线、拟解决的问题; 项目研究进度安排; 已具备的条件，尚缺少的条件及解决方法; 预期成果.
- Map Word 已有基础 to the confirmed conditions field. Keep 参考文献 as separately visible unassigned content until its destination is known.
- Remove only the exact outer field heading. Keep inner numbered headings, mathematics, images, captions, sizes, and styles.
- Ambiguous or unsupported boundaries never cause partial silent extraction; retain the whole-document result and explain the missing section split.
- Retain the existing complete-image mapping workflow and job expiry recovery. No accounts, document text, or uploaded URLs in source or tests.

### Task 1: Conservative extraction

**Files:** Create `src/sections.mjs`, `tests/sections.test.mjs`.

**Interfaces:** `splitCampusSections(fragment, { assets = [] } = {}) -> { sections, warnings }`. Each section: `{ id, title, kind, sourceHeading, fragment, assetFilenames, formulaCount, imageCount }`.

- [x] Write synthetic tests for sibling headings in a single-cell document table, same-name nested subheadings, unknown sibling sections, all typography/math/image preservation, duplicate boundaries, and ambiguous multiple containers.
- [x] Run `node --test tests/sections.test.mjs` and implement extraction. Normalization removes spacing, comma variants and a terminal colon, not arbitrary prefixes. Use same-level headings from one sibling container; no paragraph keyword detection.
- [x] Verify preservation by comparing each retained source subtree against the extracted subtree and ensuring a section never crosses a sibling heading.

### Task 2: Conversion, mapped export and archive integration

**Files:** Modify `src/convert.mjs`, `src/server.mjs`, `tests/server.test.mjs`.

```js
const split = splitCampusSections(fragment, { assets });
const sections = split.sections.map(section => ({ ...section,
  preview: previewDocument(section.fragment, imageMode, formulaFormat, section.assetFilenames.length > 0) }));
```

- [x] Return sections from conversion and retain whole-document output.
- [x] Rewrite section fragments and previews in `mapExport`; include sections in mapped JSON. Keep manifests free of uploaded URLs.
- [x] Add `sections/<id>.html` to ZIP and a small index explaining destination and unassigned status. Preserve existing archive files and image bytes.
- [x] Test mapped sections and HTTP/ZIP output with synthetic Word headings; invalid mappings retain current behavior.

### Task 3: Section preview and copy

**Files:** Modify `public/index.html`, `public/app.js`, `public/image-mapping.js`, `public/style.css`; add a focused browser module/test only if needed for independently testable selection state.

- [x] Add a labelled select with confirmed fields, unassigned content, and whole-document view. Default to the first confirmed field. The blue system label is a UI destination hint, not exported markup.
- [x] Section switches update preview, source, counts, and copy eligibility using that section's assets. Text-only sections remain copyable while other fields' images await mapping.
- [x] Cache all mapped sections, invalidate them on any mapping edit, preserve current selection, and guard asynchronous copy against selection changes.
- [x] Verify actual Word in isolated local Edge, all known fields, retained same-name subheading, conditions alias, reference visibility, image-field mapping, and no duplicate field label.

### Task 4: Verification and delivery

**Files:** Update `README.md`, `docs/verification.md`.

- [x] Run `npm test`, with no unexplained failures or skips.
- [x] Compare actual-document section sums and all retained math/image nodes; recheck original Word hash.
- [x] Restart only the project-owned local server and verify HTTP 200.
- [x] Rebuild the source archive and run the privacy verifier; report completed local behavior and any remaining destination ambiguity.
