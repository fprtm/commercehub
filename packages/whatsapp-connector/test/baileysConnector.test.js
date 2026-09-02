'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  createBaileysConnector,
  calculateReconnectThrottleMultiplier,
  DEFAULT_RECONNECT_THROTTLE_WINDOW_MS,
  DEFAULT_RECONNECT_THROTTLE_MAX_MULTIPLIER,
} = require('../src/baileysConnector');
// The real package (already an installed dependency) is used only for its
// DisconnectReason numeric constants -- requiring it does not open a
// network connection or touch a real WhatsApp account.
const { DisconnectReason } = require('@whiskeysockets/baileys');

/**
 * A fake Baileys socket: a real EventEmitter for `.ev` (matching Baileys'
 * actual `sock.ev.on(...)` API) plus a no-op `sendMessage`. No real
 * `@whiskeysockets/baileys` connection is ever opened by these tests --
 * `makeSocket`/`authStateProvider` are fully injected fakes, per the task's
 * "mock the Baileys socket object/event emitter" instruction (no phone
 * available in this environment to scan a real QR code).
 */
function createFakeSock() {
  const ev = new EventEmitter();
  const sent = [];
  return {
    ev,
    sent,
    async sendMessage(jid, content) {
      sent.push({ jid, content });
    },
  };
}

function buildConnector(overrides = {}) {
  const scheduled = [];
  const failedEvents = [];
  const logs = [];
  let capturedSock;

  const connector = createBaileysConnector({
    authDir: '/tmp/baileys-test-auth',
    processInboundMessage: overrides.processInboundMessage || (async () => {}),
    failedEventsRepo: { record: (e) => failedEvents.push(e) },
    log: (event, details) => logs.push({ event, details }),
    makeSocket: async () => {
      capturedSock = createFakeSock();
      return capturedSock;
    },
    authStateProvider: async () => ({ state: {}, saveCreds: () => {} }),
    qrToDataUrl: async (qr) => `data:image/png;base64,FAKE(${qr})`,
    // Deterministic, non-time-based reconnect scheduling: capture the
    // (fn, delay) pair instead of actually waiting on a real/fake timer.
    // This is what makes the "backoff, not immediate" assertion below a
    // real assertion on the computed delay rather than a test that has to
    // sleep and hope.
    scheduleReconnect: (fn, delayMs) => {
      scheduled.push({ fn, delayMs });
      return scheduled.length;
    },
    clearScheduled: () => {},
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    ...overrides.connectorOverrides,
  });

  return { connector, scheduled, failedEvents, logs, getSock: () => capturedSock };
}

test('FR-304/NFR-301: a recoverable disconnect schedules a reconnect with backoff (not immediately)', async () => {
  const { connector, scheduled } = buildConnector();
  await connector.start();

  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
  });

  assert.equal(scheduled.length, 1, 'exactly one reconnect must be scheduled for a recoverable disconnect');
  assert.equal(scheduled[0].delayMs, 1000, 'first attempt uses the base backoff delay, not 0/immediate');
  assert.ok(scheduled[0].delayMs > 0, 'reconnect must be scheduled with a real delay, never immediate');
  assert.equal(connector.getStatus().connectionStatus, 'reconnecting');
});

test('FR-304/NFR-301: repeated recoverable disconnects back off exponentially instead of hammering in a tight loop', async () => {
  const { connector, scheduled } = buildConnector();
  await connector.start();

  const closeEvent = {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
  };

  await connector._handleConnectionUpdate(closeEvent); // attempt 1
  await connector._handleConnectionUpdate(closeEvent); // attempt 2 (simulating the reconnect itself failing again)
  await connector._handleConnectionUpdate(closeEvent); // attempt 3

  assert.deepEqual(
    scheduled.map((s) => s.delayMs),
    [1000, 2000, 4000],
    'backoff must grow exponentially across consecutive failures',
  );
  assert.equal(connector.getStatus().reconnectAttempts, 3);
});

test('FR-304/NFR-301: reconnecting after connection is restored resets the backoff counter', async () => {
  const { connector, scheduled } = buildConnector();
  await connector.start();

  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
  });
  assert.equal(scheduled[0].delayMs, 1000);

  await connector._handleConnectionUpdate({ connection: 'open' });
  assert.equal(connector.getStatus().connectionStatus, 'open');
  assert.equal(connector.getStatus().reconnectAttempts, 0, 'a successful reconnect resets the attempt counter');

  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
  });
  assert.equal(scheduled[1].delayMs, 1000, 'backoff restarts from the base delay after a successful reconnect, not from where it left off');
});

test('FR-305/NFR-301: DisconnectReason.loggedOut does NOT schedule a reconnect and surfaces "reconnect needed"', async () => {
  const { connector, scheduled, failedEvents } = buildConnector();
  await connector.start();

  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
  });

  assert.equal(scheduled.length, 0, 'a logged-out session must never trigger the auto-reconnect loop -- retrying it is pointless');
  assert.equal(connector.getStatus().connectionStatus, 'action_needed', 'pairing screen state must flip to "reconnect needed", not stay silently dead');
  assert.equal(connector.getStatus().disconnectReasonCode, 'logged_out');
  assert.match(connector.getStatus().disconnectReasonMessage, /logged out/i);

  assert.equal(failedEvents.length, 1, 'FR-305: a non-recoverable disconnect is logged as a FailedEvent');
  assert.equal(failedEvents[0].channel, 'whatsapp_baileys');
  assert.match(failedEvents[0].errorMessage, /logged out/i);
});

test('FR-305: a loggedOut disconnect followed by more time passing still never reconnects on its own', async () => {
  const { connector, scheduled } = buildConnector();
  await connector.start();

  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
  });
  // Simulate Baileys firing another close event in the same non-recoverable
  // state (e.g. a leftover socket teardown echo) -- must still not reconnect.
  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
  });

  assert.equal(scheduled.length, 0);
  assert.equal(connector.getStatus().connectionStatus, 'action_needed');
});

// --- Post-review Finding 1 (BLOCKER): loggedOut was the ONLY disconnect
// reason ever treated as non-recoverable. badSession/connectionReplaced/
// forbidden/multideviceMismatch are just as permanently dead but were
// previously falling through to the "recoverable" branch and getting an
// exponential-backoff reconnect loop forever, while the pairing screen said
// "Reconnecting… no action needed" -- a silently-dead bot with a false
// "don't worry" message. These three tests cover that each of those reasons
// is now treated the same as loggedOut: no reconnect, a FailedEvent, and a
// UI-facing non-recoverable status.

test('FR-305 (post-review fix): DisconnectReason.badSession (corrupted session) does NOT reconnect and surfaces "reconnect needed"', async () => {
  const { connector, scheduled, failedEvents } = buildConnector();
  await connector.start();

  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.badSession } } },
  });

  assert.equal(scheduled.length, 0, 'a corrupted session must never trigger the auto-reconnect loop');
  assert.equal(connector.getStatus().connectionStatus, 'action_needed');
  assert.equal(connector.getStatus().disconnectReasonCode, 'bad_session');

  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].channel, 'whatsapp_baileys');
  assert.match(failedEvents[0].errorMessage, /bad_session/i);
});

test('FR-305 (post-review fix): DisconnectReason.connectionReplaced (paired elsewhere) does NOT reconnect and surfaces "reconnect needed"', async () => {
  const { connector, scheduled, failedEvents } = buildConnector();
  await connector.start();

  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionReplaced } } },
  });

  assert.equal(scheduled.length, 0, 'a replaced session must never trigger the auto-reconnect loop -- another device now owns it');
  assert.equal(connector.getStatus().connectionStatus, 'action_needed');
  assert.equal(connector.getStatus().disconnectReasonCode, 'connection_replaced');
  assert.match(connector.getStatus().disconnectReasonMessage, /linked to a different device/i);

  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].channel, 'whatsapp_baileys');
});

test('FR-305 (post-review fix): DisconnectReason.forbidden (number banned/restricted) does NOT reconnect and surfaces "reconnect needed"', async () => {
  const { connector, scheduled, failedEvents } = buildConnector();
  await connector.start();

  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.forbidden } } },
  });

  assert.equal(scheduled.length, 0, 'a forbidden/banned number must never trigger the auto-reconnect loop');
  assert.equal(connector.getStatus().connectionStatus, 'action_needed');
  assert.equal(connector.getStatus().disconnectReasonCode, 'forbidden');
  assert.match(connector.getStatus().disconnectReasonMessage, /blocked or restricted/i);

  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].channel, 'whatsapp_baileys');
});

test('FR-305 (post-review fix): an undefined/unknown disconnect statusCode is treated as recoverable (safe default), not fatal', async () => {
  const { connector, scheduled, failedEvents } = buildConnector();
  await connector.start();

  await connector._handleConnectionUpdate({ connection: 'close', lastDisconnect: {} }); // no statusCode at all

  assert.equal(scheduled.length, 1, 'an unknown/undefined disconnect reason must default to recoverable, not fatal');
  assert.equal(connector.getStatus().connectionStatus, 'reconnecting');
  assert.equal(failedEvents.length, 0);
});

// --- Post-review Finding 2 (MAJOR): if start() itself rejects while
// attempting a scheduled reconnect (e.g. a filesystem error reading the
// auth state), the old code only logged and stopped -- no further
// reconnect, no FailedEvent, status left stale. That's a single point of
// failure that could permanently end automatic recovery with zero
// owner-visible signal, contradicting FR-304's "without manual
// intervention". Fixed: a failed start() during a reconnect attempt is now
// treated the same as a recoverable close -- another backoff attempt is
// scheduled.

test('FR-304 (post-review fix): if start() rejects during a reconnect attempt, another reconnect is scheduled -- not a dead stop', async () => {
  let makeSocketCallCount = 0;
  const { connector, scheduled, failedEvents } = buildConnector({
    connectorOverrides: {
      makeSocket: async () => {
        makeSocketCallCount += 1;
        if (makeSocketCallCount === 2) {
          throw new Error('simulated filesystem error reading auth state');
        }
        return createFakeSock();
      },
    },
  });

  await connector.start(); // call #1 -- succeeds

  await connector._handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 1000);

  // Simulate the backoff timer firing: this calls start() again (call #2),
  // which is rigged to reject.
  scheduled[0].fn();
  // The rejection's .catch handler runs asynchronously -- give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(scheduled.length, 2, 'a start() failure during a reconnect attempt must schedule ANOTHER attempt, not dead-end recovery');
  assert.equal(scheduled[1].delayMs, 2000, 'backoff keeps growing across the failed start() attempt, same as a recoverable close would');
  assert.equal(connector.getStatus().connectionStatus, 'reconnecting', 'status must stay in a visibly-recovering state, not be left stale');
  assert.ok(
    failedEvents.some((e) => e.channel === 'whatsapp_baileys' && /failed to start/i.test(e.errorMessage)),
    'the failed start() attempt itself should be recorded as a FailedEvent',
  );
});

test('the connection.update wiring set up in start() actually reaches the reconnect logic via a real sock.ev.emit (not just calling the private handler)', async () => {
  const { connector, scheduled, getSock } = buildConnector();
  await connector.start();

  getSock().ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
  });

  // handleConnectionUpdate is async; let its promise chain flush.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scheduled.length, 1, 'emitting a real connection.update event through sock.ev must reach the same backoff logic');
});

test('FR-303: a QR in connection.update is converted to a data URI and exposed via getStatus()', async () => {
  const { connector } = buildConnector();
  await connector.start();

  await connector._handleConnectionUpdate({ qr: 'raw-qr-string-from-whatsapp' });

  const status = connector.getStatus();
  assert.equal(status.connectionStatus, 'qr_pending');
  assert.match(status.qrDataUrl, /^data:image\/png;base64,FAKE\(raw-qr-string-from-whatsapp\)$/);
});

test('FR-302: messages.upsert extracts the phone number from the JID and calls the shared processInboundMessage, skipping our own echoed sends and history-sync noise', async () => {
  const calls = [];
  const { connector } = buildConnector({ processInboundMessage: async (args) => calls.push(args) });
  await connector.start();

  await connector._handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '6281234567890@s.whatsapp.net', fromMe: false },
        message: { conversation: 'halo, baju ini masih ada?' },
        messageTimestamp: 1735689600,
      },
      // our own outbound reply echoed back -- must be skipped
      {
        key: { remoteJid: '6281234567890@s.whatsapp.net', fromMe: true },
        message: { conversation: 'This is an automated reply...' },
      },
      // a non-text message type -- must still be forwarded, with a null body
      {
        key: { remoteJid: '6289999999999@s.whatsapp.net', fromMe: false },
        message: { stickerMessage: { url: 'x' } },
      },
    ],
  });

  // A history-sync replay on reconnect ('append') must be ignored entirely.
  await connector._handleMessagesUpsert({
    type: 'append',
    messages: [{ key: { remoteJid: '6280000000000@s.whatsapp.net' }, message: { conversation: 'old history' } }],
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].contactId, '6281234567890');
  assert.equal(calls[0].messageBody, 'halo, baju ini masih ada?');
  assert.equal(calls[0].messageType, 'text');
  assert.equal(calls[0].channel, 'whatsapp_baileys');
  assert.equal(calls[0].timestamp, new Date(1735689600 * 1000).toISOString());

  assert.equal(calls[1].contactId, '6289999999999');
  assert.equal(calls[1].messageBody, null);
  assert.equal(calls[1].messageType, 'stickerMessage');
});

test('FR-601: messages.upsert threads the Baileys message id (msg.key.id) through to processInboundMessage as messageId', async () => {
  const calls = [];
  const { connector } = buildConnector({ processInboundMessage: async (args) => calls.push(args) });
  await connector.start();

  await connector._handleMessagesUpsert({
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '6281234567890@s.whatsapp.net', fromMe: false, id: 'BAILEYS-MSG-ID-1' },
        message: { conversation: 'halo' },
      },
    ],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].messageId, 'BAILEYS-MSG-ID-1');
});

test('a processInboundMessage failure during messages.upsert is recorded as a whatsapp_baileys FailedEvent, not thrown', async () => {
  const { connector, failedEvents } = buildConnector({
    processInboundMessage: async () => {
      throw new Error('boom: simulated DB failure');
    },
  });
  await connector.start();

  await connector._handleMessagesUpsert({
    type: 'notify',
    messages: [{ key: { remoteJid: '6281111111111@s.whatsapp.net', fromMe: false }, message: { conversation: 'hi' } }],
  });

  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].channel, 'whatsapp_baileys');
  assert.match(failedEvents[0].errorMessage, /boom/);
});

test('FR-302: sendTextMessage forwards to the underlying socket with a WhatsApp JID', async () => {
  const { connector, getSock } = buildConnector();
  await connector.start();

  await connector.sendTextMessage('6281234567890', 'hello there');

  assert.deepEqual(getSock().sent, [{ jid: '6281234567890@s.whatsapp.net', content: { text: 'hello there' } }]);
});

test('sendTextMessage throws a clear error if called before the socket is connected', async () => {
  const { connector } = buildConnector();
  await assert.rejects(() => connector.sendTextMessage('6281234567890', 'hi'), /not connected/i);
});

// --- FR-601/FR-604 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
// markAsRead/sendTypingIndicator are the new Baileys-specific primitives the
// shared humanized-timing module (src/lib/humanizedTiming.js) calls into via
// inboundMessageProcessor.js. These are unit-tested here in isolation (fake
// sock, no real timing/orchestration involved -- that's covered by
// tests/humanizedTiming.test.js and the real delay math is proven there,
// deterministically, with a fake `sleep`).

test('FR-601: markAsRead calls sock.readMessages with a JID built from the phone number and the given message id', async () => {
  const fakeSock = createFakeSock();
  const readCalls = [];
  fakeSock.readMessages = async (keys) => readCalls.push(...keys);

  const { connector } = buildConnector({
    connectorOverrides: { makeSocket: async () => fakeSock },
  });
  await connector.start();

  await connector.markAsRead('6281234567890', 'wamid.123');

  assert.deepEqual(readCalls, [{ remoteJid: '6281234567890@s.whatsapp.net', id: 'wamid.123' }]);
});

test('FR-601: markAsRead is a safe no-op if called before the socket is connected (never throws)', async () => {
  const { connector } = buildConnector();
  await assert.doesNotReject(() => connector.markAsRead('6281234567890', 'wamid.123'));
});

test('FR-601: markAsRead is a safe no-op with no messageId (nothing to mark read against)', async () => {
  const fakeSock = createFakeSock();
  const readCalls = [];
  fakeSock.readMessages = async (keys) => readCalls.push(...keys);
  const { connector } = buildConnector({ connectorOverrides: { makeSocket: async () => fakeSock } });
  await connector.start();

  await connector.markAsRead('6281234567890', undefined);

  assert.equal(readCalls.length, 0);
});

test('FR-603: sendTypingIndicator sends a "composing" presence update to the JID', async () => {
  const fakeSock = createFakeSock();
  const presenceCalls = [];
  fakeSock.sendPresenceUpdate = async (presence, jid) => presenceCalls.push({ presence, jid });

  const { connector } = buildConnector({ connectorOverrides: { makeSocket: async () => fakeSock } });
  await connector.start();

  await connector.sendTypingIndicator('6281234567890');

  assert.deepEqual(presenceCalls, [{ presence: 'composing', jid: '6281234567890@s.whatsapp.net' }]);
});

test('FR-603: sendTypingIndicator is a safe no-op if called before the socket is connected (never throws)', async () => {
  const { connector } = buildConnector();
  await assert.doesNotReject(() => connector.sendTypingIndicator('6281234567890'));
});

test('FR-601/FR-604: markAsRead/sendTypingIndicator never throw even if the underlying socket call rejects -- a failed "nice to have" signal must not break the reply pipeline', async () => {
  const fakeSock = createFakeSock();
  fakeSock.readMessages = async () => { throw new Error('simulated socket failure'); };
  fakeSock.sendPresenceUpdate = async () => { throw new Error('simulated socket failure'); };

  const { connector, logs } = buildConnector({ connectorOverrides: { makeSocket: async () => fakeSock } });
  await connector.start();

  await assert.doesNotReject(() => connector.markAsRead('6281234567890', 'wamid.1'));
  await assert.doesNotReject(() => connector.sendTypingIndicator('6281234567890'));

  assert.ok(logs.some((l) => l.event === 'baileys_mark_read_failed'));
  assert.ok(logs.some((l) => l.event === 'baileys_typing_indicator_failed'));
});

// --- FR-1201..FR-1203/NFR-1201/NFR-1202 (docs/sdd/changes/2026-09-02-
// reconnect-throttle.md): after a genuine reconnect, sendTextMessage adds
// extra pre-send delay for a 60s cooldown, ramping from 3x down to 1x -- a
// DIFFERENT concern from the reconnect-ATTEMPT backoff tested above (that's
// "how long to wait before trying to reconnect"; this is "how much to slow
// down sends for a bit after a reconnect already succeeded").

// --- calculateReconnectThrottleMultiplier: the pure ramp function itself
// (NFR-1202) -- asserted directly against exact time values, no connector,
// no timers, no async involved at all.

test('FR-1201/NFR-1202: calculateReconnectThrottleMultiplier ramps linearly from 3x at t=0 down to 1x at the 60s cooldown mark, then holds at 1x', () => {
  assert.equal(calculateReconnectThrottleMultiplier(0), 3, 'immediately after reconnect: max multiplier (3x)');
  assert.equal(calculateReconnectThrottleMultiplier(30000), 2, '30s in (linear midpoint of 3x..1x): 2x');
  assert.equal(calculateReconnectThrottleMultiplier(60000), 1, 'exactly at the 60s cooldown mark: back to 1x (no extra delay)');
  assert.equal(calculateReconnectThrottleMultiplier(90000), 1, 'past the cooldown window: still 1x, not below/above');
});

test('FR-1202: calculateReconnectThrottleMultiplier(null|undefined) is always 1x -- "no genuine reconnect yet this session" means never throttle', () => {
  assert.equal(calculateReconnectThrottleMultiplier(null), 1);
  assert.equal(calculateReconnectThrottleMultiplier(undefined), 1);
});

test('FR-1203: calculateReconnectThrottleMultiplier honors custom windowMs/maxMultiplier options instead of hardcoded defaults', () => {
  assert.equal(calculateReconnectThrottleMultiplier(0, { windowMs: 10000, maxMultiplier: 5 }), 5);
  assert.equal(calculateReconnectThrottleMultiplier(5000, { windowMs: 10000, maxMultiplier: 5 }), 3, 'midpoint of a custom 10s window/5x max: 3x');
  assert.equal(calculateReconnectThrottleMultiplier(10000, { windowMs: 10000, maxMultiplier: 5 }), 1);
});

test('FR-1203: the exported defaults match the documented 60s window / 3x max multiplier', () => {
  assert.equal(DEFAULT_RECONNECT_THROTTLE_WINDOW_MS, 60000);
  assert.equal(DEFAULT_RECONNECT_THROTTLE_MAX_MULTIPLIER, 3);
});

// --- Connector-level integration: real sendTextMessage, with an injectable
// fake clock (`now`) and a fake `sleep` that records calls instead of
// actually waiting, so "1 second after reconnect" vs "90 seconds after
// reconnect" can be simulated without the test suite ever waiting in real
// time (matching the existing injectable-sleep pattern already used by
// @rimba/humanized-timing's own tests).

function buildThrottleConnector({ initialTime = 0, connectorOverrides = {} } = {}) {
  let currentTime = initialTime;
  const sleepCalls = [];
  const built = buildConnector({
    connectorOverrides: {
      now: () => currentTime,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      ...connectorOverrides,
    },
  });
  return { ...built, sleepCalls, advanceTime: (ms) => { currentTime += ms; } };
}

const RECOVERABLE_CLOSE_EVENT = {
  connection: 'close',
  lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } },
};

test('FR-1202 (acceptance): the very first connection of a session sends at normal speed -- no extra delay at all', async () => {
  const { connector, sleepCalls, getSock } = buildThrottleConnector();
  await connector.start();
  await connector._handleConnectionUpdate({ connection: 'open' }); // first-ever open of this session

  await connector.sendTextMessage('6281234567890', 'hello');

  assert.equal(sleepCalls.length, 0, 'no reconnect-throttle sleep should ever be invoked for the first-ever connection of a session');
  assert.equal(getSock().sent.length, 1, 'the message must still be sent normally');
});

test('FR-1201: a genuine reconnect after a disconnect DOES throttle a send made shortly afterward', async () => {
  const { connector, sleepCalls, advanceTime } = buildThrottleConnector();
  await connector.start();
  await connector._handleConnectionUpdate({ connection: 'open' }); // first-ever connect -- not throttled
  await connector._handleConnectionUpdate(RECOVERABLE_CLOSE_EVENT); // genuine disconnect
  await connector._handleConnectionUpdate({ connection: 'open' }); // genuine RECONNECT -- starts the cooldown window

  advanceTime(1000); // 1s after the reconnect
  await connector.sendTextMessage('6281234567890', 'hi');

  assert.equal(sleepCalls.length, 1, 'a send within the cooldown window after a genuine reconnect must be throttled');
  assert.ok(sleepCalls[0] > 0, 'the extra delay must be a real, positive amount of ms');
});

test('FR-1201 (acceptance): immediately after reconnect (t=0) the extra delay is exactly baseDelayMs * (maxMultiplier - 1) using the documented defaults', async () => {
  const { connector, sleepCalls } = buildThrottleConnector();
  await connector.start();
  await connector._handleConnectionUpdate({ connection: 'open' });
  await connector._handleConnectionUpdate(RECOVERABLE_CLOSE_EVENT);
  await connector._handleConnectionUpdate({ connection: 'open' }); // reconnect at t=0, no advanceTime() call

  await connector.sendTextMessage('6281234567890', 'hi');

  // Defaults: reconnectThrottleBaseDelayMs=1000, maxMultiplier=3 -> 1000*(3-1) = 2000ms.
  assert.deepEqual(sleepCalls, [2000]);
});

test('FR-1201 (acceptance): a message sent 1 second after a reconnect is delayed noticeably longer than the same message sent 90 seconds after a reconnect', async () => {
  const { connector, sleepCalls, advanceTime } = buildThrottleConnector();
  await connector.start();
  await connector._handleConnectionUpdate({ connection: 'open' });
  await connector._handleConnectionUpdate(RECOVERABLE_CLOSE_EVENT);
  await connector._handleConnectionUpdate({ connection: 'open' }); // reconnect at t=0

  advanceTime(1000);
  await connector.sendTextMessage('a', 'sent 1s after reconnect');
  const delayAt1s = sleepCalls[0];

  advanceTime(89000); // now 90s after the reconnect
  await connector.sendTextMessage('a', 'sent 90s after reconnect');

  assert.equal(sleepCalls.length, 1, 'the 90s-later send must get zero extra delay -- past the cooldown window entirely');
  assert.ok(delayAt1s > 0, 'the 1s-later send must have been meaningfully delayed');
});

test('FR-1201: the throttle delay decays as the cooldown window elapses, and drops to no delay at all once it fully elapses', async () => {
  const { connector, sleepCalls, advanceTime } = buildThrottleConnector();
  await connector.start();
  await connector._handleConnectionUpdate({ connection: 'open' });
  await connector._handleConnectionUpdate(RECOVERABLE_CLOSE_EVENT);
  await connector._handleConnectionUpdate({ connection: 'open' }); // reconnect at t=0

  advanceTime(1000); // 1s in: near-max extra delay
  await connector.sendTextMessage('a', '1');
  advanceTime(58000); // 59s in: still inside the window, near-zero extra delay
  await connector.sendTextMessage('a', '2');
  advanceTime(31000); // 90s in: outside the window entirely
  await connector.sendTextMessage('a', '3');

  assert.equal(sleepCalls.length, 2, 'only the two sends still inside the 60s cooldown window get a recorded sleep call');
  assert.ok(sleepCalls[0] > sleepCalls[1], 'extra delay must shrink monotonically as more time passes since the reconnect');
});

test('FR-1201: a second genuine reconnect restarts the cooldown window from its own new reconnect time', async () => {
  const { connector, sleepCalls, advanceTime } = buildThrottleConnector();
  await connector.start();
  await connector._handleConnectionUpdate({ connection: 'open' }); // first-ever connect
  await connector._handleConnectionUpdate(RECOVERABLE_CLOSE_EVENT);
  await connector._handleConnectionUpdate({ connection: 'open' }); // reconnect #1 at t=0

  advanceTime(70000); // past reconnect #1's cooldown window entirely
  await connector._handleConnectionUpdate(RECOVERABLE_CLOSE_EVENT);
  await connector._handleConnectionUpdate({ connection: 'open' }); // reconnect #2 at t=70000

  await connector.sendTextMessage('a', 'right after reconnect #2');

  assert.equal(sleepCalls.length, 1, 'reconnect #2 must start its own fresh cooldown window, throttling this send even though reconnect #1\'s window had already fully elapsed');
});

test('FR-1203: reconnectThrottleWindowMs/reconnectThrottleMaxMultiplier/reconnectThrottleBaseDelayMs are configurable, not hardcoded', async () => {
  const { connector, sleepCalls, advanceTime } = buildThrottleConnector({
    connectorOverrides: {
      reconnectThrottleWindowMs: 10000,
      reconnectThrottleMaxMultiplier: 5,
      reconnectThrottleBaseDelayMs: 100,
    },
  });
  await connector.start();
  await connector._handleConnectionUpdate({ connection: 'open' });
  await connector._handleConnectionUpdate(RECOVERABLE_CLOSE_EVENT);
  await connector._handleConnectionUpdate({ connection: 'open' }); // reconnect at t=0

  await connector.sendTextMessage('a', 'immediately after reconnect');
  assert.deepEqual(sleepCalls, [400], 'custom config: baseDelayMs(100) * (maxMultiplier(5) - 1) = 400ms at t=0');

  advanceTime(10000); // exactly at the custom 10s window
  await connector.sendTextMessage('a', 'at the custom window mark');
  assert.equal(sleepCalls.length, 1, 'no additional sleep call once past the custom (shorter) cooldown window');
});

test('FR-1202 (judgment call): resetAndRestart() treats the next connection as a fresh session\'s first-ever connect, not a reconnect', async () => {
  const { connector, sleepCalls, advanceTime } = buildThrottleConnector();
  await connector.start();
  await connector._handleConnectionUpdate({ connection: 'open' }); // first-ever connect
  await connector._handleConnectionUpdate(RECOVERABLE_CLOSE_EVENT);
  await connector._handleConnectionUpdate({ connection: 'open' }); // genuine reconnect at t=0

  advanceTime(1000);
  await connector.sendTextMessage('a', 'throttled, mid-cooldown');
  assert.equal(sleepCalls.length, 1, 'sanity check: still inside the original cooldown window before resetAndRestart()');

  await connector.resetAndRestart(); // re-pair: wipes auth, starts a brand-new session
  await connector._handleConnectionUpdate({ connection: 'open' }); // this new session's first-ever connect

  await connector.sendTextMessage('a', 'right after re-pairing');

  assert.equal(sleepCalls.length, 1, 'the first connect of the NEW (re-paired) session must not be throttled, even though the old session was mid-cooldown');
});
