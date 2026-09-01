'use strict';

const fs = require('fs');
const { log: defaultLog } = require('../utils/logger');

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60000;

/**
 * Everything below that reaches into `@whiskeysockets/baileys` / `pino` /
 * the filesystem is required lazily, inside the default factory functions
 * -- never at module load time. That means simply requiring this file (as
 * the test suite does) never touches the real library, a real socket, or
 * disk; only calling `createBaileysConnector()` with its defaults left in
 * place (which only happens for real in src/server.js when
 * WHATSAPP_MODE=baileys) does. Tests inject fakes for `makeSocket` and
 * `authStateProvider` instead -- see tests/baileysConnector.test.js.
 */
function defaultLoggerInstance() {
  const pino = require('pino'); // eslint-disable-line global-require
  return pino({ level: 'silent' });
}

async function defaultAuthStateProvider(authDir) {
  const { useMultiFileAuthState } = require('@whiskeysockets/baileys'); // eslint-disable-line global-require
  return useMultiFileAuthState(authDir);
}

async function defaultMakeSocket({ auth }) {
  const baileys = require('@whiskeysockets/baileys'); // eslint-disable-line global-require
  const makeWASocket = baileys.default || baileys.makeWASocket;
  return makeWASocket({
    auth,
    printQRInTerminal: false,
    logger: defaultLoggerInstance(),
  });
}

/**
 * FR-305 fix (post-review blocker): an explicit ALLOWLIST of genuinely
 * recoverable disconnect reasons, rather than a denylist that only knew
 * about `loggedOut`. Everything not on this list -- including reasons this
 * codebase doesn't have a name for yet -- is treated as non-recoverable
 * ("closed" by default, not "open by default"), except for an
 * undefined/unknown status code, which is deliberately treated as
 * recoverable: a `connection.update` close event with no statusCode at all
 * is a generic/ambiguous disconnect (seen in practice for plain network
 * drops), not evidence of a dead session.
 */
function defaultIsRecoverableCode(statusCode) {
  if (statusCode === undefined || statusCode === null) return true;
  const { DisconnectReason } = require('@whiskeysockets/baileys'); // eslint-disable-line global-require
  const RECOVERABLE_CODES = new Set([
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost, // note: same numeric code (408) as timedOut
    DisconnectReason.timedOut,
    DisconnectReason.restartRequired,
    DisconnectReason.unavailableService,
  ]);
  return RECOVERABLE_CODES.has(statusCode);
}

/**
 * Human-facing detail for a non-recoverable disconnect, surfaced on the
 * pairing screen (FR-305) so the owner sees *why* re-pairing is needed
 * instead of one generic "logged out" message papering over genuinely
 * different situations (session logged out from the phone vs. the number
 * now being linked elsewhere vs. a corrupted session vs. WhatsApp itself
 * blocking the number).
 */
function defaultDescribeNonRecoverableReason(statusCode) {
  const { DisconnectReason } = require('@whiskeysockets/baileys'); // eslint-disable-line global-require
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return {
        code: 'logged_out',
        message: 'The WhatsApp session was logged out from the phone (e.g. removed from Linked Devices there).',
      };
    case DisconnectReason.connectionReplaced:
      return {
        code: 'connection_replaced',
        message: 'This WhatsApp number is now linked to a different device/session, which replaced this one.',
      };
    case DisconnectReason.badSession:
      return {
        code: 'bad_session',
        message: 'The saved WhatsApp session is corrupted and can no longer be used.',
      };
    case DisconnectReason.forbidden:
      return {
        code: 'forbidden',
        message: 'WhatsApp has blocked or restricted this number -- contact WhatsApp support before re-pairing.',
      };
    case DisconnectReason.multideviceMismatch:
      return {
        code: 'multidevice_mismatch',
        message: 'This WhatsApp account is not compatible with the multi-device linking this app uses.',
      };
    default:
      return {
        code: 'unknown',
        message: 'The WhatsApp connection failed for a reason that cannot be automatically recovered.',
      };
  }
}

function defaultQrToDataUrl(qrString) {
  const QRCode = require('qrcode'); // eslint-disable-line global-require
  return QRCode.toDataURL(qrString);
}

/** Strips a Baileys JID ("62812xxxx@s.whatsapp.net" / "...:12@s.whatsapp.net") down to the bare phone number, matching the format Meta's Cloud API already uses (see parseWebhookPayload.js) so the shared leadsRepo/state machine never has to know which channel a phone number came from. */
function toPhoneNumber(jid) {
  if (typeof jid !== 'string' || jid.length === 0) return null;
  return jid.split('@')[0].split(':')[0];
}

function toJid(phoneNumber) {
  return `${phoneNumber}@s.whatsapp.net`;
}

/** Mirrors parseWebhookPayload.js's "text or null + a type label" shape for Baileys' considerably messier message-content object. */
function extractBaileysContent(message) {
  if (!message || typeof message !== 'object') return { messageBody: null, messageType: 'unknown' };
  if (typeof message.conversation === 'string') {
    return { messageBody: message.conversation, messageType: 'text' };
  }
  if (message.extendedTextMessage && typeof message.extendedTextMessage.text === 'string') {
    return { messageBody: message.extendedTextMessage.text, messageType: 'text' };
  }
  const [type] = Object.keys(message);
  return { messageBody: null, messageType: type || 'unknown' };
}

/**
 * Baileys adapter (FR-301, FR-303, FR-304, FR-305 of
 * docs/sdd/changes/2026-09-01-baileys-dual-mode.md).
 *
 * Baileys is a PERSISTENT-CONNECTION model, not a push webhook: this module
 * owns a long-lived WebSocket (via `sock`) and reacts to its events
 * (`connection.update`, `messages.upsert`) rather than handling one-shot
 * HTTP requests. That's the structural difference from metaClient.js /
 * webhook.js -- everything downstream of an inbound message (the state
 * machine, Lead repo) is identical, via the shared `processInboundMessage`
 * (see inboundMessageProcessor.js).
 *
 * Stability (NFR-301) is the point of this module:
 *  - `connection.update` with a recoverable disconnect reason schedules a
 *    reconnect with exponential backoff (FR-304) -- never immediately, and
 *    never abandoned to a tight retry loop. If the reconnect attempt itself
 *    fails to even start (e.g. a filesystem error reading the auth state),
 *    that is likewise treated as recoverable -- another backoff attempt is
 *    scheduled rather than dead-ending automatic recovery (post-review
 *    fix; see "Post-build review fixes" below).
 *  - `connection.update` with a disconnect reason NOT on the explicit
 *    recoverable allowlist (`connectionClosed`, `connectionLost`,
 *    `timedOut`, `restartRequired`, `unavailableService`, or an
 *    undefined/unknown code) does the opposite on purpose: no reconnect is
 *    scheduled (retrying a dead session can't succeed), a FailedEvent is
 *    recorded (channel=whatsapp_baileys), and `getStatus()` flips to
 *    'action_needed' so the pairing screen (whatsappPair.js) can surface
 *    "reconnect needed" instead of the bot silently going dark (FR-305).
 *    This covers `loggedOut`, `badSession`, `connectionReplaced`,
 *    `forbidden`, and `multideviceMismatch` -- not just `loggedOut` (see
 *    "Post-build review fixes" below: treating those as recoverable was a
 *    real blocker found in review, since it left the pairing screen saying
 *    "reconnecting, no action needed" forever for a session that could
 *    never come back on its own).
 *
 * @param {object} deps
 * @param {string} deps.authDir - folder for useMultiFileAuthState's session
 *   files (FR-303). Local/gitignored, not the SQLite DB -- matches how this
 *   project already treats data/ as ephemeral (see .gitignore).
 * @param {(params: object) => Promise<unknown>} deps.processInboundMessage
 *   - the shared FR-302 contract from inboundMessageProcessor.js.
 * @param {ReturnType<typeof import('./failedEventsRepo').createFailedEventsRepo>} deps.failedEventsRepo
 * @param {(event: string, details?: object) => void} [deps.log]
 * @param {(opts: {auth: object}) => Promise<object>} [deps.makeSocket] - injectable for tests
 * @param {(authDir: string) => Promise<{state: object, saveCreds: Function}>} [deps.authStateProvider] - injectable for tests
 * @param {(qr: string) => Promise<string>} [deps.qrToDataUrl] - injectable for tests
 * @param {(statusCode: number|undefined) => boolean} [deps.isRecoverableCode] - injectable for tests;
 *   real default is an explicit allowlist (see defaultIsRecoverableCode above), NOT a
 *   loggedOut-only denylist.
 * @param {(statusCode: number|undefined) => {code: string, message: string}} [deps.describeNonRecoverableReason] - injectable for tests
 * @param {number} [deps.baseDelayMs]
 * @param {number} [deps.maxDelayMs]
 * @param {(fn: Function, delayMs: number) => unknown} [deps.scheduleReconnect] - injectable for tests (real default: setTimeout)
 * @param {(handle: unknown) => void} [deps.clearScheduled] - injectable for tests (real default: clearTimeout)
 */
function createBaileysConnector({
  authDir,
  processInboundMessage,
  failedEventsRepo,
  log = defaultLog,
  makeSocket = defaultMakeSocket,
  authStateProvider = defaultAuthStateProvider,
  qrToDataUrl = defaultQrToDataUrl,
  isRecoverableCode = defaultIsRecoverableCode,
  describeNonRecoverableReason = defaultDescribeNonRecoverableReason,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  scheduleReconnect = (fn, delayMs) => setTimeout(fn, delayMs),
  clearScheduled = (handle) => clearTimeout(handle),
}) {
  const state = {
    // 'disconnected' | 'connecting' | 'qr_pending' | 'open' | 'reconnecting' | 'action_needed'
    connectionStatus: 'disconnected',
    qrDataUrl: null,
    reconnectAttempts: 0,
    lastDisconnectStatusCode: null,
    // Populated only when connectionStatus is 'action_needed' -- lets the
    // pairing screen show *why* (logged out vs. session replaced vs.
    // corrupted vs. forbidden) rather than one generic message.
    disconnectReasonCode: null,
    disconnectReasonMessage: null,
  };
  let sock = null;
  let reconnectTimer = null;

  function recordFailedEvent(errorMessage, rawPayload) {
    try {
      failedEventsRepo.record({
        rawPayload: typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload || {}),
        errorMessage,
        channel: 'whatsapp_baileys',
      });
    } catch (recordErr) {
      // Same last-resort rule as webhook.js's error handler: if even
      // recording the failure fails, log and move on -- never throw out of
      // an event handler.
      log('failed_event_record_error', { error: recordErr.message });
    }
  }

  /**
   * FR-304: schedules the next reconnect attempt at the current exponential
   * backoff delay, then actually attempts it. Shared by both callers that
   * need "try again later, with growing backoff, never a dead end":
   *  - a recoverable `connection.update` close event, and
   *  - a reconnect attempt whose `start()` call itself rejected (post-review
   *    fix for Finding 2 -- previously this case just logged and stopped,
   *    a single point of failure that could permanently end automatic
   *    recovery with no owner-visible signal).
   */
  function scheduleReconnectAttempt(context = {}) {
    state.connectionStatus = 'reconnecting';
    state.reconnectAttempts += 1;
    const delayMs = Math.min(baseDelayMs * 2 ** (state.reconnectAttempts - 1), maxDelayMs);
    log('baileys_reconnect_scheduled', { attempt: state.reconnectAttempts, delayMs, ...context });
    reconnectTimer = scheduleReconnect(() => {
      start().catch((err) => { // eslint-disable-line no-use-before-define
        log('baileys_reconnect_failed', { error: err.message, attempt: state.reconnectAttempts });
        recordFailedEvent(
          `Baileys reconnect attempt ${state.reconnectAttempts} failed to start: ${err.message}`,
          { event: 'reconnect_start_failed', error: err.message, attempt: state.reconnectAttempts },
        );
        // Do NOT dead-end here: a start() failure (e.g. a filesystem error
        // reading the auth state) is treated the same as a recoverable
        // disconnect -- schedule another backoff attempt.
        scheduleReconnectAttempt({ afterStartFailure: true });
      });
    }, delayMs);
  }

  async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update || {};

    if (qr) {
      state.qrDataUrl = await qrToDataUrl(qr);
      state.connectionStatus = 'qr_pending';
      log('baileys_qr_generated', {});
    }

    if (connection === 'open') {
      state.connectionStatus = 'open';
      state.qrDataUrl = null;
      state.reconnectAttempts = 0;
      state.lastDisconnectStatusCode = null;
      state.disconnectReasonCode = null;
      state.disconnectReasonMessage = null;
      log('baileys_connected', {});
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      state.lastDisconnectStatusCode = statusCode;

      if (!isRecoverableCode(statusCode)) {
        // FR-305 (post-review fix): non-recoverable -- NOT just loggedOut.
        // badSession/connectionReplaced/forbidden/multideviceMismatch are
        // just as dead; retrying any of them is pointless and previously
        // fell through to the "recoverable" branch below, leaving the
        // pairing screen saying "reconnecting, no action needed" forever.
        const reason = describeNonRecoverableReason(statusCode);
        state.connectionStatus = 'action_needed';
        state.disconnectReasonCode = reason.code;
        state.disconnectReasonMessage = reason.message;
        log('baileys_non_recoverable_disconnect', { statusCode, reasonCode: reason.code });
        recordFailedEvent(
          `Baileys connection is non-recoverable (${reason.code}): ${reason.message} Re-pairing required.`,
          { event: 'connection.update', statusCode, reasonCode: reason.code },
        );
        return;
      }

      // FR-304: recoverable (network blip, WhatsApp-side restart, an
      // undefined/unknown status code, etc) -- back off exponentially
      // instead of hammering a reconnect in a tight loop. Capped at
      // maxDelayMs.
      scheduleReconnectAttempt({ statusCode });
    }
  }

  async function handleMessagesUpsert(payload) {
    const { messages, type } = payload || {};
    // Baileys replays history on (re)connect as type 'append'; only
    // 'notify' is a genuinely new inbound message worth driving the state
    // machine with.
    if (type !== 'notify' || !Array.isArray(messages)) return;

    for (const msg of messages) {
      if (!msg?.message || msg.key?.fromMe) continue; // eslint-disable-line no-continue -- skip our own echoed sends and reaction/protocol-only entries
      const phoneNumber = toPhoneNumber(msg.key?.remoteJid);
      if (!phoneNumber) continue; // eslint-disable-line no-continue

      const { messageBody, messageType } = extractBaileysContent(msg.message);
      const timestamp = msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString();

      try {
        // eslint-disable-next-line no-await-in-loop -- process sequentially, same as webhook.js
        await processInboundMessage({
          phoneNumber,
          messageBody,
          messageType,
          timestamp,
          channel: 'whatsapp_baileys',
        });
      } catch (err) {
        log('baileys_message_processing_failed', { error: err.message });
        recordFailedEvent(err.message, msg);
      }
    }
  }

  /** FR-302's outbound half of the shared contract. */
  async function sendTextMessage(phoneNumber, text) {
    if (!sock) throw new Error('Baileys socket is not connected');
    await sock.sendMessage(toJid(phoneNumber), { text });
  }

  async function start() {
    if (reconnectTimer) {
      clearScheduled(reconnectTimer);
      reconnectTimer = null;
    }
    state.connectionStatus = 'connecting';

    const { state: authState, saveCreds } = await authStateProvider(authDir);
    sock = await makeSocket({ auth: authState });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      handleConnectionUpdate(update).catch((err) => log('baileys_connection_update_error', { error: err.message }));
    });
    sock.ev.on('messages.upsert', (payload) => {
      handleMessagesUpsert(payload).catch((err) => log('baileys_messages_upsert_error', { error: err.message }));
    });

    return sock;
  }

  /**
   * FR-305's "reconnect needed" path isn't just informational -- the owner
   * needs an actual way to re-pair without an SSH session / server
   * restart. This wipes the (now-invalid) session files and starts fresh,
   * which causes Baileys to emit a brand new QR via 'connection.update'.
   */
  async function resetAndRestart() {
    if (reconnectTimer) {
      clearScheduled(reconnectTimer);
      reconnectTimer = null;
    }
    if (authDir && fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    state.qrDataUrl = null;
    state.reconnectAttempts = 0;
    state.lastDisconnectStatusCode = null;
    state.disconnectReasonCode = null;
    state.disconnectReasonMessage = null;
    return start();
  }

  function getStatus() {
    return { ...state };
  }

  return {
    start,
    resetAndRestart,
    getStatus,
    sendTextMessage,
    // Exposed for tests: lets a test drive the connector's event handlers
    // directly (or via a fake sock.ev emitter after start()) without a real
    // Baileys connection -- see tests/baileysConnector.test.js.
    _handleConnectionUpdate: handleConnectionUpdate,
    _handleMessagesUpsert: handleMessagesUpsert,
  };
}

module.exports = { createBaileysConnector, toPhoneNumber, toJid, extractBaileysContent };
