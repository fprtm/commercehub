# TICKET-1304 — `server.js` composition-root wiring (concurrent channels)

**Feature**: 002-telegram-multichannel
**Refs**: SDS-002 §"Architecture Decision — Composition-Root Channel Registry", FR-1302, ADR-001 (DB stays per-app; Telegram runs as a second concurrent channel, not a replacement)
**Tier**: T1
**Status**: ✅ done — `src/server.js` now constructs `createTelegramChannel(...)` at the composition root (extracted as a named, exported function so it's directly testable without booting a real HTTP server), gated purely on `process.env.TELEGRAM_BOT_TOKEN` presence after `.trim()`; returns `null` (constructs nothing — no leadsRepo/settingsRepo/processor/connector) when unset/blank. When set, wires a second `createInboundMessageProcessor({ sendTextMessage, sendTypingIndicator, leadsRepo, questionsConfig, settingsRepo, productsRepo, matchThreshold, intentDenylist })` (no `markAsRead`, confirmed already optional/no-op-default in the processor's constructor) to a `@rimba/telegram-connector` instance (added as a workspace dependency), started alongside (not replacing) the existing Baileys/Cloud API startup. Added `TELEGRAM_BOT_TOKEN` to `.env.example` as optional/commented-out; left out of `BASE_REQUIRED_ENV_VARS`/`CLOUD_API_REQUIRED_ENV_VARS` so boot never requires it. New tests: `apps/lead-capture/tests/telegramChannel.test.js` (4 tests — null-return + zero connector construction when unset/blank, full inbound-update → Lead(channel='telegram') → sendTextMessage(ack+Q1) flow via an injected fake connector, and a two-contact no-cross-talk check). `npx turbo run test`: 310 passing, 0 failing (baseline was 299; this ticket added 4, the rest came from concurrent TICKET-1305/1306 work in the same checkout). `inboundMessageProcessor.js`, `leadsRepo.js`, `leads.js`/`leads.ejs` left untouched, per this ticket's scope boundary with those concurrent tickets.
**Dependencies**: TICKET-1302, TICKET-1303
**Files likely touched:** `apps/lead-capture/src/server.js`
**Claimed by:** _(empty)_

## What to Build
Wire a second, independent `inboundMessageProcessor` instance bound to the Telegram connector, started alongside the existing WhatsApp connector whenever `TELEGRAM_BOT_TOKEN` is present — with zero behavior change when it's absent.

## Deliverables
- `server.js` → Telegram channel gated on `process.env.TELEGRAM_BOT_TOKEN` presence (new code path, existing WA gating on `WHATSAPP_MODE` untouched)
- `server.js` → `telegramProcessor = createInboundMessageProcessor({ sendTextMessage: telegram.sendTextMessage, sendTypingIndicator: telegram.sendTypingIndicator, ...sharedDeps })` — no `markAsRead` (Telegram has none) (new)
- `server.js` → `telegramConnector.start(onUpdate)` at boot, where `onUpdate` calls `telegramProcessor.processInboundMessage({ contactId: String(chatId), channel: 'telegram', messageBody: text, messageType, messageId: telegramMessageId, timestamp: timestampIso })` (new)
- `sharedDeps` (leadsRepo, questionsConfig, settingsRepo, productsRepo, matchThreshold, intentDenylist) passed identically to both processor instances (new — this is what makes leads/products/settings genuinely shared across channels)

## Acceptance Criteria (Given/When/Then)
- [ ] Given `TELEGRAM_BOT_TOKEN` is unset, when the app boots and runs its full existing test suite, then behavior is byte-for-byte identical to before this ticket (regression guard).
- [ ] Given `TELEGRAM_BOT_TOKEN` is set, when a synthetic Telegram update is fed through the wired `onUpdate` callback, then a Lead row is created/updated with `channel='telegram'` and a reply is sent via the Telegram connector's `sendTextMessage`, going through the same humanized-timing delay as WA replies.
- [ ] Given both channels are active, when a WA message and a Telegram message arrive for different contacts, then each is processed by its own processor instance with no cross-talk (e.g. a WA reply never gets routed through `telegramConnector.sendTextMessage`).

## Out of Scope
- Any change to the existing `WHATSAPP_MODE` (`cloud_api`/`baileys`) sub-switch — untouched, still governs which WA implementation is active.
