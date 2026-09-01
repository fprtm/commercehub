'use strict';

/**
 * Humanized Timing Module
 * ========================
 * Transport-agnostic orchestration for making an automated messaging flow
 * feel human-paced: mark the inbound message "read" immediately, pause
 * briefly, show a typing indicator, wait a duration proportional to the
 * outgoing reply's length at a realistic human typing speed (refreshing the
 * indicator periodically if that takes a while), then send.
 *
 * Zero WhatsApp-specific (or any transport-specific) imports, on purpose --
 * per Decision 002
 * (docs/sdd/decisions/002-reusable-humanized-timing-module.md) this file is
 * meant to be copyable wholesale into any other project that wants the same
 * "don't reply instantly, feel human" behavior. `markAsRead`,
 * `sendTypingIndicator` and `sendMessage` are plain callback functions
 * supplied by the caller -- this module only owns timing math and call
 * ordering, never how any of those three actually happen on the wire.
 *
 * See docs/sdd/changes/2026-09-01-humanized-timing-module.md (FR-601..FR-604)
 * and docs/sdd/decisions/001-realistic-timing-over-speed-budget.md for the
 * product reasoning behind fully-realistic (uncapped) timing over a fixed
 * reply-speed budget.
 */

// --- Typing-speed formula -------------------------------------------------
//
// There is no single "correct" typing-speed constant, so this is a
// documented, defensible choice rather than an arbitrary one:
//
//   - Average *mobile* (phone keyboard) typing speed for a typical adult is
//     commonly cited in the ~35-45 WPM range -- notably slower than
//     touch-typing on a physical keyboard. AVERAGE_WPM = 40 is the midpoint.
//   - WPM is conventionally measured using a standard "1 word = 5
//     characters" convention (regardless of the message's actual average
//     word length), so this reuses that convention to keep the constant
//     comparable to published WPM figures.
//   - 40 WPM * 5 chars/word = 200 chars/minute = 200 / 60 ~= 3.33 chars/sec,
//     i.e. ~300ms per character.
//
// That is intentionally NOT the "~150-250ms/char is way too slow for
// realism at scale" figure called out as a trap: 150-250ms/char implies
// 80-133 WPM, which is fast professional touch-typist speed, not average
// one/two-thumb phone typing. 300ms/char is the more realistic (if slower)
// number for "an ordinary person replying on their phone".
const AVERAGE_WPM = 40;
const CHARS_PER_WORD = 5;
const MS_PER_MINUTE = 60000;
const BASE_MS_PER_CHAR = MS_PER_MINUTE / (AVERAGE_WPM * CHARS_PER_WORD); // = 300

// A floor so a 1-2 character reply ("ok", "ya") doesn't compute to a
// near-zero typing duration -- which would look just as robotic/instant as
// no delay at all. A human still takes a beat to pick up the phone and tap
// even a couple of keys.
const MIN_TYPING_MS = 500;

// +/- jitter applied to the computed typing duration so two replies of the
// same length don't always take *exactly* the same time (another
// "obviously a bot" tell). 0.2 = up to +/-20% around the base duration.
const TYPING_JITTER_RATIO = 0.2;

// FR-601: short randomized "read" pause before the typing indicator appears,
// simulating the beat between a human noticing a notification and starting
// to type a reply. The read *receipt* itself (markAsRead) fires before this
// pause even starts -- see sendWithHumanizedTiming below.
const DEFAULT_READ_DELAY_RANGE_MS = [1000, 3000];

// FR-603 / Decision 001: Meta's Cloud API (and real WhatsApp clients, which
// Baileys mirrors) auto-dismiss a typing indicator after ~25s. Refreshing
// every 20s keeps a 5s safety margin so the indicator is always re-sent
// before it would visibly lapse mid-delay.
const DEFAULT_TYPING_REFRESH_INTERVAL_MS = 20000;

/** Real (non-test) sleep -- a thin Promise wrapper around setTimeout. This is
 * the only place in the module that touches a real timer; every caller can
 * override it (NFR-603) so tests never actually wait in real time. */
function realSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Picks a random value in [min, max] using an injectable `random` function
 * (defaults to Math.random) so tests can supply a deterministic function
 * (e.g. `() => 0.5`) and assert an exact resulting delay.
 */
function randomInRange(min, max, random) {
  return min + random() * (max - min);
}

/**
 * FR-601: computes how long a human would realistically take to type
 * `messageText` at ~40 WPM (see the formula notes above), with a bit of
 * jitter so it is not perfectly mechanical, and a floor so very short
 * messages still take a believable beat.
 *
 * Deterministic when `random` is fixed: `random: () => 0.5` yields a jitter
 * multiplier of exactly 1 (no deviation), so the result is exactly
 * `Math.max(MIN_TYPING_MS, messageText.length * (60000 / (wpm * 5)))` --
 * this is what the module's own tests assert against to prove the *formula*
 * itself, not just its general shape.
 *
 * @param {string} messageText
 * @param {object} [opts]
 * @param {number} [opts.wpm] - defaults to AVERAGE_WPM (40)
 * @param {number} [opts.jitterRatio] - defaults to TYPING_JITTER_RATIO (0.2)
 * @param {() => number} [opts.random] - injectable RNG, defaults to Math.random
 * @returns {number} duration in whole milliseconds
 */
function calculateTypingDurationMs(messageText, opts = {}) {
  const { wpm = AVERAGE_WPM, jitterRatio = TYPING_JITTER_RATIO, random = Math.random } = opts;
  const msPerChar = MS_PER_MINUTE / (wpm * CHARS_PER_WORD);
  const length = typeof messageText === 'string' ? messageText.length : 0;
  const base = Math.max(MIN_TYPING_MS, length * msPerChar);

  // jitterFactor === 1 (no deviation) when random() === 0.5 -- see doc above.
  const jitterFactor = 1 + (random() * 2 - 1) * jitterRatio;
  return Math.round(base * jitterFactor);
}

/**
 * FR-603: waits out `durationMs`, re-invoking `sendTypingIndicator` every
 * `refreshIntervalMs` for as long as time remains, so a long simulated
 * typing duration never lets the indicator visibly lapse before the message
 * is actually sent.
 *
 * A duration <= refreshIntervalMs never enters the loop -- the single
 * sendTypingIndicator() call the caller already made before this function
 * runs is enough on its own.
 */
async function waitOutTypingDuration({ durationMs, sendTypingIndicator, sleep, refreshIntervalMs }) {
  let remaining = durationMs;
  while (remaining > refreshIntervalMs) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: this *is* the delay
    await sleep(refreshIntervalMs);
    remaining -= refreshIntervalMs;
    // eslint-disable-next-line no-await-in-loop -- refresh must happen before the next wait chunk
    await sendTypingIndicator();
  }
  if (remaining > 0) {
    await sleep(remaining);
  }
}

/**
 * FR-601's full orchestration: mark the inbound message read, pause briefly,
 * show a typing indicator, wait a length-proportional realistic typing
 * duration (refreshing the indicator periodically per FR-603 if that
 * duration is long), then send the message.
 *
 * Transport-agnostic (FR-602/NFR-602): `markAsRead`, `sendTypingIndicator`
 * and `sendMessage` are plain callback functions supplied by the caller --
 * this module never imports or knows about WhatsApp, Baileys, HTTP, or any
 * other transport.
 *
 * @param {object} params
 * @param {string} params.messageText - the outgoing reply; its length drives
 *   the typing-duration calculation.
 * @param {() => Promise<unknown>} params.markAsRead
 * @param {() => Promise<unknown>} params.sendTypingIndicator
 * @param {(messageText: string) => Promise<unknown>} params.sendMessage
 * @param {(ms: number) => Promise<unknown>} [params.sleep] - injectable delay
 *   mechanism (NFR-603). Defaults to a real `setTimeout`-based sleep; tests
 *   should pass a fast/instant fake so the suite never actually waits in
 *   real time.
 * @param {() => number} [params.random] - injectable RNG (defaults to
 *   Math.random), for deterministic tests of the timing formula.
 * @param {[number, number]} [params.readDelayRangeMs]
 * @param {number} [params.typingRefreshIntervalMs]
 * @param {number} [params.wpm]
 * @returns {Promise<{ readDelayMs: number, typingDurationMs: number }>} the
 *   actual computed delays -- mainly useful for tests/observability.
 */
async function sendWithHumanizedTiming({
  messageText,
  markAsRead,
  sendTypingIndicator,
  sendMessage,
  sleep = realSleep,
  random = Math.random,
  readDelayRangeMs = DEFAULT_READ_DELAY_RANGE_MS,
  typingRefreshIntervalMs = DEFAULT_TYPING_REFRESH_INTERVAL_MS,
  wpm = AVERAGE_WPM,
}) {
  // FR-601: the read receipt fires immediately, before any delay -- this is
  // the early "they saw my message" signal Decision 001 relies on to
  // justify a slower substantive reply.
  await markAsRead();

  const readDelayMs = randomInRange(readDelayRangeMs[0], readDelayRangeMs[1], random);
  await sleep(readDelayMs);

  await sendTypingIndicator();

  const typingDurationMs = calculateTypingDurationMs(messageText, { wpm, random });
  await waitOutTypingDuration({
    durationMs: typingDurationMs,
    sendTypingIndicator,
    sleep,
    refreshIntervalMs: typingRefreshIntervalMs,
  });

  await sendMessage(messageText);

  return { readDelayMs, typingDurationMs };
}

module.exports = {
  sendWithHumanizedTiming,
  calculateTypingDurationMs,
  AVERAGE_WPM,
  CHARS_PER_WORD,
  BASE_MS_PER_CHAR,
  MIN_TYPING_MS,
  TYPING_JITTER_RATIO,
  DEFAULT_READ_DELAY_RANGE_MS,
  DEFAULT_TYPING_REFRESH_INTERVAL_MS,
};
