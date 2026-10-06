# Preserve Word paragraph and font formatting implementation plan

**Goal:** Preserve each Word paragraph's first-line indent and alignment, and offer original run/formula sizes by default in the browser.

**Architecture:** Read OOXML defaults and basedOn styles before conversion. A disposable in-memory DOCX copy adds unique paragraph/character styles based on the originals, letting Pandoc's docx+styles reader identify each paragraph/run without text matching. Restore safe styles to AST nodes, remove temporary identities, use per-formula sizes, and keep the original input unchanged for recovery.

**Tech stack:** Existing JSZip/Cheerio, Pandoc 3.6.4, browser modules, Node tests, isolated local Edge.

## Constraints

- Never change the supplied Word file or put private text, school links or actual documents in source/tests.
- Keep source mathematics, annotations, numbering, image bytes, three-line tables and the image correspondence workflow.
- First-line character units use hundredths of a character; twentieth-point indents use 96/1440 CSS px. Resolve style inheritance before direct overrides; explicit zero resets indentation.
- Original Word sizes use half-point units converted to CSS px (value * 2/3); original-mode formulas follow their source paragraph/controls. Uniform mode retains current formula sizing and remains the API/CLI default for compatibility.
- Source font sizes with missing values use the chosen fallback. Unsupported or ambiguous formatting is reported rather than assigned to other content.
- Generated styles pass the existing HTML allowlist; source HTML is still rejected.
- All verification is local. School save/reopen behavior for the new styles remains unverified.

## Task 1: OOXML format extraction and precise AST restoration

Create `src/word-format.mjs` and `tests/word-format.test.mjs`.

Interfaces:

```js
const prepared = await prepareWordFormatting(input, {fontMode, fontSize});
// {input: Buffer, ...private lookup data}
const formatting = restoreWordFormatting(ast, prepared);
// Mutates ast to remove private labels; returns
// {paragraphStyles: Map<ASTNode,string>, mathFontSizes: Map<ASTNode,number>, warnings: string[], summary: object}
```

- [x] Resolve defaults, paragraph/character basedOn chains and direct overrides with a bounded cycle check.
- [x] Extract text-align, first-line/hanging indent, side indents, and run sizes. Use styles on the outer paragraph so mixed-size spans do not change first-line indent unexpectedly.
- [x] Annotate the temporary copy with paragraph/character custom styles; preserve semantic headings, lists, tables, hyperlink content and actual mathematics.
- [x] Restore Div/Span and Header marker classes to safe CSS, strip all temporary identities and map nested math node sizes before generated styling is inserted.
- [x] Test direct versus inherited formatting, zero resets, mixed run sizes, centered captions, nested table paragraphs, number text, missing defaults and malformed/cyclic styles using synthetic XML.

## Task 2: Conversion and controls

Modify `src/convert.mjs`, `public/index.html`, `public/app.js`, `src/server.mjs`, `src/cli.mjs` and relevant existing tests.

- [x] Use annotated DOCX and docx+styles for Pandoc reading; restore AST formatting before equation analysis.
- [x] Preserve paragraph CSS when normal paragraphs are written, and use source formula size for MathML/PNG and equation number text.
- [x] Allow generated text-indent and side-margin CSS; sanitize each mathematical tree with the recorded formula size.
- [x] Add `fontMode: 'word' | 'uniform'`, reject invalid modes, and record it in the manifest. Browser defaults to original Word sizes; API/CLI retain uniform default and provide the option explicitly.
- [x] Include font mode in browser conversion/recovery params; preserve image mapping behavior.
- [x] Test an actual synthetic DOCX with first-line/zero indent, centered image caption, mixed sizes and native math; verify uniform override does not remove alignment/indent.

## Task 3: Verification and delivery

- [x] Compare actual Word source formatting with converted paragraphs/runs and all mathematical content without exposing private text.
- [x] Inspect original-size and uniform-size modes through the local browser, confirm captions/images centered and first-line indentation visible, and verify both download/mapped export preserve the formatting.
- [x] Run the appropriate tests, then the complete suite once the final changes are ready.
- [x] Update README/verification notes and source archive; verify CRC and exclusion of private input/output.
- [x] Keep the local server available; tell the user to retain school source before refreshing and reconverting with original Word sizes.
