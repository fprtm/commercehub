# FSD: Telegram Channel — App Flows

**Feature:** 002-telegram-multichannel

## Flow 1 — New Telegram contact, text-based qualifying flow (mirrors existing WA flow, new transport)

1. Customer opens the bot in Telegram and sends `/start` (Telegram convention — every bot chat begins this way) or any free text.
2. Telegram's long-polling `getUpdates` response reaches `@rimba/telegram-connector`, which normalizes it to `{ chatId, text: '/start', messageType: 'text', telegramMessageId, timestampIso }` and calls `onMessage(...)`.
3. `server.js`'s Telegram glue calls `telegramProcessor.processInboundMessage({ contactId: String(chatId), messageBody: '/start', messageType: 'text', channel: 'telegram', messageId: telegramMessageId, timestamp: timestampIso })`.
4. `leadsRepo.findByContact(contactId)` → no existing lead (first contact) → state machine's `decideNextAction` returns `createLead: true`, `action: START_FLOW`, `replies: [Q1 prompt]` — **identical decision-making code path WA already uses**; `/start` is not special-cased, it's just the first text this contact ever sent.
5. `leadsRepo.create({ contactId, channel: 'telegram', firstMessageAt })` — new Lead row, `channel='telegram'`.
6. Reply sent via `sendWithHumanizedTiming` → Telegram connector's `sendTextMessage(chatId, q1Text)` + `sendTypingIndicator` (via `sendChatAction`) — same humanized-timing module, same delay/typing behavior as WA (channel-agnostic by design already).
7. Customer answers Q1 (numbered selection or free text) → same fuzzy-matching / numbered-selection logic as WA, unmodified (`inboundMessageProcessor.js` has zero channel-specific branching in this section).
8. Customer answers Q2 → flow completes, lead visible in dashboard with a Telegram badge (Flow 3).

No branch in this flow differs from the existing WA text flow except step 2–3 (transport-specific normalization) and step 5 (`channel` value). This is the intended outcome of Decision 001 §1: channel is plumbing, not new business logic.

## Flow 2 — Media message (photo/sticker/document) from a Telegram contact

1. Customer sends a photo (with or without a caption) at any point in the conversation — first contact, mid-flow, or after flow completion.
2. Connector normalizes to `{ chatId, text: caption ?? null, messageType: 'photo', mediaRef: <largest photo's file_id>, telegramMessageId, timestampIso }`.
3. `processInboundMessage` receives `messageBody: caption ?? null, messageType: 'photo'`.
   - **If a caption is present** (`hasUsableText` true): behaves exactly like Flow 1/normal text — the caption is matched against the product catalog, state machine proceeds normally. The photo itself is *additionally* noted (step 4) but does not change the decision.
   - **If no caption** (`messageBody` null): today's code treats this as fully NO_OP with **nothing recorded at all** (confirmed in `inboundMessageProcessor.js`'s existing `hasUsableText(messageBody)` gate on the capture path) — this is the gap FR-1304 closes.
4. **FR-1304 (new)**: regardless of caption presence, and regardless of whether `lead` exists yet, a media message appends a note: `[timestamp] <media diterima: type=photo, ref=<file_id>>` to `additional_notes` (creating the lead first, with `channel`/`contact_id` but no Q1/Q2 answers yet, if this is the very first message from this contact — otherwise this is a superset extension, applying uniformly to both WA and Telegram per the existing "never silently drop a message" principle, not a Telegram-only special case).
5. `needs_review` is flagged (owner should look — same posture as any other unmatched/uncertain inbound content).
6. **No reply is sent for the media itself** — no scripted "thanks for the photo" message (out of scope, would need product/marketing copy decisions not part of this spec); the *next* text message from this contact is handled completely normally.

## Flow 3 — Dashboard owner views/filters leads by channel (FR-1305)

1. Owner opens `/leads` (existing dashboard route).
2. Each row shows a **Channel badge** (e.g. "WhatsApp" / "Telegram", visually distinguished — exact styling is a UX-design-system detail, see `ux.md`) next to the existing phone/contact column (header renamed "Phone number" → "Contact" since it now holds a Telegram `chat_id` for Telegram rows, not always a phone number).
3. A **Channel filter** dropdown above the table: "All channels" (default, current behavior) / "WhatsApp" / "Telegram".
4. Selecting a filter re-queries `leadsRepo.listAll({ channel })` (server-side filter, not client-side — consistent with this dashboard's existing pattern of fresh DB reads, no caching) and re-renders the table with that filter persisted in the URL query string (so a refresh/bookmark keeps the filter).
5. All existing actions (mark responded/closed, view detail) work identically regardless of channel — they're keyed by `lead.id`, never by channel.

## Edge cases

| Scenario | Expected behavior |
|---|---|
| Telegram contact's `chat_id` happens to collide numerically with an existing WA `phone_number` string in the DB | No collision possible — `channel` is part of how a lead is *found* conceptually, but `contact_id` alone remains the lookup key exactly as `phone_number` was before (existing `findByContact`/old `findByPhone` never filtered by channel). Telegram `chat_id`s and WA phone numbers occupying the same numeric-string space with no channel disambiguation in the lookup is a real, if unlikely, correctness gap — **resolved as FR-1306**: `findByContact` must be scoped by `(contact_id, channel)` together, not `contact_id` alone, closing this before it can ever surface. |
| Bot receives a message while `TELEGRAM_BOT_TOKEN` is unset (Telegram channel disabled) | N/A by construction — the poll loop never starts without a token, so no message can arrive on this channel at all. |
| Long-polling connection drops (network blip, Telegram-side hiccup) | Poll loop catches the failed request, logs it, retries on the next interval (SDS's connector error handling) — no reconnect-throttle equivalent needed (no ban-risk concept for Telegram, per Decision 001). |
| Customer sends a numbered-selection reply on Telegram (e.g. "2") identical to WA's numbered flow | Works unmodified — `shown_product_ids` snapshot logic is channel-agnostic, keyed by `lead.id`. |
| Owner filters dashboard by "Telegram" when zero Telegram leads exist yet | Empty table + existing empty-state messaging (no new empty-state copy needed — dashboard already has a general "no leads" state; reuse it). |
| App restarts while Telegram long-polling has unconfirmed updates | Re-polls from Telegram's retention window (~24h) using the last-known offset behavior of `getUpdates` (no offset persisted across restarts, per SDS's explicit NOT-NOW). A message sent in a very narrow restart window could theoretically be missed if Telegram's retention already expired it — accepted, same class of risk as any at-least-once polling system, explicitly out of scope to harden further (FR-1303 in the change doc's Out of Scope). |

## Error flows

| Trigger | What happens | Recovery |
|---|---|---|
| Telegram API returns non-200 on `getUpdates` (e.g. invalid token, 401) | Logged with the specific status code (never the token itself — SEC-1301), poll loop backs off to the next interval and retries indefinitely | Owner must fix `TELEGRAM_BOT_TOKEN` in `.env` and restart the app — no automatic self-heal for a bad token, consistent with how a bad `META_ACCESS_TOKEN` is handled today (fails loudly, not silently) |
| `sendTextMessage` (outbound reply) fails (network error, Telegram API error) | Logged, same failure-handling posture as existing WA `sendTextMessage` failures — no new retry logic invented for this feature | Message is lost for that turn; the customer's *next* inbound message is still processed normally (no cascading failure) |
| Malformed `Update` JSON shape (SEC-1303) | That single update is skipped + logged, poll loop continues | None needed — self-recovers on the next poll cycle |

## Business rules
- If `TELEGRAM_BOT_TOKEN` is unset → Telegram channel does not start, app behaves exactly as it does today (WA-only). *(if/then, confirms backward compatibility)*
- If an inbound message has `messageType !== 'text'` → no scripted reply is sent for that message, regardless of channel. *(if/then, FR-1304 scope boundary)*
- If a lead's `contact_id` matches across two different `channel` values → they are treated as two independent leads (FR-1306), never merged. *(if/then — no cross-channel identity resolution in v1, matches Decision 001's "channel is an attribute" framing: same-person-different-channel unification is a real future feature, not assumed here)*

## Performance
No new performance target beyond what already exists — Telegram's `getUpdates` long-poll (`timeout=30`) is a background loop, not in the request path of anything user-facing; dashboard channel filter is a single indexed-or-full-table-scan query against a SQLite table sized for a single UMKM's lead volume (hundreds–low thousands of rows), well within the existing dashboard's already-adequate response time — no new index required at this scale (flagged for revisit only if a single deployment's lead table grows past ~50k rows, well beyond this project's current positioning).
