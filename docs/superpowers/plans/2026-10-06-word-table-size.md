# Restore Word table dimensions

Goal: Keep converted table width, column proportions and cell spacing close to the source Word document, including the symbol table, without stretching tables to the browser width.

- [x] Inspect source OOXML and Pandoc table layout; identify tables by generated table-style identities and cells by paragraph identities rather than text or global output order.
- [x] Restore safe source widths, column proportions and cell/paragraph spacing while retaining three-line data tables, original horizontal groups and borderless figure layouts.
- [x] Add focused synthetic checks, verify the actual document and browser layout at multiple widths, and run required tests.
- [x] Update verification/source package and keep the local service available. No source Word edits or school writes.

Files: src/word-xml.mjs shares namespace-safe XML helpers; src/word-tables.mjs reads and restores table/cell layouts; src/word-format.mjs owns disposable markers and paragraph spacing; src/convert.mjs transfers safe styles and preserves fractional columns; src/tables.mjs keeps confirmed source horizontal rules. Tests use synthetic DOCX only. Actual-document evidence stays in ignored output/.
