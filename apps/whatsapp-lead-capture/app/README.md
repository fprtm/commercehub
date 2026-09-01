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

Current result: **81 passed, 0 failed** — the original 61 (see the BUILD
report for the full breakdown; 8 of those were added in a post-build review
pass, see "Post-build review fixes" below) **plus 20 added for the Baileys
dual-mode extension** (`tests/baileysConnector.test.js`,
`tests/inboundMessageProcessor.test.js`, `tests/whatsappPair.test.js`). All
61 original tests still pass **unmodified**, exercising `cloud_api` mode
exactly as before (NFR-302) — the dual-mode change added new files and a
handful of additive, default-preserving parameters; it did not edit any
existing test.

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
      schema.sql               Lead + FailedEvent schema (+ FailedEvent.channel, added for FR-305)
      index.js                 DB factory (createDb) — used by server.js and tests alike
      migrate.js                standalone `npm run migrate` script
    services/
      stateMachine.js          T-005: qualifying-question state machine (core business logic, UNCHANGED)
      inboundMessageProcessor.js  FR-302: shared processInboundMessage() -- the one place both
                                   connectors call into the state machine/Lead repo from
      metaClient.js             Meta Graph API client (real interface, mocked in tests)
      baileysConnector.js       Baileys adapter: connection lifecycle, reconnect/backoff (FR-304),
                                 logged-out detection (FR-305), QR pairing (FR-303)
      parseWebhookPayload.js    extracts normalized messages from a raw Meta payload
      questionsLoader.js        loads/validates config/questions.json
      leadsRepo.js               Lead table data access (UNCHANGED)
      failedEventsRepo.js        FailedEvent table data access (+ channel param, for FR-305)
    routes/
      webhook.js                GET/POST /webhook (Meta-facing; now a thin adapter onto
                                 inboundMessageProcessor.js)
      auth.js                    GET/POST /login, POST /logout
      leads.js                   GET /leads, POST /leads/:id/status (UNCHANGED)
      whatsappPair.js            GET /whatsapp/pair, POST /whatsapp/pair/reset (FR-303/FR-305)
      health.js                  GET /health
    middleware/requireAuth.js   session gate for the dashboard (reused by whatsappPair.js)
    utils/
      signature.js               X-Hub-Signature-256 verification
      logger.js                  structured console logging
    views/
      login.ejs, leads.ejs       server-rendered dashboard (EJS, no SPA — TD-003) -- UNCHANGED
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
