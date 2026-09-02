# @rimba/telegram-connector

Raw-HTTPS, long-polling Telegram Bot API connectivity -- zero SDK dependency,
mirroring `@rimba/whatsapp-connector`'s `metaClient.js` pattern (same
injectable-`fetchImpl` testability approach, same "connector normalizes the
raw payload before calling out" separation from the app's own glue code).

```js
createTelegramConnector({ botToken, onMessage, pollIntervalMs, fetchImpl, sleep })
  → { start(), stop(), sendTextMessage(chatId, text), sendTypingIndicator(chatId) }
```

## What it does

- **Transport**: long polling against
  `https://api.telegram.org/bot<token>/getUpdates?offset=<n>&timeout=30`.
  `fetchImpl` is injectable (defaults to global `fetch`) purely for
  testability.
- **Normalization**: raw Telegram `Update` objects are converted to one flat
  shape before `onMessage` is called: `{ chatId, text, messageType, mediaRef,
  telegramMessageId, timestampIso }`. Handles `message.text` (`'text'`),
  `message.photo` (`'photo'` -- takes the *largest* size's `file_id` by pixel
  area as `mediaRef`, `text` is the caption or `null`), `message.sticker`
  (`'sticker'`), and `message.document` (`'document'`). A message subtype
  outside this list (voice, location, poll, etc.) is silently skipped, not
  treated as an error.
- **`sendTextMessage(chatId, text)`** → `POST .../sendMessage`.
- **`sendTypingIndicator(chatId)`** → `POST .../sendChatAction` with
  `action: 'typing'`.
- **`/start` handling**: not special-cased here -- it arrives as an ordinary
  text message (`messageType: 'text'`, `text: '/start'`) and is left to the
  consuming app's own state machine, same as any other first message.

## Scope boundaries (read before assuming more than this does)

- **No file download.** `mediaRef` is Telegram's own `file_id` string -- an
  opaque reference redeemable later via Telegram's `getFile`/file-download
  API, never a URL, path, or the actual bytes. This connector never
  downloads or stores file content. This is a deliberate security choice
  (SEC-1305 in the feature's threat model), not a missing feature: the
  vulnerable code path (writing arbitrary user-uploaded bytes to this
  server's disk) simply doesn't exist here.
- **No persisted offset.** `lastUpdateId`/offset tracking is in-memory only.
  A process restart re-polls from Telegram's own retention window (Telegram
  keeps unconfirmed updates for roughly 24h), so a short restart loses
  nothing; a longer outage could. This is an explicit NOT NOW, acceptable at
  this project's scale -- not an oversight.
- **No reconnect-throttle equivalent.** Long polling has no persistent
  socket/connection-lifecycle concept the way Baileys does, so there is
  nothing here analogous to `whatsapp-connector`'s reconnect throttle. A
  single failed poll cycle logs and retries on the next interval.

## Token handling (SEC-1301)

The bot token is embedded in every request URL's path
(`https://api.telegram.org/bot<token>/...`). This module never logs a
constructed URL -- every `log()` call uses a fixed endpoint-name string
(e.g. `'telegram_get_updates_failed'`, `'telegram_send_message_failed'`)
instead. Never pass a URL or the raw token into `log()` if you extend this
file.

## Malformed-update handling (SEC-1303)

A single malformed or unexpected `Update` shape in a `getUpdates` batch
(missing `chat.id`, an update that isn't an object, etc.) is caught, logged
as `'telegram_malformed_update'`, and skipped -- it never throws out of the
poll loop and never blocks the other updates in the same batch.

## Testing

```bash
npm test
```

Runs `node --test` against `test/`. No real network call is made anywhere
-- `test/telegramConnector.test.js` injects a fake `fetchImpl` returning
canned `getUpdates`/`sendMessage`/`sendChatAction` responses, and a `sleep`
that never resolves so each test's single `start()` cycle stays
deterministic. Tests also capture every `console.log` call made during a
run and assert the bot token substring never appears in any of them.
