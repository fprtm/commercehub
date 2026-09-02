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
| `PRODUCT_MATCH_THRESHOLD` | *(optional)* Overrides the fuzzy product-matching confidence threshold (0–1 scale; see "Fuzzy product matching" below). Falls back to `config/products.json`'s own `matchThreshold` field, then to a coded default of `0.65`. |
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

Current result: **217 passed, 0 failed** — 182 pre-existing (unmodified,
per NFR-701), **plus 35 added for dashboard navigation, database-backed
Product management, and Baileys connection resilience**
(`docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md`,
FR-701..FR-703):

- `tests/productsRepo.test.js` — 8 tests for the `products` table's
  data-access layer in isolation: create/update/deactivate/activate,
  alias normalization (trim, drop blanks), `listAll()` vs. `listActive()`,
  deactivate never deleting the row, and NOT_FOUND errors for a bad id.
- `tests/productsSeed.test.js` — 6 tests for the one-time JSON→database
  seed step, including **NFR-703's idempotency requirement directly**:
  running the same seed step 2, 3, and 4 times in a row against the same
  DB creates exactly the products it would on the first run, never more —
  proven by asserting `productsRepo.listAll().length` stays fixed across
  repeated calls, not just "it didn't throw."
- `tests/products.test.js` — 10 tests for the `/products` dashboard CRUD
  routes over real HTTP: auth-gated (redirects to `/login` when
  unauthenticated, for both the page and every POST action), create with
  parsed comma-separated aliases, blank-name rejection, edit, deactivate
  (soft-delete — row still exists, `is_active` flips), reactivate, and a
  not-found id redirecting with a flash message instead of crashing.
- `tests/productsDbMatching.test.js` — 4 end-to-end tests proving
  fuzzy-matching now reads the Product catalog from the **database**, not
  `config/products.json`: a dashboard-created product matches; deactivating
  it via the real `POST /products/:id/deactivate` route makes it stop
  matching on the very next independent inbound message (while the
  earlier, already-matched lead's own record is left untouched);
  reactivating makes it match again; and an empty DB catalog (fresh
  install, nothing seeded/added yet) correctly flags every Q1 answer
  `needs_review`.
- `tests/navBar.test.js` — 7 tests for the shared nav partial (FR-701):
  all four nav links (Leads/Products/Failed Events/Pairing) render on each
  of the four authenticated pages; every one of those pages is still
  auth-gated (nav bar is never visible unauthenticated); and the new
  `/failed-events` page itself lists recorded failures / shows an empty
  state.

Below this, the original breakdown for fuzzy product matching itself
(FR-501..FR-504) is unchanged from before this change — **182 pre-existing,
128 original, plus 26 added for the first version of fuzzy product
matching**, **plus 19 more added for a first independent adversarial
review's fixes**, **plus 9 more added for a second independent review's
retuning fixes** (`docs/sdd/changes/2026-09-01-fuzzy-product-matching.md`;
see "Independent adversarial review findings" and "Second independent
review" below for what each batch fixes):

- `tests/productMatcher.test.js` — 29 tests for the matching algorithm in
  isolation. The original 12: an exact product-name match scores high;
  several stemmed/inflected variants ("kaosnya ada?", "membeli kaos",
  "dibeli kaos nya") all match the same product via Indonesian stemming; a
  specific full-name mention resolves to the specific product rather than
  tying on a generic alias; unrelated text ("toko buka jam berapa?",
  off-topic questions) scores low/no-match; a minor typo ("kaus" for
  "kaos") still matches via Jaro-Winkler tolerance; an empty/undefined
  catalog and empty/null customer text are always handled safely
  (NFR-502); the configurable threshold changes the match/no-match outcome
  for a borderline score. 9 more from the first adversarial review: the
  reviewer's own exact refund/rusak/komplain adversarial sentences now
  resolve to `needs_review` (both via the length-penalized score alone,
  and independently via the intent denylist); the denylist does NOT fire
  on ordinary product questions; a stemmed inflection of a denylist word
  ("dirusak") is still caught; a bare alias shared by two products
  resolves to `needs_review` (ambiguous), a clear score gap does not, and
  the ambiguity margin is configurable. 8 more from the second review's
  retuning: 4 realistic longer purchase questions (with filler/politeness
  words) now correctly match; the original 3 adversarial examples still
  correctly reject after retuning; 3 brand-new adversarial examples from
  the second review (a store-hours question mentioning "jaket" in
  passing, an order-status complaint using non-denylist words, a
  size-exchange request) also correctly reject; naming the full product
  then complaining is still caught by the denylist; and — the Secondary
  finding's fix — "pas" (and other common short words) no longer
  spuriously trips the intent denylist, in isolation and in a realistic
  sentence, while typo tolerance for longer denylist words is preserved.
- `tests/productsLoader.test.js` — 13 tests for loading/validating
  `config/products.json` (FR-501). The original 7: loads the real shipped
  file, a swapped fixture file changes the catalog with no code change, a
  missing file resolves to an empty catalog (not a crash — NFR-502),
  aliases are optional, and malformed entries (missing name, non-array
  aliases) are rejected. 6 more from the first adversarial review: the
  intent denylist always includes the coded defaults (with or without
  a config file), a client can extend it via `products.json` (unioned
  with, not replacing, the defaults), a non-array `intentDenylist` is
  rejected, and — the Medium finding's catalog-validation fix — a
  duplicate alias/name shared across two different products logs a
  warning at load time (and a catalog with no duplicates does not).
- `tests/productMatching.test.js` — 12 tests proving the wiring into
  `inboundMessageProcessor.js` and the dashboard. The original 7: a
  high-confidence match proceeds through Q2 completely unchanged and
  stores the matched product (FR-503); a low-confidence/unrelated answer
  suppresses the Q2 prompt and flags `needs_review` without touching
  fallback/retry (FR-504, Settled Decision #3); an explicitly-empty
  catalog always resolves to `needs_review` with no crash (NFR-502);
  *omitting* the `products` dependency entirely (every pre-existing test)
  leaves matching a complete no-op; the read receipt still fires even when
  the scripted reply is suppressed; and two end-to-end tests over the real
  `POST /webhook` route plus `GET /leads` proving the matched product name
  and the "Needs review" badge actually render on the dashboard. 4 more
  from the first adversarial review, all proven through the *real*
  processor/HTTP stack (not just `productMatcher.js` in isolation): a
  refund complaint does NOT get the tone-deaf Q2 "what size?" auto-reply
  and IS flagged `needs_review`; naming the full product then complaining
  is still caught (proving the denylist matters even when the scoring fix
  alone would have let it through); two products sharing a generic alias
  resolve to `needs_review` over the real processor; and an end-to-end
  HTTP + dashboard test confirms a refund complaint shows "Needs review"
  with the raw text, never a false "Matched product". 1 more from the
  second review: a realistic longer purchase question with filler words
  still gets Q2 and a matched product over the real processor, not
  `needs_review`.

**All 128 pre-existing tests pass completely unmodified (NFR-502)** — not
one existing test file's assertions were touched, across any round of
this change. This was possible by design: `products` is an additive,
opt-in dependency on `createInboundMessageProcessor`/`createApp`/
`createWebhookRouter`/`startTestServer` (same pattern as
`settingsRepo`/`sleep`/`random` before it) that is left `undefined` unless
a caller explicitly passes it — every pre-existing test constructs the
processor/app without it, so fuzzy matching never activates for them and
today's behavior (Q2 always sent on a usable Q1 answer) is exercised
exactly as before. In production (`src/server.js`), the catalog is always
loaded and passed in for real — see "Fuzzy product matching" below. Two of
the 26 first-round fuzzy-matching tests *did* need their own expectations
revised during the first adversarial review's fixes (not touched, but not
"pre-existing" either — they were added in this same change, not part of
the frozen 128): the length penalty was, at that point, intentionally more
conservative about longer messages diluted with filler words, so one
inflected-variant example (`"mau beli kaos dong"` → `"mau beli kaos"`) and
one borderline-threshold example (a custom threshold of `0.4` → `0.2`, to
match the then-lower score for the same deliberately-partial input) were
adjusted to reflect that scoring. The second review's retuning (raising
`FREE_UNACCOUNTED_TOKENS_PER_MATCH` back up from 2 to 5) required **zero**
further test-expectation changes to any of those files — every existing
assertion in `tests/productMatcher.test.js`, `tests/productsLoader.test.js`,
and `tests/productMatching.test.js` still held after retuning; only new
tests were added.

Prior to this change: **128 passed, 0 failed** — 100 pre-existing plus 28
added for the humanized-timing module and its post-review fixes:
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

## Dashboard navigation (FR-701)

`docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md`.
Every authenticated dashboard page — **Leads**, **Products**,
**Failed Events**, **Pairing** — now shows a small, persistent nav bar
linking to the other three, so nothing requires typing a URL by hand.
Implemented as one shared EJS partial (`src/views/partials/nav.ejs`)
included at the top of each page's view — the simplest reasonable
approach for four pages sharing one nav, per the change doc — styled to
match this app's existing minimal look (same font stack/palette as
`leads.ejs`/`whatsappPair.ejs` already used, no new design language, no
client-side JS anywhere in this app, this included).

**Failed Events** (`/failed-events`) is a new read-only page added
alongside the nav bar — the underlying `failed_events` table and
`src/services/failedEventsRepo.js` already existed (FR-305/webhook error
handling), but there was previously no dashboard route/view for it; adding
one was necessary for the nav bar's "Failed Events" link to actually go
somewhere instead of being a dead link.

## Fuzzy product matching (FR-501..FR-504) and Product management (FR-702)

`docs/sdd/changes/2026-09-01-fuzzy-product-matching.md`. Every customer's
answer to Q1 ("Which product are you interested in?") is now fuzzy-matched
against a configured Product catalog, using **classical NLP only** —
Indonesian stemming + string similarity, **deliberately not an LLM** (see
"What this is not", below).

- **Above the confidence threshold** — today's flow proceeds completely
  unchanged: Q2 is asked as normal, and the matched product's name is
  saved on the Lead and shown on the dashboard (`Matched product: ...`
  under the Q1 answer).
- **Below the threshold** (including a product-less catalog, or genuinely
  unrelated text like "toko buka jam berapa?") — the Q2 prompt for that
  turn is **suppressed** (the customer gets no further automated message
  for it — see "What doesn't change" below), and the Lead is flagged with
  a **"Needs review — unmatched product"** badge on the dashboard, right
  next to the raw `question1_answer` text, so the owner can read what the
  customer actually wrote and follow up manually.

### Configuring the product catalog (FR-501, superseded by FR-702 below)

**As of `docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md`
(FR-702), the product catalog itself lives in the database, managed from
the dashboard's `/products` page — not in `config/products.json`.** Log in
and open **Products** in the nav bar: add a product (name + comma-separated
aliases), edit one, or deactivate/reactivate one (soft-delete — a
deactivated product stops matching immediately but is never gone, and can
be reactivated any time). No code change, no file edit, no server restart
required for any of it — see `src/routes/products.js` /
`src/services/productsRepo.js`.

**What `config/products.json` is still for, and only for, after this
change:**

1. **One-time seed.** The very first time the app boots against an empty
   `products` table, whatever `config/products.json` contains (if
   anything) is copied into the database once — see
   `src/services/productsSeed.js`. This exists purely so an existing
   client's already-curated catalog isn't lost by this change. **Every
   boot after that first one is a no-op** (NFR-703 — proven by
   `tests/productsSeed.test.js`, including repeated-boot scenarios), and
   the *file* is never consulted again for the product list itself.
   Editing `config/products.json` after the first boot has **zero
   effect** — this is FR-702's explicit acceptance criterion, not an
   oversight.
2. **`matchThreshold` / `intentDenylist`.** These two fields are matching
   *tuning knobs*, not catalog data — FR-702 only moved the product list
   itself into the database. They're still read from
   `config/products.json` on every server start (same as before), or
   overridden via `PRODUCT_MATCH_THRESHOLD` (env var) — see below.

```json
{
  "matchThreshold": 0.65,
  "products": [
    { "name": "Kaos Rimba Navy", "aliases": ["kaos navy", "kaos", "baju kaos"] }
  ],
  "intentDenylist": ["nyesel", "bocor halus"]
}
```

(The `"products"` array above is only ever read for the one-time seed
described above — add/edit/deactivate products from the dashboard from
here on, not this file.)

Each product is intentionally lightweight: just a `name` and an optional
list of `aliases` (Settled Decision #2 in the original fuzzy-matching
change doc) — **not** Project 3's full inventory model (no SKU, stock
quantity, low-stock threshold). This project has no inventory concept at
all; adding one was explicitly out of scope. `is_active` (FR-702's
deactivate/reactivate flag) is the one addition to that original shape —
it's a dashboard-management concept, not an inventory one.

The optional top-level `"intentDenylist"` array lets the owner add their
own complaint/intent-shifting vocabulary — it's **unioned with** (not a
replacement for) the built-in defaults in
`src/services/productMatcher.js` (`refund`, `rusak`, `komplain`, `retur`,
`garansi`, `cacat`, `kecewa`, `robek`, `sobek`, and more — see
"Independent adversarial review findings" below for the full list and why
it exists), so a real client can extend it without a code change but can't
accidentally remove the safety floor.

**Aliases matter more than they look.** A generic one-word alias (e.g.
`"kaos"` on "Kaos Rimba Navy") is what lets a short, vague customer
message like "kaosnya ada?" or "membeli kaos" match at all — a customer
rarely types a product's full catalog name. Without at least one short,
natural alias per product, only messages that closely echo the full name
will match; everything else falls to `needs_review`. This is a deliberate,
documented trade-off, not a bug: a business owner who wants better
coverage adds more aliases (the actual words their customers tend to use)
from the Products page.

An empty product catalog (a fresh install with nothing seeded/added yet,
or every product deactivated) is not an error — every Q1 answer just
falls through to `needs_review` until the owner adds/reactivates products
from the dashboard (see NFR-502 below, still true, now DB-backed).

### The matching algorithm (FR-502) and why 0.65

Implemented in `src/services/productMatcher.js` — full reasoning is in
that file's doc comment; summarized here:

1. Both the customer's text and every product name/alias are lowercased,
   tokenized, and run through the **Sastrawi Indonesian stemmer**
   (`sastrawijs`) — this is what makes "membeli kaos" ("buying a shirt"),
   "dibeli kaos nya" ("[shirt] is bought"), and "kaosnya ada?" ("is there
   a shirt?") all reduce to the same root token `kaos`, regardless of
   which Indonesian prefix/suffix inflection the customer typed.
2. Each candidate (a product's name, and separately each alias) is scored
   by how many of ITS tokens have a close match (**Jaro-Winkler
   similarity** ≥ 0.85, via the `natural` package) somewhere in the
   customer's stemmed text — chosen over plain Levenshtein because
   Jaro-Winkler is already normalized to a 0–1 confidence score and
   weights prefix matches more heavily, which suits short tokens with a
   typo near the end (a common one/two-thumb phone-typing pattern, e.g.
   "kaus" for "kaos"). TF-IDF (also mentioned as an option in the change
   doc) was considered and not used — it's built for weighting terms
   across a large document corpus, the wrong tool for a small,
   fully-enumerable product list matched one message at a time.
3. **Length penalty (post-review fix — see "Independent adversarial review
   findings" below).** The raw `candidateCoverage * averageSimilarity`
   score from step 2 is then multiplied by a penalty based on how many of
   the CUSTOMER's OWN tokens the match leaves unaccounted for, beyond a
   small free allowance that scales with how much evidence actually
   matched. This is what stops a single product word buried in an
   otherwise-unrelated (and often complaint-shaped) sentence from scoring
   a false 1.0.
4. A product's overall score is the best score across its name + all its
   aliases, with ties broken toward whichever candidate matched more
   tokens (more specific evidence) — so if the catalog has both "Kaos
   Rimba Navy" (alias `"kaos"`) and "Kaos Rimba Hitam", a message that
   actually names "Kaos Rimba Hitam" resolves to the Hitam product, not
   an arbitrary tie-break toward whichever product is listed first.
5. **Ambiguity margin (post-review fix).** If the top-scoring product and
   the runner-up are both above threshold and within a small margin of
   each other (default 0.1), the match is too close to call — resolved as
   `needs_review`, not silently picked.
6. **Intent denylist (post-review fix).** Independent of all the scoring
   above: if the customer's text contains a complaint/intent-shifting word
   (e.g. "refund", "rusak", "komplain" — see the full list and how to
   extend it below), the answer is always routed to `needs_review`,
   regardless of score.

**Default threshold: 0.65** (0–1 scale), configurable via
`PRODUCT_MATCH_THRESHOLD` (env var) or `products.json`'s own
`matchThreshold` field, without a code change. In practice the score is
either exactly 0 (nothing matched at all) or, once at least one real token
match happens, clusters well above 0.65 for a genuine mention — including
realistic LONGER purchase questions with filler/politeness words ("min",
"kak", "dong", "nya", "gak", question words), which score ~1.0 as long as
the product itself is clearly named somewhere in them (see "Second
independent review" below for why this needed retuning); 0.65 sits above
both the "only 1 of 3 words in a long product name happened to match"
case (~0.33) and the "one product word buried in an unrelated, often
complaint-shaped sentence" case the length penalty targets (~0.2–0.5 in
testing), and below every genuine match observed in testing (see
`tests/productMatcher.test.js` for concrete score examples).

### Independent adversarial review findings (all fixed)

An independent adversarial reviewer of the first version of this feature
found three real gaps, all now fixed:

**Critical — a product word inside an unrelated (often complaint) message
scored a false 1.0.** The original scoring formula's denominator was only
the CANDIDATE's token count (often 1, for a short alias like `"kaos"`) —
never the customer message's length — so a single matching word anywhere
in a long sentence scored 1.0 regardless of how much of the sentence went
unaccounted for. Concretely, `"kaos kemarin yang saya beli robek, bisa
refund?"` (a refund complaint) used to score **1.0** against "Kaos Rimba
Navy" and trigger an unmodified, tone-deaf "what size are you looking
for?" auto-reply, with `needs_review=false` — the dashboard showed it as
a normal successful match, zero signal to the owner. Fixed with
**defense in depth, both layers**:
1. **The length penalty** described in step 3 above — the same message
   now scores **~0.20** (well below the 0.65 threshold) via the scoring
   formula alone (see "Second independent review" below for the exact
   constant, retuned once already since this fix first shipped).
2. **The intent denylist** (step 6 above, `DEFAULT_INTENT_DENYLIST` in
   `src/services/productMatcher.js`: `refund`, `rusak`, `komplain`,
   `retur`, `garansi`, `cacat`, `kecewa`, `robek`, `sobek`, `tipu`,
   `penipuan`, `palsu`, `keluhan`, `protes`, `kapok`, `gagal`, `error`,
   `hilang`, `hangus`, `batal`, `nipu`, `bocor`, `patah`, `pecah`) —
   an **independent, non-scoring safety net**. This second layer is not
   redundant: `"kaos rimba navy saya rusak parah, refund dong"` (the
   customer names the product **in full**, then complains) still scores a
   raw **1.0** — naming the product fully buys back enough of the length
   penalty's free allowance that scoring alone cannot distinguish "I want
   to buy this" from "this broke". Only the independent denylist check
   catches that case. Both layers are exercised directly against these
   exact adversarial sentences in `tests/productMatcher.test.js` and
   end-to-end (through the real processor and `POST /webhook` + dashboard)
   in `tests/productMatching.test.js`.
   The denylist is extensible without a code change via `products.json`'s
   optional `"intentDenylist"` array — a real client's own complaint
   vocabulary is **unioned with** (not a replacement for) the coded
   defaults, which always stay active as a safety floor. See
   `src/services/productsLoader.js`.

**Medium — no ambiguity/margin check between top and runner-up.** A bare
`"kaos"` aliased to two different products used to silently resolve to
whichever product happened to be listed first in the catalog array,
reported at full confidence with no indication it was a close call. Fixed
with the ambiguity margin (step 5 above): both `>= threshold` and within
0.1 of each other now resolves to `needs_review` instead. Also added:
`productsLoader.js` now validates the catalog at load time and **logs a
warning** (`products_config_duplicate_alias_warning`) for any name/alias
shared by two or more different products — exactly the catalog shape that
creates this ambiguity, flagged before a real customer message ever hits
it.

### Second independent review: the Critical fix overcorrected (also fixed)

A *second* independent review verified the Critical fix genuinely worked
(6 adversarial complaint/refund inputs, including 3 brand-new ones using
vocabulary not in the denylist, all correctly rejected) — but found the
length penalty had overcorrected: `FREE_UNACCOUNTED_TOKENS_PER_MATCH = 2`
was too small an allowance for realistic LONGER legitimate purchase
questions, which naturally carry several filler/politeness words ("min",
"kak", "dong", "nya", "gak", question words) that have nothing to do with
complaint intent. Of 8 ordinary, zero-complaint-intent product questions
tested, 4 incorrectly scored below 0.65 and got routed to `needs_review`
— safe-direction (never a wrong auto-reply), but defeating a lot of the
feature's value if roughly half of normal longer questions get needlessly
flagged for manual review.

**Fix: `FREE_UNACCOUNTED_TOKENS_PER_MATCH` retuned from 2 to 5**, solved
as a single shared constant against BOTH example sets together (not one
at the other's expense — see `src/services/productMatcher.js`'s doc
comment for the full derivation). Before → after, the reviewer's exact
examples:

| Input | Should | Before (score) | After (score) |
|---|---|---|---|
| `"jaket outdoor nya masih ada gak min, warna apa aja"` | match | 0.33 (wrong) | **1.00** ✓ |
| `"min, kaos rimba navy nya ada warna lain gak selain navy"` | match | 0.60 (wrong) | **1.00** ✓ |
| `"permisi kak mau tanya kaos rimba navy nya itu bahannya apa ya, terus available size apa aja"` | match | 0.27 (wrong) | **1.00** ✓ |
| `"celana cargo nya masih tersedia ga kak, boleh liat foto dan harganya"` | match | 0.25 (wrong) | **1.00** ✓ |

...and the retuned constant re-verified against all 6 adversarial
complaint/refund examples (the original 3, plus 3 new ones from the
second review), all still correctly rejected:

| Input | Score | Matched |
|---|---|---|
| `"kaos kemarin yang saya beli robek, bisa refund?"` | 0.33 | **false** (denylist also fires) |
| `"jaket yang saya beli kemarin rusak, minta ganti dong"` | 0.25 | **false** (denylist also fires) |
| `"celana yang kemarin saya beli robek parah, komplain nih"` | 0.25 | **false** (denylist also fires) |
| `"toko jaket buka jam berapa ya min?"` (store hours, "jaket" in passing) | 0.50 | **false** |
| `"pesanan saya kok lama banget, belum nyampe juga sampai sekarang"` (order-status complaint, no denylist words, and no product word at all) | 0.00 | **false** |
| `"kaos nya mau saya tukar ukuran, bisa gak"` (size exchange) | 0.33 | **false** |
| `"kaos rimba navy saya rusak parah, refund dong"` (full name + complaint) | 1.00 (by score alone) | **false** — denylist-only catch, exactly as designed |

Why 5 (not some other value) is safe: the adversarial sentences above all
have exactly ONE matched candidate token (the bare product mention,
`matchedCount = 1`), while every legitimate longer question above has 2–3
matched tokens (the product's full name, or a multi-word alias). Because
the free allowance scales with `matchedCount`, raising it to 5 gives
long-but-genuine multi-token mentions much more room to carry filler
words, while single-token bare mentions (the adversarial shape) still hit
their penalty far sooner — see the module's doc comment for the exact
inequality this was solved against.

**Secondary — a benign short word ("pas") spuriously tripped the intent
denylist.** Jaro-Winkler similarity is unreliable on very short strings
independent of meaning: `"pas"` ("just"/"fits"/"at that moment" — a
completely ordinary, common word) scored ~0.89 similarity against
`"palsu"` ("counterfeit"), above the 0.85 fuzzy-match bar, purely because
both are short. It never flipped a real outcome in testing (the score was
already low in every case checked), but it was a real risk of a
misleading "why was this flagged" reason shown to the owner on an
ordinary message. **Fixed**: `findIntentDenylistHits()` now requires an
**exact** stemmed match (no Jaro-Winkler fuzziness) whenever the shorter
of the two words being compared is under `DENYLIST_SHORT_WORD_EXACT_MATCH_LENGTH`
(5 characters) — fuzzy typo-tolerance (e.g. "rusakk" for "rusak") still
applies once both words are at least that long. `tests/productMatcher.test.js`
confirms `"pas"` (and several other common short words: "gak", "dan",
"apa", "ada", "aja", "kak", "min", "ya") no longer trip the denylist, a
realistic sentence using "pas" in context is not flagged, and typo
tolerance for longer denylist words is unaffected.

**Low — the accuracy note only disclosed false negatives.** See "What this
is not" below, now updated to disclose the false-positive risk too.

### What doesn't change

- **The customer still gets a read receipt.** Per FR-601's contract
  (see "Humanized response timing" above), `markAsRead` fires
  unconditionally for every inbound message — fuzzy matching only affects
  whether the *scripted Q2 reply* goes out, never the read receipt.
- **The state machine itself (`stateMachine.js`) is completely unmodified**
  — this feature is a thin overlay in `inboundMessageProcessor.js`, not a
  change to the qualifying-question flow's core logic. `question1_answer`
  is still saved exactly as it always was (so the owner sees the raw text
  either way); a low-confidence match does not trigger the existing
  retry/fallback logic (Settled Decision #3: "no fallback/retry triggered
  by this alone") — it only withholds that one turn's Q2 prompt and flags
  the Lead. The customer's very next message is handled completely
  normally.

### NFR-502: no regression, and the empty-catalog safe path

`products` is an additive, opt-in dependency (`createInboundMessageProcessor`
/ `createApp` / `createWebhookRouter`) — left `undefined` unless a caller
explicitly passes it in, so every one of the 128 pre-existing tests (which
construct the processor/app without it) keeps exercising the exact
pre-fuzzy-matching behavior, completely unmodified. In production,
`src/server.js` always loads and passes in the real (possibly empty)
catalog. An **explicitly empty** catalog (`products: []`, or a missing
`products.json`) always resolves to "no match" → `needs_review`, safely —
never a crash — see `tests/productMatcher.test.js`,
`tests/productsLoader.test.js`, and `tests/productMatching.test.js` for
dedicated coverage of exactly this case.

### Judgment calls made for this change

- **Config file, not a dashboard CRUD screen (FR-501).** Project 2/3 build
  full Product CRUD UIs because they track real inventory (stock levels,
  SKUs) that changes constantly and needs owner-facing editing at runtime.
  This project has no inventory concept at all — the catalog is just
  `{ name, aliases }`, edited as infrequently as `config/questions.json`
  already is. A config file is proportional; a CRUD screen for two fields
  would be overengineering relative to this project's established pattern.
- **`needs_review` is a new boolean column, not a new `status` value.**
  Keeping it separate from `status` (`new`/`responded`/`closed`) means it
  composes with the existing lifecycle instead of replacing it — a Lead
  can be `new` *and* `needs_review` at the same time (the two badges do
  stack on the dashboard), and the owner's existing "Mark responded"/"Mark
  closed" actions keep working unchanged regardless of whether the Q1
  answer matched.
- **Schema change follows the existing precedent, with the same caveat.**
  `leads.matched_product`/`leads.needs_review` were added directly to
  `src/db/schema.sql`'s `CREATE TABLE IF NOT EXISTS leads (...)`, the same
  way `retry_count` was added for the original build (see "Post-build
  review fixes" below) — there is no migration framework in this project.
  This means a **fresh** database (a new `data/leads.db`, e.g. after
  `npm run migrate` on a clean install) gets the new columns automatically,
  but an **already-existing** `leads.db` file from before this change
  would not — its `leads` table was already created, so
  `CREATE TABLE IF NOT EXISTS` is a no-op against it. Since `data/` is
  gitignored/local-only and this is a portfolio demo (not a production
  system with real customer data to preserve), the honest fix for anyone
  hitting this is to delete the old `data/leads.db` and re-run
  `npm run migrate` — not a real migration tool, but consistent with how
  this exact gap was already handled for `retry_count`.
- **Fuzzy matching only ever touches the ANSWER_Q1 turn.** It is wired
  into `inboundMessageProcessor.js`, not `stateMachine.js` — the state
  machine's own header comment already documents that NLP/answer-relevance
  validation is explicitly out of its scope (structural-only). Keeping
  fuzzy matching as a layer on top, rather than folding it into the state
  machine's pure decision function, is what makes it possible to add this
  entire feature with **zero changes to `stateMachine.js` or its existing
  tests** (NFR-502).

### What this is not (honest accuracy note)

This is classical NLP (stemming + string similarity), not language
understanding. It cannot infer intent, resolve pronouns, or truly
understand a sentence — it can only recognize that some of the customer's
words are *close to* a configured product name or alias, and (via the
intent denylist) that certain specific words are present. That cuts both
ways, and both directions are worth being honest about:

- **False negatives** (a real product question doesn't match anything).
  A customer who describes a product in a way that shares no close-enough
  root words with anything in `products.json` (even if a human would
  obviously know what they meant) will land in `needs_review`, not because
  something is broken, but because that is the honest limit of this
  technique. The practical mitigation is the same one
  `config/questions.json` already relies on: **well-chosen aliases** — the
  actual words customers tend to use, not just the formal product name.
- **False positives** (a product word appears in an unrelated, or
  actively negative, message and gets read as a confident match). This is
  the more dangerous direction — a bad auto-reply looks worse than no
  reply — and an earlier version of this feature genuinely had this bug:
  see "Independent adversarial review findings" above for the exact
  before/after. Two mitigations are now in place (the length penalty and
  the intent denylist), and together they catch every adversarial example
  tested so far, including a full product name mentioned inside a
  complaint. **Neither mitigation is a complete, provable guarantee.** The
  length penalty is a statistical heuristic tuned against a specific set
  of anchor cases, not a formal bound — a sufficiently short, contrived
  message could still slip past it. The intent denylist only recognizes
  the specific (stemmed, near-exact) words configured in it — a complaint
  phrased entirely without any of those words (or their close variants)
  would not be caught. No classical string-similarity technique, and
  arguably no matching technique at all short of a human reading every
  message, eliminates this risk entirely; the goal here was to reduce it
  from "essentially undefended" to "defended in depth against every
  concrete case identified so far," not to claim it is now impossible.

This was a deliberate choice, not a shortcut taken due to time constraints:
an LLM-based matcher is explicitly out of scope for this project (deferred
to a future "Secondary Niche"/AI-upsell offering) — see the change doc's
"NEVER FOR THIS PROJECT". A `needs_review` Lead is not a dead end either —
the owner always sees the customer's exact words and can follow up
manually, which is the whole point of the non-blocking design (Settled
Decision #1: "never send a potentially-wrong auto-generated response to
the customer") — and it's exactly the same non-blocking design that makes
routing a detected false positive to `needs_review` (rather than trying to
silently "fix" the reply) the correct, safe response to this bug class too.

## Never dropping a message, even after the flow completes (FR-801..FR-803)

`docs/sdd/changes/2026-09-02-capture-post-completion-messages.md`. Root-caused
via a real live test: once both qualifying questions are answered,
`stateMachine.js` resolves every further inbound message from that phone
number to `NO_OP` — correctly, no automated reply is sent (the scripted flow
is genuinely finished) — but before this change, that also meant the message
was dropped completely: no reply, no Lead update, no record it ever arrived.
In the live test, the customer's actual product mention ("kaos rimba")
arrived as a 3rd/4th message, after two earlier, low-content messages had
already filled Q1/Q2, and was silently lost.

- **`additional_notes`** (new nullable `TEXT` column on `leads`) — an
  append-only, timestamped running log. A post-completion message is now
  appended as `[<ISO-8601 timestamp>] <message text>`, never overwriting or
  truncating earlier notes, and shown on the dashboard under the Q2 answer in
  a visually distinct amber callout (clearly "extra context," not part of the
  structured Q&A).
- The fuzzy product matcher (see "Fuzzy product matching" above) is re-run
  against every post-completion message too. If it produces a **strictly
  higher** confidence score than whatever's currently backing
  `matched_product` (persisted alongside it in a new `matched_product_score`
  `REAL` column — see that column's doc comment in `src/db/schema.sql` for
  why the score itself has to be stored rather than recomputed on demand), the
  stored match is updated. A later, equal-or-lower-confidence message never
  downgrades — or sideways-replaces — an existing good match.
- Any post-completion message with usable text sets `needs_review = true` —
  **for the two non-terminal `NO_OP` reasons only** (`flow_already_complete`,
  `fallback_already_triggered`) — even if that same message also produced a
  confident product match, because an ongoing conversation on a still-open
  lead always deserves a fresh look from the owner, not a silent database
  update. See the post-review scoping note below for why a closed/responded
  lead is deliberately excluded from this.
- **No new automated reply is ever sent for these messages** — this is a
  data-capture fix only; `decision.replies` stays `[]` for every applicable
  case, unchanged.

**Judgment call — which `NO_OP` reasons this applies to:** `stateMachine.js`
resolves to `NO_OP` for three distinct reasons: both questions already
answered (`flow_already_complete` — the case the live test hit), fallback
already triggered (`fallback_already_triggered`), and the owner having
already marked the lead `responded`/`closed` (`lead_status_responded` /
`lead_status_closed`). **`additional_notes` capture (FR-801) applies to all
of them** — the change doc's own examples are all `flow_already_complete`,
but its stated intent — "never silently drop a message" — does not carve out
an exception for the other reasons: a customer writing back after fallback
already fired, or after the owner closed their lead, is exactly as real and
exactly as easy to lose as one that arrives one message earlier. Gated on the
message actually carrying usable text (`stateMachine.js`'s own
`hasUsableText` check) — a non-text message (sticker/image/empty body) has
nothing to append or match, so it remains a true no-op exactly as before.

**Post-review scoping fix — `needs_review` is NOT forced for closed/responded
leads:** an earlier version of this change force-set `needs_review = true`
for every `NO_OP` reason, including `lead_status_closed`. Independent review
caught that this creates a state that was never reachable before: `closed`
is intentionally terminal (`leadsRepo.updateStatus()` blocks any transition
away from it) and `leads.ejs` shows zero action buttons for a closed lead
("No further action") — so a closed lead flagged "needs review" would stay
that way **forever**, with no escape hatch, and the badge's "unmatched
product" wording would be actively misleading (the actual issue has nothing
to do with matching). The fix: `additional_notes` capture still happens for
every `NO_OP` reason (data is never lost — that part of FR-801 is unchanged),
but `needs_review` is only force-set to `true` for the two non-terminal
reasons. For `lead_status_responded`/`lead_status_closed`, `needs_review` is
left exactly as it already was — not forced true, and not force-cleared
either.

**Existing DB files:** `CREATE TABLE IF NOT EXISTS` in `src/db/schema.sql`
does not retroactively add columns to a `leads` table that already existed
before this change — every prior column added to `leads` got away without an
explicit migration step only because the physical DB file happened to be
recreated by hand each time. `src/db/index.js` now checks for
(`matched_product_score`, `additional_notes`) via `PRAGMA table_info(leads)`
on every `createDb()` call and `ALTER TABLE ADD COLUMN`s any that are
missing — idempotent, negligible cost, and safe to run against a DB file with
real rows already in it (verified against a copy of this project's own
`data/leads.db`).

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

### Connection-hardening options (FR-703) — a mitigation, not a fix

`docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md`.
A real live test showed the Baileys connection getting logged out shortly
after connecting; tracing the code found `makeWASocket({...})`
(`src/services/baileysConnector.js`'s `defaultMakeSocket`) was being
called with **zero identity/fingerprint configuration** beyond bare
library defaults. Three commonly-recommended options were reviewed and
applied, each documented in code at the call site:

- **`browser: Browsers.ubuntu('Chrome')`** — an explicit, realistic client
  identity instead of an unnamed/generic default. `Browsers` is a helper
  the installed `@whiskeysockets/baileys` version (`^7.0.0-rc14`) actually
  exports (confirmed by inspecting the package directly — it also exports
  `.macOS`, `.windows`, `.android`, `.baileys`, `.appropriate`); calling
  `Browsers.ubuntu('Chrome')` produces the `['Ubuntu', 'Chrome', '22.04.4']`
  tuple WhatsApp's multi-device protocol expects, presenting as an ordinary
  desktop-linked-device session.
- **`markOnlineOnConnect: false`** — this app is reply-only (never an
  interactively "used" client), so it never flips the paired number to
  "online" the moment the socket connects. Baileys already defaults this
  to `false`; set explicitly so the choice is documented here rather than
  relying on an implicit default that could silently change in a future
  library version.
- **`syncFullHistory: false`** — skips syncing the account's full message
  history on initial connect. This app only acts on new inbound messages
  from the moment it connects forward (`handleMessagesUpsert()` already
  discards Baileys' replayed-history events, keeping only `type ===
  'notify'`), so a full history sync is pure extra load/traffic with no
  use to this app — one of the most commonly-recommended settings to
  disable for a lightweight, reply-only client like this one.

**Honest framing (NFR-702 — stated plainly, not oversold):** these three
options are a **mitigation that follows commonly-recommended Baileys
community practice**, applied because a real disconnect was actually
observed and traced to their absence. They are **not a guarantee** against
future disconnects, and they do **not** reduce the ban/detection risk
already disclosed above (an unofficial, reverse-engineered protocol
implementation is what it is, regardless of how realistic the client
identity looks) — that risk is structural to using Baileys at all, not
something a `browser` tuple or a couple of connection flags can eliminate.
If WhatsApp's own detection changes, or the specific disconnect that
prompted this change had a different root cause than a missing client
identity, these settings may not help at all. Treat this the same way as
every other risk disclosure in this README: a real trade-off, not a
solved problem.

## Project layout

```
app/
  config/questions.json       qualifying-question script (NFR-005)
  config/products.json        Product catalog seed + matchThreshold/intentDenylist tuning knobs --
                               the "products" array is seed-only after first boot (FR-702); the
                               database (see src/services/productsRepo.js) is the live catalog now
  src/
    app.js                    Express app factory (dependency-injected: db, connectors, config, mode)
    server.js                 real entrypoint: wires env vars, real DB, mode-selected connector,
                               seeds products from config/products.json once (FR-702)
    db/
      schema.sql               Lead + FailedEvent + app_settings + products schema (+ FailedEvent.channel
                                for FR-305; + app_settings single-row table for the auto-reply toggle;
                                + leads.matched_product/needs_review for fuzzy product matching; +
                                products table -- name/aliases(JSON)/is_active -- for FR-702)
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
                                   auto-reply toggle change; now routes every reply through
                                   lib/humanizedTiming.js instead of sending immediately -- FR-604;
                                   and now fuzzy-matches a Q1 answer against the Product catalog the
                                   moment it's accepted, suppressing that turn's Q2 prompt and
                                   flagging needs_review below threshold -- FR-502..FR-504; catalog is
                                   now read fresh from productsRepo.listActive() per message when a
                                   productsRepo is injected -- FR-702)
      productMatcher.js          FR-502..FR-504: the fuzzy-matching algorithm itself (Indonesian
                                  stemming via sastrawijs + Jaro-Winkler token similarity via
                                  natural) -- pure function, no DB/network access, fully documented
                                  reasoning in its own doc comment
      metaClient.js             Meta Graph API client (real interface, mocked in tests); now also
                                 exposes markAsRead/sendTypingIndicator (FR-601/FR-604)
      baileysConnector.js       Baileys adapter: connection lifecycle, reconnect/backoff (FR-304),
                                 logged-out detection (FR-305), QR pairing (FR-303); now also
                                 exposes markAsRead/sendTypingIndicator (FR-601/FR-604); now also sets
                                 an explicit browser identity + markOnlineOnConnect/syncFullHistory
                                 on the socket -- FR-703
      parseWebhookPayload.js    extracts normalized messages from a raw Meta payload (now also the
                                 message id/WAMID, threaded through for markAsRead -- FR-601)
      questionsLoader.js        loads/validates config/questions.json
      productsLoader.js          FR-501: loads/validates config/products.json -- after FR-702, only
                                  used for the one-time DB seed and for matchThreshold/intentDenylist
      productsRepo.js            FR-702: `products` table data access -- create/update/
                                  deactivate/activate/listAll/listActive -- the live Product catalog
                                  source of truth from here on
      productsSeed.js            FR-702/NFR-703: one-time, idempotent JSON->database product seed,
                                  gated on "products table is empty" (not a separate seeded-flag)
      leadsRepo.js               Lead table data access (now also updateProductMatch() for
                                  FR-503/FR-504 -- a narrowly-scoped UPDATE, separate from
                                  saveAnswers(), so it can't clobber question1/2_answer or
                                  fallback/retry state)
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
      products.js                FR-702: GET /products, POST /products, POST /products/:id,
                                  POST /products/:id/deactivate, POST /products/:id/activate --
                                  full Product CRUD, session-authenticated
      failedEvents.js            FR-701: GET /failed-events -- read-only list of recorded failures
      health.js                  GET /health
    middleware/requireAuth.js   session gate for the dashboard (reused by whatsappPair.js,
                                 settings.js, products.js, and failedEvents.js)
    utils/
      signature.js               X-Hub-Signature-256 verification
      logger.js                  structured console logging
    views/
      login.ejs                 server-rendered dashboard (EJS, no SPA — TD-003) -- UNCHANGED
      partials/nav.ejs           FR-701: shared nav bar (Leads/Products/Failed Events/Pairing),
                                  included at the top of every authenticated view below
      leads.ejs                 server-rendered dashboard; now also shows the auto-reply ON/OFF
                                 toggle at the top (auto-reply toggle change), the matched product
                                 name under a Lead's Q1 answer, a "Needs review" badge for
                                 low-confidence/unmatched Q1 answers (FR-503/FR-504), and the nav
                                 bar (FR-701)
      products.ejs               FR-702: Product CRUD page -- add/edit/deactivate/reactivate,
                                  nav bar at top
      failedEvents.ejs           FR-701: read-only Failed Events list, nav bar at top
      whatsappPair.ejs           pairing screen: QR / connected / reconnect-needed states,
                                  ban-risk disclosure (NFR-303); now also shows the nav bar (FR-701)
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
