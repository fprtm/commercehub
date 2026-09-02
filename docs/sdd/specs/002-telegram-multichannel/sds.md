# SDS: Telegram as a Second Concurrent Channel

**Feature:** 002-telegram-multichannel
**Relates to:** `docs/sdd/decisions/001-telegram-multichannel.md` (WHICH), this document (HOW)
**App:** `apps/lead-capture` (renamed from `apps/whatsapp-lead-capture` — FR-1301, see below)

## Architecture Decision — Composition-Root Channel Registry (not a lookup inside the processor)

**Settled in discovery**: channels run concurrently (not a single exclusive `WHATSAPP_MODE`-style switch).

**Refined here (HOW)**: the mechanism is **multiple `inboundMessageProcessor` instances**, one per active channel, wired at the composition root (`server.js`) — not a single processor instance that looks up a channel registry internally.

Why: `createInboundMessageProcessor({ sendTextMessage, markAsRead, sendTypingIndicator, ... })` already takes these three as construction-time dependencies, one function each, no channel parameter in their signature. Every existing FR (FR-601/603/604, humanized timing, read receipts) is written against "the one connector this processor instance talks to." Retrofitting an internal per-call channel lookup would touch every one of those call sites for zero behavioral gain. Instantiating the *existing, unmodified* factory once per channel gets the same outcome — each channel's inbound handler (Baileys event, Cloud API webhook route, Telegram poll loop) calls its own processor instance — with a smaller diff and zero risk to the humanized-timing/read-receipt logic that already passed 4 review rounds.

```
server.js (composition root)
├── WhatsApp channel (WHATSAPP_MODE=cloud_api|baileys, unchanged sub-switch)
│     └── waProcessor = createInboundMessageProcessor({ sendTextMessage: wa.sendTextMessage, markAsRead: wa.markAsRead, sendTypingIndicator: wa.sendTypingIndicator, ...sharedDeps })
│     └── connector event/webhook → waProcessor.processInboundMessage({ contactId, channel: 'whatsapp_baileys'|'whatsapp_cloud_api', ... })
│
└── Telegram channel (enabled iff process.env.TELEGRAM_BOT_TOKEN is set — presence-driven, not a mode string; unset = today's WA-only behavior, fully backward compatible)
      └── telegramProcessor = createInboundMessageProcessor({ sendTextMessage: telegram.sendTextMessage, markAsRead: undefined (no-op — see below), sendTypingIndicator: telegram.sendTypingIndicator, ...sharedDeps })
      └── telegram.start(onUpdate) → telegramProcessor.processInboundMessage({ contactId, channel: 'telegram', ... })
```

`sharedDeps` = `{ leadsRepo, questionsConfig, settingsRepo, products/productsRepo, matchThreshold, intentDenylist }` — identical object passed to both processor instances; this is what makes leads/products/settings genuinely shared across channels (FR-1302).

**`markAsRead` for Telegram**: the Bot API has no read-receipt endpoint for private chats (unlike WA). `createInboundMessageProcessor` already treats `markAsRead` as optional-defaults-to-no-op (existing behavior, unmodified) — Telegram's processor instance simply omits it. No new code path needed.

## `@rimba/telegram-connector` (new package)

Mirrors `metaClient.js`'s existing pattern in `@rimba/whatsapp-connector`: raw HTTPS, zero SDK dependency (Decision 001, integration-approach fork).

```js
createTelegramConnector({ botToken, onMessage, pollIntervalMs, fetchImpl, sleep })
  → { start(), stop(), sendTextMessage(chatId, text), sendTypingIndicator(chatId) }
```

- **Transport**: long polling against `https://api.telegram.org/bot<token>/getUpdates?offset=<n>&timeout=30`. `fetchImpl` injectable (defaults to global `fetch`) purely for testability — same injection pattern `metaClient.js` already uses.
- **Offset tracking**: in-memory `lastUpdateId`, advanced after each successfully-processed batch. Not persisted to disk — an app restart re-polls from Telegram's own retention window (Telegram keeps unconfirmed updates ~24h); acceptable for this project's scale (FR-1303, explicitly scoped — persisted offset is NOT NOW).
- **`onMessage` callback shape**: `({ chatId, text, messageType, mediaRef, telegramMessageId, timestampIso }) => Promise<void>` — connector normalizes Telegram's raw `Update` object shape (handles `message.text`, `message.photo` (array, connector takes the largest `file_id`), `message.sticker.file_id`, `message.document.file_id`) into this one flat shape before calling out, so `server.js`'s glue code never touches Telegram's raw payload shape (same separation `metaClient.js`/`baileysConnector.js` already keep from `server.js`).
- **`/start` handling**: not special-cased inside the connector — arrives as an ordinary text message (`messageType: 'text'`, `text: '/start'`) and flows through the same state machine as any other first message. `decideNextAction` already handles "first message from a new contact" generically (creates the lead, sends Q1) — `/start` needs no new logic, just confirmation this path is exercised (FSD edge case, not a new FR).
- **`sendTypingIndicator`**: `sendChatAction(chatId, 'typing')` — direct Bot API equivalent, wired the same way WA's typing indicator already is.
- **Error handling**: a single failed poll cycle logs and retries on the next interval (no reconnect-throttle equivalent needed — Decision 001 already ruled this out: Telegram has no ban-risk-from-reconnect concept to defend against).

Package tests mirror `metaClient.js`'s test style: injectable `fetchImpl` returning canned responses, no real network calls, assert on the HTTP calls made and the normalized `onMessage` payload shape.

## `leadsRepo.js` / `inboundMessageProcessor.js` rename

`phoneNumber` → `contactId` throughout (param names, JSDoc, local variables). This is a rename, not a behavior change: every existing call already treats the value as an opaque identifier string (never parsed/formatted as a phone number anywhere in this file). `findByPhone` → `findByContact`. Full detail in `erd.md` (schema) and the ticket breakdown below.

## App rename (FR-1301)

`apps/whatsapp-lead-capture` → `apps/lead-capture`:
- Directory rename (`git mv`, preserves history).
- `package.json` root: `workspaces` entry `"apps/whatsapp-lead-capture"` → `"apps/lead-capture"`.
- App's own `package.json` `"name"` field: `"whatsapp-lead-capture"` → `"lead-capture"`.
- `scripts/extract-app.js`: usage-comment example updated (the script itself takes the app name as a CLI arg, no hardcoded path beyond that comment — confirmed by inspection).
- Any doc/README referencing the old path (`docs/sdd/specs/001-monorepo-migration/*`, `docs/sdd/changes/*`) are **left as-is** — they're historical records of what was true when written, not living references; rewriting them would falsify the history the case-study value of this repo depends on (same reasoning Decision 001 already applied to preserving git history).

## Fork resolution note (fidelity)
The composition-root/multi-instance mechanism above is a refinement of the discovery-session's "channel registry" framing, not a contradiction — the user-approved property ("all channels run concurrently, no exclusive mode switch, uniform `sendTextMessage(contactId, text)` shape") holds exactly. The *place* the registry concept lives (composition root wiring vs. an internal lookup) is the HOW-level detail this SPEC step is responsible for choosing.
