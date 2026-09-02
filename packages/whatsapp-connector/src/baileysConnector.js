'use strict';

const fs = require('fs');
const { log: defaultLog } = require('./logger');

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60000;

/**
 * FR-1201..FR-1203 (docs/sdd/changes/2026-09-02-reconnect-throttle.md):
 * a DIFFERENT concern from DEFAULT_BASE_DELAY_MS/DEFAULT_MAX_DELAY_MS above,
 * which govern how long we wait before *attempting* a reconnect. These
 * govern how much extra delay is added before an outbound *message send*,
 * for a short cooldown window after a reconnect has already SUCCEEDED --
 * research (Baileys issues #2110/#1869, cited in the change doc) found
 * frequent reconnects are an independent ban-risk signal, and that easing
 * send speed back up over ~60s after a reconnect (rather than resuming at
 * full speed immediately) is a documented, if unproven, mitigation.
 */
// Cooldown window: how long after a genuine reconnect the throttle applies.
// Past this, sends resume at normal (1x) speed.
const DEFAULT_RECONNECT_THROTTLE_WINDOW_MS = 60000;
// Extra-delay multiplier applied immediately after a reconnect, linearly
// ramping down to 1x (no extra delay) at the end of the cooldown window.
const DEFAULT_RECONNECT_THROTTLE_MAX_MULTIPLIER = 3;
// The per-message unit of "extra delay" the multiplier above is applied to
// (extraDelayMs = baseThrottleDelayMs * (multiplier - 1)) -- independent of
// DEFAULT_BASE_DELAY_MS (reconnect-attempt backoff) on purpose, since this
// governs a send-side delay, not a reconnect-scheduling delay.
const DEFAULT_RECONNECT_THROTTLE_BASE_DELAY_MS = 1000;

/**
 * FR-1201/NFR-1202: pure, directly-testable ramp calculation -- given how
 * long it's been since a genuine reconnect, returns the extra-delay
 * multiplier that should apply to this send (1 = no extra delay).
 *
 * Deliberately kept free of clocks/timers/async so it can be asserted
 * against exact time values in tests (0s/30s/60s/90s etc.) without any fake
 * timer machinery -- see baileysConnector.test.js.
 *
 * Linear ramp: `maxMultiplier` at msSinceReconnect=0, decreasing linearly to
 * 1 at msSinceReconnect=windowMs, then holding at 1 for anything beyond.
 *
 * @param {number|null|undefined} msSinceReconnect - null/undefined means
 *   "no genuine reconnect has happened this session" (FR-1202: first-ever
 *   connect) -- always returns 1 (no throttle) in that case.
 * @param {object} [options]
 * @param {number} [options.windowMs] - defaults to DEFAULT_RECONNECT_THROTTLE_WINDOW_MS
 * @param {number} [options.maxMultiplier] - defaults to DEFAULT_RECONNECT_THROTTLE_MAX_MULTIPLIER
 * @returns {number} the delay multiplier, in [1, maxMultiplier]
 */
function calculateReconnectThrottleMultiplier(msSinceReconnect, options = {}) {
  const {
    windowMs = DEFAULT_RECONNECT_THROTTLE_WINDOW_MS,
    maxMultiplier = DEFAULT_RECONNECT_THROTTLE_MAX_MULTIPLIER,
  } = options;

  if (msSinceReconnect === null || msSinceReconnect === undefined) return 1;
  // Negative elapsed time shouldn't be reachable in practice (clock going
  // backwards), but treat it the same as "just reconnected" rather than
  // producing a multiplier outside [1, maxMultiplier].
  if (msSinceReconnect <= 0) return maxMultiplier;
  if (msSinceReconnect >= windowMs) return 1;

  const progress = msSinceReconnect / windowMs; // 0 (just reconnected) -> 1 (window elapsed)
  return maxMultiplier - (maxMultiplier - 1) * progress;
}

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

/**
 * FR-703 (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md):
 * a real client got logged out shortly after connecting, and tracing the
 * code found this socket was being created with ZERO identity/fingerprint
 * configuration beyond bare library defaults -- everything below is a
 * documented, commonly-recommended-practice mitigation for that, not a
 * guarantee (see the README's "Dual WhatsApp mode" section for the honest
 * framing -- the underlying ban/detection risk of an unofficial protocol
 * implementation is not eliminated by any of this).
 */
async function defaultMakeSocket({ auth }) {
  const baileys = require('@whiskeysockets/baileys'); // eslint-disable-line global-require
  const makeWASocket = baileys.default || baileys.makeWASocket;
  return makeWASocket({
    auth,
    printQRInTerminal: false,
    logger: defaultLoggerInstance(),
    // FR-703: an explicit, realistic client identity instead of leaving
    // this at the library's own bare default. `Browsers` is a helper this
    // installed version of @whiskeysockets/baileys (^7.0.0-rc14) actually
    // exports (`Browsers.ubuntu/macOS/windows/android/appropriate/baileys`)
    // -- `Browsers.ubuntu('Chrome')` produces the
    // `['Ubuntu', 'Chrome', '...']` browser tuple WhatsApp's multi-device
    // protocol expects, presenting as an ordinary desktop-linked-device
    // session rather than an unnamed/generic client. This is a
    // commonly-recommended Baileys practice, not something this project
    // invented -- see the README for the honest "mitigation, not a fix"
    // framing.
    browser: baileys.Browsers.ubuntu('Chrome'),
    // FR-703: do NOT flip the account to "online" the moment the socket
    // connects. A number that's paired via an unofficial client but never
    // otherwise appears online (this app is reply-only, not an interactive
    // client anyone is "using") is a smaller behavioral fingerprint than
    // one that immediately, robotically goes "online" on every reconnect.
    // Baileys defaults this to `false` already; set explicitly so the
    // choice is documented here instead of relying on an implicit library
    // default that could silently change in a future version.
    markOnlineOnConnect: false,
    // FR-703: skip syncing the account's full message history on initial
    // connect. This app only cares about NEW inbound messages from this
    // point forward (see handleMessagesUpsert()'s `type !== 'notify'`
    // filter below, which already discards replayed history) -- a full
    // history sync is extra load/traffic this app has no use for, and is
    // one of the most commonly-recommended settings to reduce for a
    // lightweight, reply-only Baileys client like this one.
    syncFullHistory: false,
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
 * @param {() => number} [deps.now] - injectable clock (real default: `Date.now`) (FR-1201/NFR-1202) --
 *   used to timestamp genuine reconnects and to compute elapsed time in
 *   `sendTextMessage`'s throttle check.
 * @param {(ms: number) => Promise<unknown>} [deps.sleep] - injectable delay
 *   mechanism (real default: a `setTimeout`-based sleep) (FR-1201/NFR-1202)
 *   -- the reconnect-throttle's own pre-send delay, applied in
 *   `sendTextMessage` before calling `sock.sendMessage`. Deliberately
 *   separate from @rimba/humanized-timing's own injectable `sleep` (this
 *   package doesn't own that module's delay logic -- see this file's
 *   `sendTextMessage` doc comment).
 * @param {number} [deps.reconnectThrottleWindowMs] - FR-1203: cooldown window
 *   duration, defaults to DEFAULT_RECONNECT_THROTTLE_WINDOW_MS (60s).
 * @param {number} [deps.reconnectThrottleMaxMultiplier] - FR-1203: extra-delay
 *   multiplier immediately after a reconnect, defaults to
 *   DEFAULT_RECONNECT_THROTTLE_MAX_MULTIPLIER (3x).
 * @param {number} [deps.reconnectThrottleBaseDelayMs] - FR-1203: the ms unit
 *   the multiplier above scales, defaults to
 *   DEFAULT_RECONNECT_THROTTLE_BASE_DELAY_MS.
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
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  reconnectThrottleWindowMs = DEFAULT_RECONNECT_THROTTLE_WINDOW_MS,
  reconnectThrottleMaxMultiplier = DEFAULT_RECONNECT_THROTTLE_MAX_MULTIPLIER,
  reconnectThrottleBaseDelayMs = DEFAULT_RECONNECT_THROTTLE_BASE_DELAY_MS,
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
    // FR-1201/FR-1202: true once this session's socket has reached 'open'
    // at least once -- used to distinguish "first-ever connect" (never
    // throttled) from a genuine reconnect (every 'open' after the first).
    hasConnectedOnce: false,
    // FR-1201: `now()` timestamp of the most recent GENUINE reconnect (i.e.
    // NOT the first-ever connect of this session). null means no genuine
    // reconnect has happened yet -- sendTextMessage's throttle check treats
    // that as "never throttle" (FR-1202), same as calling
    // calculateReconnectThrottleMultiplier(null).
    lastReconnectAt: null,
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
      // FR-1201/FR-1202: a genuine reconnect is any 'open' event that is NOT
      // this session's first-ever successful connection -- Baileys only
      // fires 'open' after (re-)establishing the socket, so a second (or
      // later) 'open' necessarily followed a prior disconnect/close.
      const isGenuineReconnect = state.hasConnectedOnce;
      if (isGenuineReconnect) {
        state.lastReconnectAt = now();
        log('baileys_reconnect_throttle_window_started', { lastReconnectAt: state.lastReconnectAt });
      }
      state.hasConnectedOnce = true;

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
          contactId: phoneNumber,
          messageBody,
          messageType,
          timestamp,
          channel: 'whatsapp_baileys',
          // FR-601/FR-604 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
          // threaded through to inboundMessageProcessor.js -> markAsRead
          // below, mirroring the WAMID threaded through webhook.js for the
          // Cloud API side.
          messageId: msg.key?.id,
        });
      } catch (err) {
        log('baileys_message_processing_failed', { error: err.message });
        recordFailedEvent(err.message, msg);
      }
    }
  }

  /**
   * FR-1201: if this send falls within the reconnect-throttle cooldown
   * window, sleeps an extra `reconnectThrottleBaseDelayMs * (multiplier - 1)`
   * ms before returning -- on top of, not instead of, whatever delay
   * @rimba/humanized-timing's sendWithHumanizedTiming already applied
   * upstream (inboundMessageProcessor.js calls that module BEFORE invoking
   * this connector's sendTextMessage -- see that module's doc comment).
   * This package deliberately does not reach into or duplicate
   * humanized-timing's own delay math; it only adds its own additional
   * pre-send delay, using its own injectable `now`/`sleep` (NFR-1202/NFR-603
   * pattern) so this stays independently, deterministically testable.
   *
   * A no-op multiplier of 1 (outside the cooldown window, or no genuine
   * reconnect has happened this session -- FR-1202) sleeps 0ms, i.e. no
   * observable delay at all.
   */
  async function applyReconnectThrottleDelay() {
    const multiplier = calculateReconnectThrottleMultiplier(
      state.lastReconnectAt === null ? null : now() - state.lastReconnectAt,
      { windowMs: reconnectThrottleWindowMs, maxMultiplier: reconnectThrottleMaxMultiplier },
    );
    if (multiplier <= 1) return;
    const extraDelayMs = Math.round(reconnectThrottleBaseDelayMs * (multiplier - 1));
    log('baileys_reconnect_throttle_applied', { multiplier, extraDelayMs });
    await sleep(extraDelayMs);
  }

  /** FR-302's outbound half of the shared contract. */
  async function sendTextMessage(phoneNumber, text) {
    if (!sock) throw new Error('Baileys socket is not connected');
    await applyReconnectThrottleDelay();
    await sock.sendMessage(toJid(phoneNumber), { text });
  }

  /**
   * FR-601/FR-604 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
   * the markAsRead half of the shared humanized-timing contract (alongside
   * sendTypingIndicator below), orchestrated by
   * src/lib/humanizedTiming.js via inboundMessageProcessor.js -- this
   * function itself is just the thin Baileys-specific primitive. Unlike
   * metaClient.js's markAsRead, Baileys genuinely needs `phoneNumber` here
   * (to build the JID for `sock.readMessages`), not just `messageId`.
   *
   * Deliberately never throws: a failed read receipt is a "nice to have"
   * human-feel signal, not the substantive reply -- it must never block or
   * fail the actual message send that follows.
   */
  async function markAsRead(phoneNumber, messageId) {
    if (!sock || !messageId) return;
    try {
      await sock.readMessages([{ remoteJid: toJid(phoneNumber), id: messageId }]);
    } catch (err) {
      log('baileys_mark_read_failed', { error: err.message });
    }
  }

  /**
   * FR-603: re-sent periodically by src/lib/humanizedTiming.js (not this
   * function) for long simulated typing durations. Baileys models "typing"
   * as a presence update, not a discrete read/typing status call like
   * Meta's Cloud API.
   */
  async function sendTypingIndicator(phoneNumber) {
    if (!sock) return;
    try {
      await sock.sendPresenceUpdate('composing', toJid(phoneNumber));
    } catch (err) {
      log('baileys_typing_indicator_failed', { error: err.message });
    }
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
    // FR-1202 (judgment call): re-pairing wipes the session's auth files and
    // starts fresh -- a brand new WhatsApp linked-device session, not a
    // "genuine reconnect" of the old one. So the very next 'open' after this
    // must be treated as this (new) session's first-ever connect, exactly
    // like the first `start()` call ever was -- not throttled.
    state.hasConnectedOnce = false;
    state.lastReconnectAt = null;
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
    markAsRead,
    sendTypingIndicator,
    // Exposed for tests: lets a test drive the connector's event handlers
    // directly (or via a fake sock.ev emitter after start()) without a real
    // Baileys connection -- see tests/baileysConnector.test.js.
    _handleConnectionUpdate: handleConnectionUpdate,
    _handleMessagesUpsert: handleMessagesUpsert,
  };
}

module.exports = {
  createBaileysConnector,
  toPhoneNumber,
  toJid,
  extractBaileysContent,
  calculateReconnectThrottleMultiplier,
  DEFAULT_RECONNECT_THROTTLE_WINDOW_MS,
  DEFAULT_RECONNECT_THROTTLE_MAX_MULTIPLIER,
  DEFAULT_RECONNECT_THROTTLE_BASE_DELAY_MS,
};
