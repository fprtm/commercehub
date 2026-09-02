# TICKET-1303 — `@rimba/telegram-connector` package

**Feature**: 002-telegram-multichannel
**Refs**: SDS §"@rimba/telegram-connector (new package)", threats.md SEC-1301/SEC-1303
**Tier**: T1
**Status**: ✅ done — `packages/telegram-connector/` built (package.json, src/telegramConnector.js, src/logger.js, src/index.js, test/telegramConnector.test.js, README.md). `npm test` (and `npx turbo run test --filter=@rimba/telegram-connector` from root): 10/10 passing, 0 failing. Covers all 4 acceptance criteria (text normalization, malformed+valid mixed batch, sendTextMessage/sendTypingIndicator request shape, photo-largest-file_id-no-caption) plus sticker/document normalization, offset advancement, and empty-batch no-op. Verified no log call anywhere contains the bot token substring or the constructed request URL (SEC-1301), and malformed updates are caught, logged (`telegram_malformed_update`), and skipped without throwing out of the poll loop (SEC-1303).
**Dependencies**: none
**Files likely touched:** `packages/telegram-connector/package.json` (new), `packages/telegram-connector/src/telegramConnector.js` (new), `packages/telegram-connector/test/telegramConnector.test.js` (new), `packages/telegram-connector/README.md` (new)
**Claimed by:** _(empty)_

## What to Build
A new Turborepo package implementing raw-HTTPS, long-polling Telegram Bot API access — zero SDK dependency, mirroring `@rimba/whatsapp-connector`'s `metaClient.js` pattern.

## Deliverables
- `packages/telegram-connector/src/telegramConnector.js` → `createTelegramConnector({botToken, onMessage, pollIntervalMs, fetchImpl, sleep})` returning `{start(), stop(), sendTextMessage(chatId, text), sendTypingIndicator(chatId)}` (new)
- Update-normalization: raw Telegram `Update` → `{chatId, text, messageType, mediaRef, telegramMessageId, timestampIso}` for `message.text`/`message.photo` (largest `file_id`)/`message.sticker`/`message.document` (new)
- Malformed-update handling: skip + log, never throw out of the poll loop (SEC-1303) (new)
- Token never appears in any `log()` call — endpoint name logged, not the constructed URL (SEC-1301) (new)
- `packages/telegram-connector/test/telegramConnector.test.js` → injectable `fetchImpl`, no real network calls (new)

## Acceptance Criteria (Given/When/Then)
- [ ] Given a canned successful `getUpdates` response with one text message, when the poll loop processes it, then `onMessage` is called once with the correctly normalized `{chatId, text, messageType: 'text', ...}` shape.
- [ ] Given a canned response with one malformed update mixed with one valid update, when the poll loop processes the batch, then the valid update still reaches `onMessage` and the malformed one is skipped + logged, with no uncaught exception.
- [ ] Given `sendTextMessage(chatId, text)` is called, when inspecting what `fetchImpl` was invoked with, then the request targets `sendMessage` with the given `chatId`/`text`, and no log call anywhere includes the bot token substring.
- [ ] Given a photo update with no caption, when normalized, then `text` is `null`, `messageType` is `'photo'`, and `mediaRef` is the largest photo size's `file_id`.

## Out of Scope
- Downloading/storing the actual file bytes behind `mediaRef` — deliberately never implemented (SEC-1305, reference-only by design).
- Persisting `lastUpdateId` across process restarts (SDS's explicit NOT NOW).
