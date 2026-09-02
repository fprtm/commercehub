# @rimba/whatsapp-connector

Dual-mode WhatsApp connectivity: the official Cloud API (`createMetaClient`,
a push-webhook model) and Baileys (`createBaileysConnector`, an unofficial
persistent-socket model), exposing the same three-function outbound contract
regardless of mode:

```js
sendTextMessage(phoneNumber, text)              // -> Promise
markAsRead(phoneNumber, messageId)               // -> Promise, never throws
sendTypingIndicator(phoneNumber, messageId)       // -> Promise, never throws
```

See `src/index.js`'s header comment for the fuller "why these two modes
deliberately differ" reasoning, and the consuming app's README
(`apps/whatsapp-lead-capture/README.md`, "Dual WhatsApp mode" section) for
the end-to-end picture, including the general Baileys ban-risk disclosure.
This README covers only what's specific to this package.

## Reconnect throttle (Baileys only) — FR-1201..FR-1203

**What it does:** after the Baileys connection re-establishes following a
genuine disconnect (not the first connection of a fresh session), outbound
sends made in the following 60 seconds get extra pre-send delay on top of
whatever `@rimba/humanized-timing` already applied — a lot of extra delay
immediately after the reconnect, linearly easing back down to none by the
60-second mark. The very first connection of a session is never throttled.

**Why:** a real test WhatsApp number was temporarily restricted after
repeated rapid connect/disconnect cycles during dev-server testing.
Research at the time (WhiskeySockets/Baileys issues #2110/#1869, several
2026 anti-ban writeups) indicated frequent reconnects/re-pairs are an
independent, documented ban-risk factor — separate from message
content/volume, which this app already doesn't do anything unusual with.
The documented mitigation is exactly what's implemented here: don't resume
sending at full speed the instant a reconnect succeeds; ease back into it
like a human resuming a conversation would, over roughly a minute. See
`docs/sdd/changes/2026-09-02-reconnect-throttle.md` for the full spec.

**Where it lives (`src/baileysConnector.js`):**

- `calculateReconnectThrottleMultiplier(msSinceReconnect, options)` — the
  pure ramp function (NFR-1202). Given how long it's been since a genuine
  reconnect, returns the extra-delay multiplier: `maxMultiplier` (default
  3x) at `msSinceReconnect = 0`, decreasing linearly to `1` (no extra delay)
  at `msSinceReconnect = windowMs` (default 60000), then holding at `1`
  after that. `null`/`undefined` (no genuine reconnect has happened this
  session) always returns `1`. Exported from this package (and re-exported
  from `src/index.js`) so it can be unit-tested directly against exact time
  values — no clocks, timers, or connector state involved.
- The connector tracks, in its own internal state, whether the socket has
  ever reached `'open'` before (`hasConnectedOnce`) and, if so, the
  timestamp of the most recent `'open'` that followed a disconnect
  (`lastReconnectAt`, via an injectable `now()`, defaulting to `Date.now`).
  A second (or later) `'open'` event in a session is, by construction, a
  genuine reconnect — Baileys only fires `'open'` after establishing a
  connection, so a repeat `'open'` necessarily followed a prior `'close'`.
  `resetAndRestart()` (used for re-pairing after a non-recoverable
  disconnect) resets this tracking, since a fresh QR pairing is a new
  session, not a reconnect of the old one.
- `sendTextMessage` calls a small `applyReconnectThrottleDelay()` helper
  before `sock.sendMessage(...)`, which computes the multiplier and (if
  greater than 1) sleeps `reconnectThrottleBaseDelayMs * (multiplier - 1)`
  ms via an injectable `sleep`, defaulting to a real `setTimeout`-based
  sleep. This is *additional* delay on top of, never instead of, whatever
  `@rimba/humanized-timing`'s `sendWithHumanizedTiming` already applied
  upstream (in `apps/whatsapp-lead-capture/src/services/
  inboundMessageProcessor.js`) — this package doesn't reach into or
  duplicate that module's own delay logic; it only adds its own pre-send
  delay at the one point it actually owns, the call to the real socket.

**Configuration (FR-1203)** — constructor options to `createBaileysConnector`,
all with sane defaults, none hardcoded inline in the logic:

| Option | Default | Meaning |
|---|---|---|
| `reconnectThrottleWindowMs` | `60000` (60s) | How long after a genuine reconnect the throttle applies. |
| `reconnectThrottleMaxMultiplier` | `3` | Extra-delay multiplier immediately after a reconnect. |
| `reconnectThrottleBaseDelayMs` | `1000` | The ms unit the multiplier scales (`extraDelayMs = base * (multiplier - 1)`). |
| `now` | `() => Date.now()` | Injectable clock, for deterministic tests. |
| `sleep` | real `setTimeout`-based | Injectable delay mechanism, for deterministic tests. |

**Honest framing — reduces this risk, does not eliminate it.** Same
disclosure pattern as everything else Baileys-related in this project (see
`apps/whatsapp-lead-capture/README.md`'s "Dual WhatsApp mode" section): this
is a commonly-cited, plausible mitigation for one specific, documented
ban-risk factor (reconnect frequency/burstiness), not a fix for Baileys
being an unofficial, reverse-engineered protocol implementation in the
first place. It does nothing for the *other* independent risk factors
already disclosed elsewhere (message volume/content, account age, overall
"looks like a bot" fingerprint) — rate-limiting total message throughput is
explicitly out of scope for this change (a different, volume-based risk,
not what triggered the incident this responds to). Treat a number used in
`baileys` mode as one you're willing to lose, regardless of this throttle
being in place.

## Cloud API (`createMetaClient`) — no equivalent throttle, on purpose

Cloud API is a stateless push-webhook model: WhatsApp POSTs to the app's own
`/webhook` route on each inbound message, and every outbound send is an
independent, one-shot HTTPS call — there is no persistent connection, no
`'open'`/`'close'` lifecycle, and therefore no "reconnect" event for
anything to throttle around. `src/metaClient.js` has no reconnect-throttle
logic and none was added — this is a structural difference between the two
transports, not an oversight (see `src/index.js`'s header comment for the
fuller "where the two modes deliberately differ, and why" reasoning).

## Testing

```bash
npm test
```

Runs `node --test` against `test/`. No real Baileys connection, real Meta
API call, or real WhatsApp account is used anywhere — `test/baileysConnector.test.js`
drives a fake `sock`/event emitter and injects fake `now`/`sleep`/
`scheduleReconnect` functions so reconnect-attempt backoff, reconnect-success
detection, and the reconnect-throttle ramp are all deterministic and
instant, never dependent on real timers; `test/metaClient.test.js` injects a
fake `fetch`.
