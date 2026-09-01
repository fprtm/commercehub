'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sendWithHumanizedTiming,
  calculateTypingDurationMs,
  AVERAGE_WPM,
  BASE_MS_PER_CHAR,
  MIN_TYPING_MS,
  DEFAULT_READ_DELAY_RANGE_MS,
  DEFAULT_TYPING_REFRESH_INTERVAL_MS,
} = require('../src/lib/humanizedTiming');

/**
 * FR-602/NFR-602: this whole file only requires
 * src/lib/humanizedTiming.js -- no metaClient.js, no baileysConnector.js, no
 * transport of any kind. That is itself part of the proof that the module
 * is transport-agnostic and reusable (Decision 002); see also the plain
 * `grep -n "require(" src/lib/humanizedTiming.js` check (no matches) used to
 * verify NFR-602 directly against the module's own source.
 *
 * NFR-603: every test below uses a fake `sleep` that resolves on the next
 * microtask (never a real timer) and records the requested delays instead
 * of actually waiting -- the whole suite proves the real formula/ordering
 * logic without spending real wall-clock time on it.
 */

function fakeSleepRecorder() {
  const calls = [];
  const sleep = async (ms) => {
    calls.push(ms);
  };
  return { sleep, calls };
}

function callOrderRecorder() {
  const order = [];
  return {
    order,
    markAsRead: async () => order.push('markAsRead'),
    sendTypingIndicator: async () => order.push('sendTypingIndicator'),
    sendMessage: async (text) => order.push(`sendMessage:${text}`),
  };
}

test('FR-601: calculateTypingDurationMs matches the documented ~40 WPM / 5-chars-per-word formula exactly when jitter is neutralized', () => {
  // random() => 0.5 makes the jitter factor exactly 1 (see the module's own
  // doc comment) -- this proves the *formula*, not just its rough shape.
  const text = 'a'.repeat(50); // 50 chars
  const duration = calculateTypingDurationMs(text, { random: () => 0.5 });

  const expected = Math.max(MIN_TYPING_MS, 50 * BASE_MS_PER_CHAR); // 50 * 300 = 15000
  assert.equal(BASE_MS_PER_CHAR, 300, 'sanity: 40 WPM * 5 chars/word => 300ms/char');
  assert.equal(duration, expected);
  assert.equal(duration, 15000);
});

test('FR-601: very short messages are floored at MIN_TYPING_MS instead of computing to a near-zero duration', () => {
  // 1 char * 300ms/char = 300ms, below the 500ms floor -- MIN_TYPING_MS
  // must win so a one-character reply doesn't look instant/robotic.
  const duration = calculateTypingDurationMs('k', { random: () => 0.5 });
  assert.equal(duration, MIN_TYPING_MS);
});

test('FR-601: typing duration jitter stays within the documented +/-20% band', () => {
  const text = 'a'.repeat(100); // base = 100 * 300 = 30000ms
  const base = 100 * BASE_MS_PER_CHAR;

  const atMin = calculateTypingDurationMs(text, { random: () => 0 }); // jitterFactor = 0.8
  const atMax = calculateTypingDurationMs(text, { random: () => 1 }); // jitterFactor = 1.2

  assert.equal(atMin, Math.round(base * 0.8));
  assert.equal(atMax, Math.round(base * 1.2));
});

test('FR-601: a custom wpm is honored by the formula (higher WPM => shorter duration)', () => {
  const text = 'a'.repeat(80);
  const at40wpm = calculateTypingDurationMs(text, { wpm: 40, random: () => 0.5 });
  const at80wpm = calculateTypingDurationMs(text, { wpm: 80, random: () => 0.5 });
  assert.equal(at80wpm, at40wpm / 2, 'doubling WPM should exactly halve the computed duration');
});

test('FR-601/FR-602: sendWithHumanizedTiming calls markAsRead, then sleeps, then sendTypingIndicator, then sleeps, then sendMessage -- in that exact order, no real waiting', async () => {
  const { sleep, calls } = fakeSleepRecorder();
  const { order, markAsRead, sendTypingIndicator, sendMessage } = callOrderRecorder();

  const start = Date.now();
  const result = await sendWithHumanizedTiming({
    messageText: 'hi there',
    markAsRead,
    sendTypingIndicator,
    sendMessage,
    sleep,
    random: () => 0.5,
  });
  const elapsedMs = Date.now() - start;

  assert.deepEqual(order, ['markAsRead', 'sendTypingIndicator', 'sendMessage:hi there']);
  assert.ok(elapsedMs < 200, `must not actually sleep in real time (took ${elapsedMs}ms)`);

  // With random() fixed at 0.5: readDelay is the exact midpoint of the
  // configured range, and typingDuration is the formula's exact result for
  // an 8-character message ('hi there'): 8 * 300ms/char = 2400ms (above the
  // 500ms floor, so the floor doesn't kick in here).
  const expectedReadDelay = (DEFAULT_READ_DELAY_RANGE_MS[0] + DEFAULT_READ_DELAY_RANGE_MS[1]) / 2;
  const expectedTypingDuration = 'hi there'.length * BASE_MS_PER_CHAR;
  assert.equal(result.readDelayMs, expectedReadDelay);
  assert.equal(result.typingDurationMs, expectedTypingDuration);
  assert.ok(expectedTypingDuration > MIN_TYPING_MS, 'sanity: this message is long enough that the floor is not what is being tested here');

  // Two sleeps were requested: the read-pause, then the typing-duration wait.
  assert.deepEqual(calls, [expectedReadDelay, expectedTypingDuration]);
});

test('FR-601: markAsRead fires before the read-delay sleep even starts (early "seen" signal, not delayed with the rest)', async () => {
  const { sleep } = fakeSleepRecorder();
  const events = [];
  await sendWithHumanizedTiming({
    messageText: 'ok',
    markAsRead: async () => events.push('read'),
    sendTypingIndicator: async () => events.push('typing'),
    sendMessage: async () => events.push('sent'),
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
    random: () => 0.5,
  });
  assert.equal(events[0], 'read', 'markAsRead must be the very first thing that happens');
});

test('FR-603: a typing duration under the ~20s refresh threshold sends the typing indicator exactly once (no refresh needed)', async () => {
  const { sleep, calls } = fakeSleepRecorder();
  let typingCalls = 0;

  await sendWithHumanizedTiming({
    messageText: 'a'.repeat(20), // 20 * 300 = 6000ms, well under the 20s threshold
    markAsRead: async () => {},
    sendTypingIndicator: async () => {
      typingCalls += 1;
    },
    sendMessage: async () => {},
    sleep,
    random: () => 0.5,
  });

  assert.equal(typingCalls, 1, 'only the initial typing-indicator call, no periodic refresh');
  assert.equal(calls.length, 2, 'exactly two waits: the read-pause and the (single) typing wait');
});

test('FR-603: a typing duration exceeding ~20s re-sends the typing indicator periodically until the message is sent', async () => {
  const { sleep, calls } = fakeSleepRecorder();
  const typingCallTimestamps = [];
  let typingCalls = 0;

  // 150 chars * 300ms/char = 45000ms of typing -- well past the 20s/25s
  // Meta auto-dismiss window this FR exists to work around.
  const text = 'a'.repeat(150);

  const result = await sendWithHumanizedTiming({
    messageText: text,
    markAsRead: async () => {},
    sendTypingIndicator: async () => {
      typingCalls += 1;
      typingCallTimestamps.push(typingCalls);
    },
    sendMessage: async () => {},
    sleep,
    random: () => 0.5, // no jitter => exactly 45000ms
  });

  assert.equal(result.typingDurationMs, 45000);
  // 1 initial call (before the wait loop) + 2 refreshes at the 20s marks
  // (at 20000ms and 40000ms elapsed), then a final short wait for the
  // remaining 5000ms -- 3 sendTypingIndicator calls total, not just 1.
  assert.equal(typingCalls, 3, 'expected 1 initial + 2 periodic refreshes for a 45s typing duration');

  // Sleep chunks: read-delay, then 20000, 20000, 5000 for the typing wait.
  const [, ...typingWaitChunks] = calls;
  assert.deepEqual(typingWaitChunks, [
    DEFAULT_TYPING_REFRESH_INTERVAL_MS,
    DEFAULT_TYPING_REFRESH_INTERVAL_MS,
    5000,
  ]);
});

test('FR-601: the message actually sent is exactly the messageText passed in, unchanged', async () => {
  const { sleep } = fakeSleepRecorder();
  let sentWith = null;
  await sendWithHumanizedTiming({
    messageText: 'Which product are you interested in?',
    markAsRead: async () => {},
    sendTypingIndicator: async () => {},
    sendMessage: async (text) => {
      sentWith = text;
    },
    sleep,
    random: () => 0.5,
  });
  assert.equal(sentWith, 'Which product are you interested in?');
});

test('sanity: AVERAGE_WPM is within the 35-45 WPM range the change spec calls for', () => {
  assert.ok(AVERAGE_WPM >= 35 && AVERAGE_WPM <= 45);
});
