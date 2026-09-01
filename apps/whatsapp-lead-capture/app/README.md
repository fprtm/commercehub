# WhatsApp Lead Capture & Auto-Responder (Rimba Apparel — portfolio demo)

A small Node.js/Express service that receives inbound WhatsApp messages, runs
a 2-question qualifying flow, logs every inquiry as a Lead in SQLite, and
gives the business owner a simple server-rendered dashboard to review and
follow up on leads. It supports **two interchangeable WhatsApp connector
modes**, chosen via one env var at boot — see "Dual WhatsApp mode" below:

- **`cloud_api`** (default, recommended) — Meta's official WhatsApp Cloud API
  webhook.
- **`baileys`** — an unofficial, reverse-engineered connection via
  [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys),
  paired by scanning a QR code, no Meta account needed. **Carries a real
  ban risk — read the disclosure below before using it.**

This is a portfolio demo built against a simulated client ("Rimba Apparel",
fictional). See the spec docs this was built from:
- `../business-simulation.md`
- `../docs/sdd/changes/2026-09-01-whatsapp-lead-capture.md`
- `../docs/sdd/changes/2026-09-01-baileys-dual-mode.md` (dual-mode extension)
- `../docs/sdd/changes/2026-09-01-auto-reply-toggle.md` (auto-reply ON/OFF toggle)
- `../docs/sdd/changes/2026-09-01-humanized-timing-module.md` (humanized response timing, retires NFR-001)
- `../docs/sdd/decisions/001-realistic-timing-over-speed-budget.md`
- `../docs/sdd/decisions/002-reusable-humanized-timing-module.md`
- `../docs/sdd/design/technical-design.md`
- `../docs/sdd/tasks/tasks.md`

## Important: no live Meta credentials in this build

This build was implemented and tested **without a real Meta WhatsApp
Business API account**. The Meta Graph API client (`src/services/metaClient.js`)
is written against the real API contract and would work against a real
WhatsApp Business number, but it has only been exercised against a **mocked**
Meta client in the test suite (`tests/helpers/testApp.js`). A live
round-trip test against a real WhatsApp number/Meta test account was **not
possible in this environment** and remains a manual verification gap before
any real client demo — see "Manual verification still needed" below.

## Requirements

- Node.js 18+ (developed and tested on Node 24)
- npm

## Setup

```bash
cd app
npm install
cp .env.example .env
# edit .env with real values (see table below)
npm run migrate   # creates the SQLite file and applies the schema
npm start         # starts the server (default http://localhost:3000)
```

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Port the server listens on (default 3000). |
| `WHATSAPP_MODE` | `cloud_api` (default) or `baileys` — selects the connector at boot (FR-301). Not switchable at runtime; changing it requires a restart. See "Dual WhatsApp mode" below. |
| `WHATSAPP_VERIFY_TOKEN` | *(cloud_api mode only)* Arbitrary string you choose and enter into the Meta App dashboard's webhook config screen; used for the `GET /webhook` verification handshake. |
| `WHATSAPP_ACCESS_TOKEN` | *(cloud_api mode only)* System user access token from the Meta App dashboard; Bearer-auth for outbound Graph API calls. |
| `WHATSAPP_PHONE_NUMBER_ID` | *(cloud_api mode only)* The "Phone Number ID" (not the phone number) from the Meta App dashboard's WhatsApp > API Setup screen. |
| `WHATSAPP_APP_SECRET` | *(cloud_api mode only, required in that mode)* — App Secret from the Meta App dashboard, used to verify the `X-Hub-Signature-256` header on inbound webhook requests. **Not in the original task brief's env var list** — added because the technical design (Phase L / Data Flow) explicitly requires signature verification; see "Judgment calls" below. The server (`src/server.js`) refuses to start without it in cloud_api mode, so signature verification is never silently optional in a deployed build. (The underlying `createApp()` factory still accepts an unset `appSecret` for tests that construct the app directly without going through `server.js`.) |
| `BAILEYS_AUTH_DIR` | *(baileys mode only)* Folder for the paired-session credentials (default `./data/baileys-auth`). Local/gitignored — see "Dual WhatsApp mode" below. |
| `SESSION_SECRET` | Secret used to sign the dashboard's session cookie. |
| `OWNER_USERNAME` / `OWNER_PASSWORD` | Single-owner dashboard login credentials (no user table — see technical design's Authentication Strategy). |
| `DATABASE_PATH` | Path to the SQLite file (default `./data/leads.db`). |

## Running the tests

```bash
npm test
```

Runs Node's built-in test runner (`node --test`, no extra test framework
dependency) against everything in `tests/`. All tests run against an
**in-memory SQLite database** and a **mocked Meta client / a fake Baileys
socket** — nothing touches a real network, a real Meta account, or a real
WhatsApp number/QR scan anywhere in the suite.

Current result: **128 passed, 0 failed** — 100 pre-existing **plus 28 added
for the humanized-timing module and its post-review fixes**:
- `tests/humanizedTiming.test.js` — 10 tests exercising the module in
  isolation with mocked callbacks and a fake `sleep`, no real waiting.
- `tests/baileysConnector.test.js` — 7 new tests for its `markAsRead`/
  `sendTypingIndicator` primitives, plus 1 more for `messageId` threading.
- `tests/metaClient.test.js` — 9 new tests for `markAsRead`/
  `sendTypingIndicator` against a fake `fetchImpl` (request shape, the
  "no messageId ⇒ no-op" guard, and the "never throws" contract) — added on
  independent review, since the `readReceipts`/`typingIndicators` spies
  already wired into `tests/helpers/testApp.js` were not actually being
  asserted against anywhere for the Cloud API path (the recommended default
  mode).
- `tests/webhook.test.js` — 1 new integration test asserting
  `ctx.metaClient.readReceipts`/`typingIndicators` actually get populated
  over the real `POST /webhook` route (not just `metaClient.js` in
  isolation), proving the wiring in `webhook.js` itself.
- `tests/inboundMessageProcessor.test.js` — 1 new test proving `markAsRead`
  fires for a new inbound message even when it produces zero scripted
  replies (see "markAsRead does not depend on there being a reply" below —
  a gap fixed on the same review).

None of the 100 pre-existing tests had their assertions on final message
*content* or Lead/state-machine outcomes changed; the few that needed
touching only had a `sleep` (an instant fake) or new mock methods
(`markAsRead`/`sendTypingIndicator`) added to their setup, so the whole
suite stays fast (~13s total — the humanized-timing delays are never
actually slept through in tests; see "Humanized response timing" below for
how):
- `tests/inboundMessageProcessor.test.js` and `tests/autoReplyToggle.test.js`
  — added `sleep: async () => {}` to their direct
  `createInboundMessageProcessor(...)` calls (otherwise every reply in
  those tests would incur a real 1-3s+ delay).
- `tests/baileysConnector.test.js` — no change to any pre-existing
  assertion; only new, additive tests (see above).
- `tests/helpers/testApp.js` — `createMockMetaClient()` gained
  `markAsRead`/`sendTypingIndicator` spies (`readReceipts`/
  `typingIndicators`), and `startTestServer()` now passes a fast default
  `sleep` into `createApp()`, so every `webhook.test.js`/
  `autoReplyToggle.test.js` HTTP-level test needed **zero** per-test
  changes.

Prior to this change: **100 passed, 0 failed** — 87 pre-existing (the
original 61 plus 20 added for the Baileys dual-mode extension, plus 6 more
from other small fixes along the way; see the BUILD report and
`2026-09-01-baileys-dual-mode.md` for that history) **plus 13 added for the
auto-reply ON/OFF toggle** (`tests/settingsRepo.test.js`,
`tests/autoReplyToggle.test.js`). All 87 pre-existing tests still passed
**unmodified** at that point — the toggle change added two new files
(`src/services/settingsRepo.js`, `src/routes/settings.js`) and a handful of
additive, default-preserving parameters (`settingsRepo` on
`inboundMessageProcessor.js` and `leads.js`), same pattern the dual-mode
change already used; it did not edit any existing test.

## Pausing auto-reply (FR-401..FR-403)

The owner can turn the automated WhatsApp flow on/off without editing an env
var or restarting the server, via a toggle at the top of the Lead dashboard
(`/leads`): see `docs/sdd/changes/2026-09-01-auto-reply-toggle.md`.

- **ON (default)** — unchanged behavior: every inbound message drives the
  qualifying-question flow and sends replies exactly as before.
- **OFF** — inbound messages still create/update a Lead row (the data
  pipeline never goes quiet), but no outbound reply (acknowledgment,
  question, retry, or fallback) is sent. The bot goes quiet, not the data.
  Turning it back ON later does **not** retroactively message anyone who
  wrote in while it was off — there's no queue of "unsent" replies, only a
  state flip; a genuinely new message after re-enabling is handled normally.

The setting lives in a new single-row `app_settings` table and is read
fresh from SQLite on every single inbound message and every dashboard page
load (no caching layer) — see `src/services/settingsRepo.js` and the
`settingsRepo` dependency threaded into
`src/services/inboundMessageProcessor.js` (the one shared function both the
Cloud API webhook route and the Baileys connector call into, so the toggle
applies identically to both connector modes with zero mode-specific code).

## Humanized response timing (FR-601..FR-604) — and the honest trade-off

**Replies are no longer sent instantly.** As of
`docs/sdd/changes/2026-09-01-humanized-timing-module.md`, every automated
reply (acknowledgment, question, retry, or fallback) is deliberately delayed
and paced to feel like a human typing on their phone, not a bot firing back
in milliseconds:

1. The instant a message arrives, the app sends a WhatsApp **read receipt**
   (blue check marks) — this is the customer's early "they saw my message"
   signal.
2. A short randomized pause (1–3s), simulating the beat before a human
   starts typing.
3. A **typing indicator** appears.
4. The app waits a duration proportional to the outgoing reply's length, at
   a realistic ~40 WPM mobile-typing pace (see the formula below) — for a
   long reply this can be many seconds, deliberately.
5. The message is sent.

For a multi-message batch (e.g. the acknowledgment + question 1 sent
together on first contact), the read receipt only fires once — there is
only one inbound message to mark read — but each message in the batch still
gets its own full typing-indicator-and-delay treatment, since a human would
genuinely take a fresh beat to type each one.

**markAsRead does not depend on there being a reply.** Post-review fix: the
read receipt fires for *every* new inbound message while auto-reply is ON,
even when the state machine produces zero scripted replies — e.g. a message
after the flow is already complete, after fallback was already triggered,
on an already-responded/closed lead, or answering Q2 with no
`completionMessage` configured. Decision 001 frames the read receipt purely
as "the customer gets an early signal their message was received", which
doesn't logically depend on whether a reply follows — so it was decoupled
from `decision.replies` being non-empty (see the comment in
`src/services/inboundMessageProcessor.js`, and
`tests/inboundMessageProcessor.test.js`'s "markAsRead still fires... even
when decision.replies is empty" test). This is still gated on the
auto-reply toggle (FR-401..FR-403) being ON — while it's OFF the bot stays
fully quiet, including no read receipts, since there is no delay to
mitigate at all in that state.

### The retired 5-second budget (Decision 001)

The original spec's NFR-001 required a reply within 5 seconds. **That
requirement is retired in its original form** — see
`docs/sdd/decisions/001-realistic-timing-over-speed-budget.md`. Fully
realistic typing simulation can legitimately take 15–30+ seconds for a
longer reply, well past 5 seconds. This was a deliberate trade-off, not an
oversight:

- **Why:** an instant, uniformly-timed auto-reply is a visible "this is a
  bot" tell — a UX rough edge in general, and, in **Baileys mode**
  specifically, a contributing factor to spam/ban-detection risk (see
  "Dual WhatsApp mode" below).
- **Mitigation:** the read receipt (step 1 above) still gives the customer
  an immediate "they saw it" signal, even though the substantive text reply
  now genuinely takes longer.
- **Applies uniformly to both connector modes** (Cloud API and Baileys),
  even though only Baileys carries the ban-risk motivation — one shared
  module, not mode-specific timing, was an intentional simplification (see
  `docs/sdd/decisions/002-reusable-humanized-timing-module.md`).
- **A prospective client must be told plainly** that responses are
  intentionally paced to look human, not instant, before this ships to
  them. This is not hidden or silently applied.

### The typing-speed formula

Implemented in `src/lib/humanizedTiming.js`
(`calculateTypingDurationMs`) — reasoning is documented directly in that
file's comments, summarized here:

- **~40 WPM** (midpoint of a realistic 35–45 WPM range for average *mobile*
  typing — notably slower than physical-keyboard touch-typing).
- The standard **5 characters per word** typing-speed convention, so the
  constant stays comparable to published WPM figures.
- `40 WPM × 5 chars/word = 200 chars/minute ≈ 300ms per character`. This is
  intentionally **not** the ~150–250ms/char figure that would look
  realistic at first glance but is actually closer to 80–133 WPM — fast
  professional touch-typist speed, not an average person thumb-typing a
  reply.
- A **500ms floor** so a 1-2 character reply ("ok") doesn't compute to a
  near-instant (robotic-looking) duration.
- **±20% random jitter** so replies of the same length don't all take
  *exactly* the same time.

### Typing-indicator refresh (FR-603)

Meta's Cloud API (and real WhatsApp clients, which Baileys mirrors)
auto-dismiss a typing indicator after ~25 seconds. For any simulated typing
duration longer than that, `src/lib/humanizedTiming.js` re-sends the typing
indicator every ~20 seconds (a 5s safety margin) until the message actually
goes out, so the indicator never visibly disappears mid-delay.

### Built as a standalone, reusable module (Decision 002)

`src/lib/humanizedTiming.js` has **zero import-time dependency on anything
WhatsApp-specific** — it accepts three plain callback functions
(`markAsRead`, `sendTypingIndicator`, `sendMessage`) and owns only the
timing math and call ordering. Verified directly: `grep -n "require("
src/lib/humanizedTiming.js` returns no matches at all. Its own test suite
(`tests/humanizedTiming.test.js`) requires only that one file — no
`metaClient.js`, no `baileysConnector.js` — proving it is reusable as-is by
a future project (e.g. Project 2/3 or the AI-automation offer) that wants
the same "don't reply instantly, feel human" behavior, by copying just this
one file.

`src/services/metaClient.js` and `src/services/baileysConnector.js` each
expose thin, connector-specific `markAsRead(phoneNumber, messageId)` /
`sendTypingIndicator(phoneNumber, messageId)` primitives (Meta: a Graph API
status-update call; Baileys: `sock.readMessages` / a `composing` presence
update). `src/services/inboundMessageProcessor.js` — the one shared
reply-send loop both connector modes already route through — binds those
connector-specific primitives into the generic callbacks
`src/lib/humanizedTiming.js` expects, so the module itself never has to
know which connector it's running under.

### Keeping tests fast and deterministic (NFR-603)

Real per-message delays (1-3s read pause + a length-proportional typing
wait) would make the test suite painfully slow and non-deterministic if
actually slept through. Instead:

- `sendWithHumanizedTiming(...)` accepts an injectable `sleep` function
  (default: a real `setTimeout`-based sleep) and an injectable `random`
  function (default: `Math.random`).
- `tests/humanizedTiming.test.js` passes a fake `sleep` that resolves
  immediately (recording the requested delay instead of waiting) and a
  fixed `random: () => 0.5`, so it can assert **exact** computed delays
  (proving the real formula) and exact callback call **order/count**
  (proving the real orchestration and the FR-603 refresh behavior) —
  without spending real wall-clock time on any of it. The full 10-test file
  runs in well under 100ms.
- Every other test that exercises a reply path (`webhook.test.js`,
  `autoReplyToggle.test.js`, `inboundMessageProcessor.test.js`) also injects
  a fast/instant `sleep` — see "Running the tests" above for exactly where.

## Configuring the qualifying questions (NFR-005)

Edit `config/questions.json` — no code change required:

```json
{
  "businessName": "Rimba Apparel",
  "acknowledgment": "This is an automated reply from Rimba Apparel. ...",
  "questions": [
    { "id": "q1", "text": "Which product are you interested in?" },
    { "id": "q2", "text": "What size are you looking for, or how would you prefer we contact you?" }
  ],
  "fallbackMessage": "Thanks for your message — a team member will follow up with you shortly.",
  "completionMessage": "Thanks! We've got what we need — a team member will follow up with you shortly."
}
```

The file must define exactly 2 questions (per FR-002's "up to 2 sequential
qualifying questions") and is re-read on every server start.

## Dual WhatsApp mode: Cloud API vs. Baileys

This app can talk to WhatsApp two ways, picked once at boot via
`WHATSAPP_MODE` (FR-301). Both modes drive the exact same qualifying-question
state machine, Lead repo, and dashboard underneath — see
`docs/sdd/changes/2026-09-01-baileys-dual-mode.md` for the full design. The
only mode-specific code is the two connector adapters
(`src/services/metaClient.js` and `src/services/baileysConnector.js`) plus
the two thin routes that call into the shared
`src/services/inboundMessageProcessor.js`.

### `cloud_api` (default, recommended)

Meta's official WhatsApp Cloud API. Requires a Meta Business/App Developer
account, WhatsApp Business verification, and (per-conversation) cost. In
exchange: it's the sanctioned, supported way to integrate — no risk of the
number being banned or rate-limited by WhatsApp for using it. Setup: see
"Setup" above and the "Environment variables" table.

### `baileys` — read this before you turn it on

**Baileys connects using an unofficial, reverse-engineered implementation of
WhatsApp's own multi-device protocol — not Meta's Cloud API.** WhatsApp does
not support, sanction, or provide any guarantee about third-party clients
that connect this way.

**The honest trade-off (NFR-303 — stated here, and on the in-app pairing
screen at `/whatsapp/pair`, every time Baileys mode is active, not just in
this README):**

- **Zero setup friction, zero per-message cost.** No Meta Business
  verification, no App review, no billing. Pair by scanning a QR code and
  it works.
- **Real ban risk.** The WhatsApp number used carries a genuine risk of
  being banned or rate-limited, even for this app's actual usage pattern
  (reply-only to inbound messages, not broadcast/bulk sending) — that
  pattern is lower-risk than mass-messaging, but it is **not zero risk**.
  Use a number the business owner is willing to lose — **never** a
  personal/primary WhatsApp number — and treat this as a deliberately
  lower-cost, higher-risk tier compared to `cloud_api`, not a drop-in
  equivalent.
- This app cannot and does not eliminate that risk; it only makes the
  connection itself as stable as possible (see below) and makes the risk
  visible rather than hiding it.

**Setup (FR-303):**

```bash
# in .env
WHATSAPP_MODE=baileys
# WHATSAPP_VERIFY_TOKEN / WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID /
# WHATSAPP_APP_SECRET are NOT needed in this mode.

npm start
# log in to the dashboard (OWNER_USERNAME / OWNER_PASSWORD), then open:
#   http://localhost:3000/whatsapp/pair
# scan the QR code with the WhatsApp account to link: phone > Settings >
# Linked Devices > Link a Device.
```

The paired session is written to `BAILEYS_AUTH_DIR` (default
`./data/baileys-auth/`) — a local, **gitignored** folder, not the SQLite
database, matching how this project already treats `data/` as
local/ephemeral. Once paired, restarting the app does **not** require
re-scanning.

**Stability (FR-304, FR-305, NFR-301 — the explicit top priority for this
mode):**

- Ordinary disconnects (network blips, WhatsApp-side restarts) trigger an
  automatic reconnect with **exponential backoff** (1s, 2s, 4s, ... capped
  at 60s) — never an immediate retry loop, never a manual restart.
- A **logged-out** session (owner removed the device from WhatsApp's Linked
  Devices list on their phone) is treated as **non-recoverable on purpose**:
  retrying it can't succeed, so the app does *not* keep retrying. Instead it
  logs a `FailedEvent` (`channel=whatsapp_baileys`) and the `/whatsapp/pair`
  screen shows a "Reconnect needed" state with a button to generate a fresh
  QR code — never a bot that's silently, permanently dead with no
  indication why.
- Both behaviors are covered by tests that simulate Baileys'
  `connection.update` event directly (`tests/baileysConnector.test.js`) —
  see "Running the tests" above; no real Baileys connection or WhatsApp
  account is used anywhere in the suite (not possible in this environment —
  there is no phone available to scan a real QR code).

## Project layout

```
app/
  config/questions.json       qualifying-question script (NFR-005)
  src/
    app.js                    Express app factory (dependency-injected: db, connectors, config, mode)
    server.js                 real entrypoint: wires env vars, real DB, mode-selected connector
    db/
      schema.sql               Lead + FailedEvent + app_settings schema (+ FailedEvent.channel for
                                FR-305; + app_settings single-row table for the auto-reply toggle)
      index.js                 DB factory (createDb) — used by server.js and tests alike
      migrate.js                standalone `npm run migrate` script
    lib/
      humanizedTiming.js        FR-601..FR-604: standalone, transport-agnostic humanized-timing
                                 module (read-delay + typing-simulation + FR-603 typing-indicator
                                 refresh) -- zero WhatsApp-specific imports, reusable by future
                                 projects (Decision 002)
    services/
      stateMachine.js          T-005: qualifying-question state machine (core business logic, UNCHANGED)
      inboundMessageProcessor.js  FR-302: shared processInboundMessage() -- the one place both
                                   connectors call into the state machine/Lead repo from (now also
                                   reads settingsRepo fresh on every call to gate the send loop --
                                   auto-reply toggle change; and now routes every reply through
                                   lib/humanizedTiming.js instead of sending immediately -- FR-604)
      metaClient.js             Meta Graph API client (real interface, mocked in tests); now also
                                 exposes markAsRead/sendTypingIndicator (FR-601/FR-604)
      baileysConnector.js       Baileys adapter: connection lifecycle, reconnect/backoff (FR-304),
                                 logged-out detection (FR-305), QR pairing (FR-303); now also
                                 exposes markAsRead/sendTypingIndicator (FR-601/FR-604)
      parseWebhookPayload.js    extracts normalized messages from a raw Meta payload (now also the
                                 message id/WAMID, threaded through for markAsRead -- FR-601)
      questionsLoader.js        loads/validates config/questions.json
      leadsRepo.js               Lead table data access (UNCHANGED)
      failedEventsRepo.js        FailedEvent table data access (+ channel param, for FR-305)
      settingsRepo.js            app_settings table data access (auto-reply toggle change)
    routes/
      webhook.js                GET/POST /webhook (Meta-facing; now a thin adapter onto
                                 inboundMessageProcessor.js)
      auth.js                    GET/POST /login, POST /logout
      leads.js                   GET /leads, POST /leads/:id/status (now also reads settingsRepo to
                                  render the auto-reply toggle's current state)
      settings.js                POST /settings/auto-reply — toggles auto_reply_enabled (auto-reply
                                  toggle change)
      whatsappPair.js            GET /whatsapp/pair, POST /whatsapp/pair/reset (FR-303/FR-305)
      health.js                  GET /health
    middleware/requireAuth.js   session gate for the dashboard (reused by whatsappPair.js and
                                 settings.js)
    utils/
      signature.js               X-Hub-Signature-256 verification
      logger.js                  structured console logging
    views/
      login.ejs                 server-rendered dashboard (EJS, no SPA — TD-003) -- UNCHANGED
      leads.ejs                 server-rendered dashboard; now also shows the auto-reply ON/OFF
                                 toggle at the top (auto-reply toggle change)
      whatsappPair.ejs           pairing screen: QR / connected / reconnect-needed states,
                                  ban-risk disclosure (NFR-303)
  tests/                        node:test unit + integration tests (see below)
  data/                         SQLite file + Baileys paired-session folder live here at
                                 runtime (both gitignored)
```

## Post-build review fixes

An independent review after the initial BUILD pass found 2 Major + 2 Minor
issues, all now fixed:

1. **Signature verification fail-open** — `WHATSAPP_APP_SECRET` is now in
   `src/server.js`'s `REQUIRED_ENV_VARS`; the server refuses to boot
   without it, so `POST /webhook` signature verification is never silently
   skipped in a deployed build.
2. **FR-007 spec text vs. code mismatch** — the changes file's FR-007
   acceptance criterion named "an unrelated question" as an example
   fallback trigger, which contradicted the (correct, deliberate)
   structural-only interpretation actually implemented. The spec text
   itself was corrected — see
   `docs/sdd/changes/2026-09-01-whatsapp-lead-capture.md`.
3. **FR-002's one-retry-before-fallback was missing** — the state machine
   now retries once (re-sending the same pending question with a "didn't
   quite catch that" prefix) before falling back on a second unusable
   message in a row. This required adding a `retry_count` column to the
   `leads` table (not in the original Phase K table — see the comment in
   `src/db/schema.sql`), since the state machine is a pure function driven
   entirely by the persisted Lead row and needs somewhere to remember
   "has this question's one retry already been used."
4. **Closed-lead lifecycle gap** — `closed` is now enforced as a terminal
   status: `leadsRepo.updateStatus` rejects any change to a lead whose
   current status is already `closed` (same 400 path as an invalid status
   value), and the dashboard no longer renders "Mark responded"/"Mark
   closed" buttons for a closed lead.

Not changed (flagged as Minor/Nit in review, left as-is): the Meta API
client (`src/services/metaClient.js`) has no request timeout, and
`better-sqlite3`'s native install script isn't allow-listed for automated
`npm install` in restricted-script environments (see the BUILD report for
how this was worked around locally).

## Manual verification still needed (not done in this environment)

- **Live round-trip against a real Meta WhatsApp Business test number.**
  No Meta developer account/credentials were available. The webhook
  verification handshake, signature checking, message-send call, and
  qualifying-question flow have all been verified against mocked/simulated
  Meta traffic (both automated tests and manual `curl` smoke tests with
  hand-crafted payloads — see the BUILD report), but never against Meta's
  actual servers or a real phone. This is the single biggest gap before
  a real client demo and is explicitly called out (not silently skipped)
  per the original task's instructions.
- **T-013 deployment** was not performed — no PaaS account/target was
  provisioned in this environment. The app is deployment-ready (single
  process, SQLite file on disk, standard `npm start`) but has not actually
  been deployed anywhere.
- **Live QR pairing / a real Baileys connection against a real WhatsApp
  account.** Same category of gap as the Meta round-trip above, for the
  same reason: no phone was available in this environment to scan a QR
  code. `src/services/baileysConnector.js` is written against the real
  `@whiskeysockets/baileys` API contract (the actively-maintained fork, not
  the old abandoned `@adiwajshing/baileys` package), and its reconnect/
  backoff and logged-out-detection logic is exercised by tests that
  simulate Baileys' `connection.update`/`messages.upsert` events against a
  fake socket (`tests/baileysConnector.test.js`) — but the real pairing
  handshake, a real QR scan, and a real sustained connection to WhatsApp's
  servers have never been exercised. This is the equivalent gap to the
  Cloud API one above, called out the same way rather than silently
  skipped.
