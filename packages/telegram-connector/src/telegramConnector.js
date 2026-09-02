'use strict';

const { log } = require('./logger');

const TELEGRAM_API_ROOT = 'https://api.telegram.org';

/**
 * Raw-HTTPS, long-polling Telegram Bot API connector -- zero SDK
 * dependency, mirroring `@rimba/whatsapp-connector`'s `metaClient.js`
 * pattern (same injectable-`fetchImpl` testability approach, same
 * "connector normalizes the raw payload before calling out" separation
 * from the app's own glue code).
 *
 * @param {object} params
 * @param {string} params.botToken - Telegram bot token (never logged --
 *   SEC-1301: the constructed request URL embeds it in the path, so this
 *   module only ever logs an endpoint-name string, never a URL).
 * @param {(msg: {chatId, text, messageType, mediaRef, telegramMessageId, timestampIso}) => Promise<void>} params.onMessage
 *   - called once per normalized inbound message.
 * @param {number} [params.pollIntervalMs] - delay between successive
 *   getUpdates cycles once a batch has been processed. Default 1000.
 * @param {typeof fetch} [params.fetchImpl] - injectable fetch
 *   implementation, defaults to global `fetch`, for testability (same
 *   injection pattern `metaClient.js` already uses).
 * @param {(ms: number) => Promise<void>} [params.sleep] - injectable
 *   delay function between poll cycles, for deterministic tests.
 */
function createTelegramConnector({
  botToken,
  onMessage,
  pollIntervalMs = 1000,
  fetchImpl = fetch,
  sleep = defaultSleep,
}) {
  const baseUrl = `${TELEGRAM_API_ROOT}/bot${botToken}`;

  // In-memory only -- FR-1303/SDS explicit NOT NOW: an app restart re-polls
  // from Telegram's own retention window (~24h of unconfirmed updates),
  // which is acceptable for this project's scale. Persisting this across
  // restarts is out of scope by design, not an oversight.
  let nextOffset = 0;

  let polling = false;
  let pollChain = null;

  return {
    start,
    stop,
    sendTextMessage,
    sendTypingIndicator,
  };

  /**
   * Runs one getUpdates cycle immediately (awaited, so callers/tests can
   * rely on onMessage having been called for the first batch by the time
   * `start()` resolves), then schedules the ongoing poll loop in the
   * background via the injectable `sleep`. `stop()` cooperatively ends
   * that background loop.
   */
  async function start() {
    if (polling) return;
    polling = true;
    await pollOnce();
    scheduleNext();
  }

  async function stop() {
    // Cooperative cancellation only: the background loop is currently
    // parked inside `sleep(pollIntervalMs)` (which may be a real timer, or
    // in tests something that never resolves), so `stop()` deliberately
    // does not await it -- it just flips the flag the loop checks the next
    // time it wakes. This keeps `stop()` itself fast and unconditionally
    // resolving instead of hanging on a pending sleep.
    polling = false;
    pollChain = null;
  }

  function scheduleNext() {
    if (!polling) return;
    pollChain = sleep(pollIntervalMs).then(async () => {
      if (!polling) return;
      await pollOnce();
      scheduleNext();
    });
  }

  async function pollOnce() {
    let payload;
    try {
      const response = await fetchImpl(`${baseUrl}/getUpdates?offset=${nextOffset}&timeout=30`, {
        method: 'GET',
      });
      payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        log('telegram_get_updates_failed', { status: response.status });
        return;
      }
    } catch (err) {
      // A single failed poll cycle logs and retries on the next interval
      // (SDS "Error handling" -- no reconnect-throttle equivalent needed
      // for long polling).
      log('telegram_get_updates_error', { error: err.message });
      return;
    }

    const updates = Array.isArray(payload.result) ? payload.result : [];

    // SEC-1303: process sequentially, each wrapped so one malformed update
    // in the batch can never throw out of this loop or block the rest.
    for (const update of updates) {
      await processUpdate(update);
    }

    let maxUpdateId = null;
    for (const update of updates) {
      if (update && typeof update.update_id === 'number') {
        if (maxUpdateId === null || update.update_id > maxUpdateId) {
          maxUpdateId = update.update_id;
        }
      }
    }
    if (maxUpdateId !== null) {
      nextOffset = maxUpdateId + 1;
    }
  }

  async function processUpdate(update) {
    let normalized;
    try {
      normalized = normalizeUpdate(update);
    } catch (err) {
      // SEC-1303: malformed/unexpected Update shape -- skip + log, never
      // let it escape the poll loop.
      log('telegram_malformed_update', { error: err.message });
      return;
    }

    if (!normalized) {
      // A well-formed Update this connector simply doesn't normalize a
      // message for (no `message` field, or a message subtype outside
      // text/photo/sticker/document -- e.g. voice, location, poll).
      log('telegram_unsupported_update', {});
      return;
    }

    try {
      await onMessage(normalized);
    } catch (err) {
      log('telegram_on_message_handler_error', { error: err.message });
    }
  }

  async function sendTextMessage(chatId, text) {
    return callApi('sendMessage', 'telegram_send_message', { chat_id: chatId, text });
  }

  async function sendTypingIndicator(chatId) {
    return callApi('sendChatAction', 'telegram_send_chat_action', { chat_id: chatId, action: 'typing' });
  }

  async function callApi(endpointPath, logEventBase, body) {
    try {
      const response = await fetchImpl(`${baseUrl}/${endpointPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || payload.ok === false) {
        // SEC-1301: log the endpoint name, never the constructed URL.
        log(`${logEventBase}_failed`, { status: response.status });
        return null;
      }

      return payload;
    } catch (err) {
      log(`${logEventBase}_error`, { error: err.message });
      return null;
    }
  }
}

/**
 * Normalizes a raw Telegram `Update` object into this connector's flat
 * outbound shape. Returns `null` for a well-formed Update this connector
 * has nothing to normalize (no `message`, or an unsupported message
 * subtype) -- distinct from throwing, which signals a genuinely malformed
 * shape (SEC-1303) for the caller to log-and-skip.
 */
function normalizeUpdate(update) {
  if (!update || typeof update !== 'object') {
    throw new Error('update is not an object');
  }

  const message = update.message;
  if (!message || typeof message !== 'object') {
    return null;
  }

  const chatId = message.chat && (message.chat.id ?? null);
  if (chatId === null || chatId === undefined) {
    throw new Error('update.message.chat.id is missing');
  }

  const telegramMessageId = message.message_id;
  const timestampIso =
    typeof message.date === 'number' ? new Date(message.date * 1000).toISOString() : new Date().toISOString();

  const base = { chatId, telegramMessageId, timestampIso };

  if (typeof message.text === 'string') {
    return { ...base, text: message.text, messageType: 'text', mediaRef: null };
  }

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = pickLargestPhoto(message.photo);
    if (!largest) {
      throw new Error('message.photo had no entries with a valid file_id');
    }
    return {
      ...base,
      text: typeof message.caption === 'string' ? message.caption : null,
      messageType: 'photo',
      mediaRef: largest.file_id,
    };
  }

  if (message.sticker && typeof message.sticker.file_id === 'string') {
    return { ...base, text: null, messageType: 'sticker', mediaRef: message.sticker.file_id };
  }

  if (message.document && typeof message.document.file_id === 'string') {
    return { ...base, text: null, messageType: 'document', mediaRef: message.document.file_id };
  }

  // A message subtype this connector doesn't normalize (voice, location,
  // poll, etc.) -- not malformed, just out of scope.
  return null;
}

/** Largest by pixel area (width * height), per Telegram's PhotoSize array. */
function pickLargestPhoto(sizes) {
  let largest = null;
  let largestArea = -1;
  for (const size of sizes) {
    if (!size || typeof size.file_id !== 'string') continue;
    const area = (size.width || 0) * (size.height || 0);
    if (area >= largestArea) {
      largest = size;
      largestArea = area;
    }
  }
  return largest;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createTelegramConnector };
