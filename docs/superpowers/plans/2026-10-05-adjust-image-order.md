# Adjustable image correspondence implementation plan

**Goal:** Let users correct which school image belongs to each original Word image before applying image URLs.

**Architecture:** The existing safe HTML parser supplies all image choices with their original source indices. A pure browser mapping model initializes from already filled URLs, swaps occupied numeric selections, preserves external manual URLs explicitly, and validates all final URLs. The interface shows one selector per original image, commits changes only after confirmation, and stays editable after confirmation.

**Tech stack:** Existing Node/Cheerio API, browser modules, Node test runner, isolated local Playwright CLI verification.

## Constraints

- Do not fetch school images or render pasted HTML. Show local originals and school URL text only.
- Preserve original Word image order and formula content; adjust URL correspondence only.
- Initialize from already filled addresses. Manual URLs absent from pasted source use an explicit retained-address option.
- Changing an occupied numeric source index swaps numeric assignments; if the previous selection is empty or a retained manual URL, clear the displaced row instead of assigning it another image's manual URL.
- Missing, duplicate or unsafe final URLs block confirmation; users must confirm before edited assignments can be copied or exported.
- Manual edits share final-address validation, and the server rejects duplicate normalized URLs during mapped export.
- Source HTML, page URL, manual input edits and a new Word conversion invalidate the draft. Automatic local job recovery preserves it.

## Task 1: Mapping model and API choices

Files: `public/image-order.js`, `tests/image-order.test.mjs`, `src/image-import.mjs`, `tests/image-import.test.mjs`, `src/server.mjs`.

- [x] Implement `createImageOrder({ assets, images, existingUrls })` returning `{ rows(), select(filename, value), validate() }`.
- [x] Verify first/last swaps, cyclic changes, non-contiguous source indices, existing links, retained manual links, displaced selections, missing choices, duplicate final links and unsafe URLs.
- [x] Add `imageChoices: [{index,url}]` and `canAdjustOrder` to the safe parser response. Allow only a complete, unambiguous set of safe unique images with the same number of original assets.
- [x] Serve the new browser module and run targeted tests.

## Task 2: Editable correspondence interface

Files: `public/image-mapping.js`, `public/index.html`, `public/style.css`, `public/app.js`.

- [x] Add a selector and selected URL per original image, show when an existing address would change, and report automatic swaps or a displaced empty selection.
- [x] Replace the order-only confirmation with confirmation of the selected correspondence. Keep the panel editable after confirmation.
- [x] Preserve existing values by default, apply explicit confirmed changes, and block copy/download while a draft is unconfirmed.
- [x] Offer adjustment even after all URLs have been identified; maintain exact-match results and original numbering when only some filenames survive.
- [x] Guard in-flight mapped exports using the mapping revision, in addition to document identity.
- [x] Verify desktop/mobile layout without external requests, then run `npm test` once; rerun after fixing the review finding for direct manual duplicates.

## Task 3: Product verification and delivery

- [x] Use a real local Word conversion with nine images and renamed test URLs. Swap two images, confirm and check copied HTML places URLs correctly without changing mathematical nodes.
- [x] Verify empty selections block confirmation, new source invalidates the draft, manual addresses survive by default and change only after explicit selection and confirmation.
- [x] Verify the draft remains correct after local job eviction/recovery, and a confirmed correspondence can be adjusted again.
- [x] Update user instructions, local verification notes and source archive. Keep private documents/test output out of source packaging.
- [x] Keep the local tool available and explain how to retain the currently pasted school source before refreshing to load the new interface.
