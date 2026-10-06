# Borderless figure-layout tables

Goal: Remove all rules from tables used to arrange images and figure captions, while ordinary data tables keep three-line formatting.

- [x] Inspect the actual nested image tables and classify only image/caption layout content; protect outer mixed-content tables, data tables and equation layouts.
- [x] Clear borders on each figure table and its own rows/cells/groups, preserving placement, sizes, caption formatting and merge attributes.
- [x] Add focused synthetic classification/integration tests, verify actual document content and browser appearance, and run the full suite.
- [x] Update notes/source archive and keep the local service available. No school writes or source Word edits.
