# WhatsApp Lead Capture & Auto-Responder (Rimba Apparel — portfolio demo)

A small Node.js/Express service that receives inbound WhatsApp messages via
Meta's WhatsApp Cloud API webhook, runs a 2-question qualifying flow, logs
every inquiry as a Lead in SQLite, and gives the business owner a simple
server-rendered dashboard to review and follow up on leads.

This is a portfolio demo built against a simulated client ("Rimba Apparel",
fictional). See the spec docs this was built from:
- `../business-simulation.md`
- `../docs/sdd/changes/2026-09-01-whatsapp-lead-capture.md`
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
| `WHATSAPP_VERIFY_TOKEN` | Arbitrary string you choose and enter into the Meta App dashboard's webhook config screen; used for the `GET /webhook` verification handshake. |
| `WHATSAPP_ACCESS_TOKEN` | System user access token from the Meta App dashboard; Bearer-auth for outbound Graph API calls. |
| `WHATSAPP_PHONE_NUMBER_ID` | The "Phone Number ID" (not the phone number) from the Meta App dashboard's WhatsApp > API Setup screen. |
| `WHATSAPP_APP_SECRET` | **Required** — App Secret from the Meta App dashboard, used to verify the `X-Hub-Signature-256` header on inbound webhook requests. **Not in the original task brief's env var list** — added because the technical design (Phase L / Data Flow) explicitly requires signature verification; see "Judgment calls" below. The server (`src/server.js`) refuses to start without it, so signature verification is never silently optional in a deployed build. (The underlying `createApp()` factory still accepts an unset `appSecret` for tests that construct the app directly without going through `server.js`.) |
| `SESSION_SECRET` | Secret used to sign the dashboard's session cookie. |
| `OWNER_USERNAME` / `OWNER_PASSWORD` | Single-owner dashboard login credentials (no user table — see technical design's Authentication Strategy). |
| `DATABASE_PATH` | Path to the SQLite file (default `./data/leads.db`). |

## Running the tests

```bash
npm test
```

Runs Node's built-in test runner (`node --test`, no extra test framework
dependency) against everything in `tests/`. All tests run against an
**in-memory SQLite database** and a **mocked Meta client** — nothing touches
a real network or a real WhatsApp number.

Current result: **61 passed, 0 failed** (see the BUILD report for the full
breakdown of what's covered; 8 of these were added in a post-build review
pass — see "Post-build review fixes" below).

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

## Project layout

```
app/
  config/questions.json       qualifying-question script (NFR-005)
  src/
    app.js                    Express app factory (dependency-injected: db, meta client, config)
    server.js                 real entrypoint: wires env vars, real DB, real Meta client
    db/
      schema.sql               Lead + FailedEvent schema (Phase K, matched exactly)
      index.js                 DB factory (createDb) — used by server.js and tests alike
      migrate.js                standalone `npm run migrate` script
    services/
      stateMachine.js          T-005: qualifying-question state machine (core business logic)
      metaClient.js             Meta Graph API client (real interface, mocked in tests)
      parseWebhookPayload.js    extracts normalized messages from a raw Meta payload
      questionsLoader.js        loads/validates config/questions.json
      leadsRepo.js               Lead table data access
      failedEventsRepo.js        FailedEvent table data access
    routes/
      webhook.js                GET/POST /webhook (Meta-facing)
      auth.js                    GET/POST /login, POST /logout
      leads.js                   GET /leads, POST /leads/:id/status
      health.js                  GET /health
    middleware/requireAuth.js   session gate for the dashboard
    utils/
      signature.js               X-Hub-Signature-256 verification
      logger.js                  structured console logging
    views/
      login.ejs, leads.ejs       server-rendered dashboard (EJS, no SPA — TD-003)
  tests/                        node:test unit + integration tests (see below)
  data/                         SQLite file lives here at runtime (gitignored)
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
