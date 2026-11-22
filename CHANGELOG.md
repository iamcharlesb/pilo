# Changelog

Notable user-visible changes are recorded here. Entries describe completed changes; no new version number is implied.

## Unreleased — 2026-11-21

### Added

- Wall Street Analyst and Goldman Sachs Analyst catalog entries, registered runtime profiles, separate voices, and on-demand research/valuation playbooks. These are independent AI assistants with no institutional affiliation.
- Sundar Pichai portrait sourced from Google's official author page, with source URL and checksum recorded in avatar provenance.
- Expandable bot-independence, endorsement, and financial-analysis disclaimer in the catalog.
- README navigation to the product roadmap, feature inventory, and this changelog.

### Changed

- Redesigned the bot selector with a compact heading, four-column desktop cards, role icons, and the existing white background.
- Show every built-in bot by default; Favorites and Recent remain available.
- Added search by name or role, empty-result feedback, Escape-to-close behavior, and a dark Create bot button.
- Move already-added bots below unadded bots and mark them with a blue check.
- Support held browser keys with separate key-down and key-up events.
- Improve browser-request recognition for preview inspection and explicit take-over requests.
- Add clickable plain URLs and HTML preview controls to responses; use a lightweight mascot asset.

### Fixed

- Returning Home clears the prior bot's header, run controls, status and draft view while preserving its saved draft and background run.
- Restoring a running conversation shows readable activity instead of raw tool-result JSON.
- Continuation risk checks inspect the user's request separately from generated role instructions.

### Verification

- Regression coverage exercises Home during a live run, draft preservation, resuming a bot, readable restored status, and loading both new analyst profiles.
- The browser-runtime test command includes compilation and a secret scan; catalog controls are also checked in headless Chromium.
