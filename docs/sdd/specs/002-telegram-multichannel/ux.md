# UX: Channel Badge + Filter on the Leads Dashboard

**Feature:** 002-telegram-multichannel
**Scope note**: no `docs/sdd/design-system/design.md` exists yet in this repo (dashboard predates this pipeline's UI-deliberation step). This change is a small delta to one existing table on one existing screen (`leads.ejs`) — not a new screen, not a new visual direction — so this doc extends the dashboard's already-established conventions rather than opening a full design-system deliberation, proportional to the change size.

## Existing convention reused
`leads.ejs` already has a `.badge` base class with color-coded variants (`.badge-new`, `.badge-responded`, `.badge-closed`, `.badge-needs-review`). The channel indicator follows the same pattern rather than inventing a new visual language:

```css
.badge-channel-whatsapp { background: #e7f7ec; color: #1e7d1e; }  /* reuses the existing "positive/active" green family already used by badge-responded */
.badge-channel-telegram { background: #e6f4fc; color: #1a7fb0; }  /* Telegram's own brand blue, distinct from the existing "new lead" blue (#0b5fb0) so the two badges are never confusable at a glance */
```

## Screen delta — Leads table (`leads.ejs`)

**Header row**: `<th>Phone number</th>` → `<th>Contact</th>` (FR-1305 — the column now holds a Telegram `chat_id` for Telegram rows, "Phone number" would be actively wrong for those).

**Body row**: a channel badge is inserted immediately after the Contact cell's value, before the existing status badge:
```
| Contact          | Channel      | First message | Q1 | Q2 | Status | Actions |
| 6281234567890    | 🟢 WhatsApp  | ...            | .. | .. | ..     | ..      |
| 987654321         | 🔵 Telegram  | ...            | .. | .. | ..     | ..      |
```
(Exact emoji/icon use is optional polish, not load-bearing — the badge color + text label alone already disambiguate; no new icon asset is required for v1.)

**Filter control**: a `<select>` above the table, next to the existing flash-message area, options `All channels` (default) / `WhatsApp` / `Telegram` — submits as a GET query param (`?channel=telegram`) so the existing server-rendered-table pattern (no client-side JS framework in this dashboard) needs no new client-side state management, consistent with how this dashboard already works end-to-end.

## States
| State | Behavior |
|---|---|
| Default load, no filter | All channels shown — identical to today's behavior, zero visual change for a WA-only deployment until a Telegram lead actually exists |
| Filter = Telegram, zero Telegram leads yet | Reuses the dashboard's existing empty-state block (no new copy needed) |
| Filter selected, then page refreshed | Filter persists via the URL query string, not lost |

## Responsive
No change to this dashboard's existing responsive behavior — the new column follows the same table layout the existing columns already use (this dashboard has no separate mobile layout to account for, confirmed by inspecting `leads.ejs`'s existing `<style>` block).
