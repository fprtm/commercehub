# TICKET-1306 — Dashboard channel badge + filter

**Feature**: 002-telegram-multichannel
**Refs**: FSD Flow 3 (FR-1305), ux.md
**Tier**: T2
**Status**: ⬜ todo
**Dependencies**: TICKET-1302
**Files likely touched:** `apps/lead-capture/src/views/leads.ejs`, `apps/lead-capture/src/routes/leads.js` (or equivalent route file), `apps/lead-capture/src/services/leadsRepo.js`
**Claimed by:** _(empty)_

## What to Build
Surface the `channel` attribute in the dashboard: a per-row badge and a filter dropdown, following this project's existing badge/CSS conventions.

## Deliverables
- `leadsRepo.js` → `listAll({channel})` optional filter param, `listAll()` (no arg) unchanged default behavior (modified)
- `leads.ejs` → header "Phone number" → "Contact" (modified)
- `leads.ejs` → channel badge per row using `.badge-channel-whatsapp`/`.badge-channel-telegram` (new CSS classes, following existing `.badge` convention)
- `leads.ejs` → channel filter `<select>` submitting `?channel=` as a GET query param (new)
- Route handler → reads `req.query.channel`, passes to `leadsRepo.listAll({channel})`, persists selection in the rendered `<select>` (modified)

## Acceptance Criteria (Given/When/Then)
- [ ] Given leads exist on both channels, when the dashboard loads with no filter, then all leads show with correct channel badges (unchanged default: "All channels").
- [ ] Given the owner selects "Telegram" in the filter, when the page reloads, then only `channel='telegram'` leads are shown, and the URL reflects `?channel=telegram`.
- [ ] Given a filtered URL is bookmarked/refreshed, when reloaded, then the same filter is still applied and the `<select>` shows the correct selected option.
- [ ] Given the "Telegram" filter is selected with zero Telegram leads, when the page loads, then the existing empty-state block is shown (no new copy needed).

## Out of Scope
- Any icon asset beyond the color-coded badge text (optional polish, not required for v1 per ux.md).
