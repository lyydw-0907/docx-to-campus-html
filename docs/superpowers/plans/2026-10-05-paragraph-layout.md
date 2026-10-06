# Paragraph, display-math and list layout repair plan

Goal: Resolve reported list-marker/text overlap, off-center standalone equations and excessive ordered-list marker gaps after restoring Word paragraph styles.

- [x] Reproduce the three issues using the existing actual document and local browser. Distinguish source semantics from web/editor layout; keep source/private content out of repository fixtures.
- [x] Normalize list indentation without stacking native list markers with Word first-line/hanging indent. Keep nested lists, numbering, multiple paragraphs and body indentation intact.
- [x] Center standalone display formulas, including multiple display formulas in one Word paragraph and safe wrappers, while preserving inline formulas and original mathematical content/annotations/numbers.
- [x] Add focused synthetic tests for the actual failure cases, verify real content/math/image invariants and browser geometry, and run the full suite.
- [x] Update verification notes and source archive; leave the local tool running. No school writes, credentials or actual input edits.
