# Website Visit Counter Implementation Plan

> Historical implementation plan. The Cloudflare target is now configured and deployed. The user authorized updating the GitHub source on 2026-10-07; the development-time no-GitHub constraint below no longer applies to that update.

> **For agentic workers:** Use the available collaboration tools to implement independently testable parts. Keep all work local until the actual Cloudflare site and account connection are known; do not update GitHub.

**Goal:** Show a persistent cumulative page-view count on the public tool page without changing document conversion or sending document content.

**Architecture:** A separate homepage module sends one empty same-origin HTTPS POST per page load. A Cloudflare Pages Function atomically increments a single D1 counter row and returns the confirmed cumulative value. Local preview, disabled configuration and preview origins are excluded. Cloudflare's actual production site is required to enable and deploy the interface.

**Tech Stack:** Existing JavaScript/esbuild static application, Cloudflare Pages Functions and D1 SQL, Node tests and independent Edge acceptance.

## Global Constraints

- Preserve local-only Word processing, original formatting, scoped copy and progress/application modes.
- Metric is cumulative page views (PV), not unique visitors or conversion count. Refresh counts again; conversion, downloads and iframe previews do not count.
- Send no body, document, filename, school HTML, school image URL, cookies or visitor identifier. Persist only one total and its start time. The hosting platform still receives ordinary request metadata. Use empty `referrer` with `strict-origin` policy to omit Referer while retaining the browser-generated Origin for the same-origin POST.
- A `campus-visit-counter` meta content config is empty by default. No fetch occurs for empty config, local/file/HTTP pages, cross-origin endpoints or embedded previews.
- Only the configured production origin in `VISIT_COUNTER_ORIGIN` may use the Pages counter endpoint. No public deployment or Cloudflare account/database change is performed without a concrete target.
- Shared contract: `POST /api/visits` returns `{ total: nonnegative safe integer, since: ISO timestamp }`. Read-only `GET /api/visits` does not increment. Responses are never cached. POST requires matching Origin and an empty request body.
- API binding is `VISITS_DB`; migration creates `site_visits` with id `homepage`, nonnegative total and since. Atomic update uses `UPDATE ... SET total = total + 1 ... RETURNING total, since`.
- Do not use localStorage/sessionStorage as a whole-site counter or show an invented zero when the service is unavailable. Statistics failure must not affect conversion.

### Task 1: Counter service

**Files:** `functions/api/visits.js`, `migrations/0001_site_visits.sql`, `tests/site-visits-api.test.mjs`.

- [x] Implement production-origin, method and empty-body checks; D1 unavailable/errors return a generic non-counting 503.
- [x] Implement read-only GET and atomic POST returning the shared JSON contract; migration is idempotent and never resets an existing total.
- [x] Test total persistence, consecutive/concurrent increments, no writes on GET or invalid requests, missing binding and migration behavior.

### Task 2: Homepage integration

**Files:** `public/site-visits.js`, `tests/site-visits.test.mjs`; root integrates `public/app.js`, `public/index.html`, `public/style.css` and `tools/build-browser.mjs`.

- [x] Export `startSiteVisits({ document, location, fetchRequest, topLevel, timeoutMs } = {})`, reading meta config and updating `#site-visits` once per page.
- [x] Validate public HTTPS/same-origin config, use native fetch with no payload or credentials, bound response parsing and timeout, render only verified values.
- [x] Test disabled/local/unsafe origins send zero requests, one initialization only, success/failure/timeouts and privacy of request options.
- [x] Add a compact homepage-only visitor count with PV wording and an empty meta config; build opt-in through `VISIT_COUNTER_ENDPOINT=/api/visits`.

### Task 3: Cloudflare delivery and acceptance

**Files:** `tools/build-browser.mjs`, README, `docs/browser-version.md`, `docs/cloudflare-visits.md`.

- [x] Ship the Pages Function compiled into an advanced-mode `_worker.js` with its migration outside the public assets and a separate Cloudflare deployment directory/package; scope functions to `/api/visits` and keep plain static hosting available. The compiled worker supports dashboard drag-and-drop as well as Wrangler without updating GitHub.
- [x] Document D1 creation, migration, production-only binding and origin, direct upload without GitHub; do not claim the service is enabled until a real target is configured.
- [x] Run focused tests then the project suite. Build disabled/enabled configurations, check loopback causes no count requests and a mocked public origin shows the returned value while conversion still works.
- [x] Inspect static/source/deployment ZIPs for private inputs, credentials and correct functions/routes. Preserve Git HEAD.

## Completed locally; activation awaits the real site

All 340 tests passed with no skips. Independent Edge confirmed disabled/local pages send no requests; a mocked public HTTPS origin displays the returned total, refresh increments once and both form conversions remain independent. Service failure hides statistics without blocking conversion. Both ZIPs passed CRC and source/license/private-input checks; the compiled Worker passed local SQLite integration. Git HEAD remains `03bb465cf8e514cf507b01fb83ebfc13669dbd53`; GitHub was not updated.

The supplied URL is Cloudflare's login page. The actual tool URL or project name and cloud account deployment configuration are still required. No real D1 database was created and no site was deployed; online counting is not yet enabled.
