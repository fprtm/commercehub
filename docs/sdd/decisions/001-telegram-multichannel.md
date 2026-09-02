# Decision 001: Add Telegram as a Second Channel Into the Existing App (Not a New App)

**Status:** Settled via SDD Grill (fork questions + abbreviated council), rule-of-three gate passed (hard to reverse: channel-abstraction shape; surprising: moderately; real trade-off: build time now vs. deferred, raw HTTPS vs. library)

## Context
The Baileys WhatsApp connector carries real, documented ban/restriction risk (see `docs/sdd/changes/2026-09-02-reconnect-throttle.md` — the mitigation just built after a real test-number restriction). Telegram's Bot API is official/first-party (registered via BotFather, published rate limits, no "linked device" concept), so it carries none of that risk profile. The repo was already named channel-neutral ("commercehub", not "whatsapp-hub") in anticipation of exactly this.

## Decision
1. **Scope**: Telegram is added to the *same* app (`whatsapp-lead-capture`) as a second channel, not a new standalone app. Leads/business logic (state machine, product matcher, humanized timing, lead persistence) are shared; only the connector differs per channel. A `channel` attribute is added to the Lead entity so the same DB/app tells WA leads and Telegram leads apart.
2. **DB**: stays app-scoped, one SQLite file per app (`better-sqlite3`) — not shared across apps, not split per channel. This isn't a new choice, it's a direct consequence of the already-settled extraction-script delivery model (Decision 001 in `portfolio-projects/docs/decisions/`): an app must remain independently extractable, which a cross-app or external shared DB would break.
3. **Integration approach**: raw HTTPS + long polling, zero new dependency — mirrors `metaClient.js`'s existing pattern (Cloud API is also raw HTTPS, no SDK) rather than adopting a library (telegraf / node-telegram-bot-api). Long polling chosen over webhook so Telegram mode needs no public HTTPS endpoint, keeping it as zero-infra as Baileys mode — consistent with this project's budget-UMKM positioning.
4. **Package**: new `@rimba/telegram-connector`, sibling to `@rimba/whatsapp-connector`. Exact interface contract (method shapes, how it composes with `inboundMessageProcessor`) is HOW, not WHICH — deferred to `/sdd-pipeline:spec`.
5. **Secondary motivation, independent of customer adoption**: because Telegram carries no reconnect-ban risk, it doubles as a safe dev/testing channel for this project's own iteration — avoids burning real WhatsApp numbers during dev-server churn testing (the direct cause of the recent 6-hour restriction).
6. **Timing**: now, sequenced immediately after the reconnect-throttle change is independently reviewed and confirmed passing (not built in parallel with it).

## Council (abbreviated — fork questions had already resolved most fog)

| Seat | Objection | Response |
|---|---|---|
| Devil's advocate | Reconnect-throttle for WA just barely landed — why add a new channel before proving that fix holds up in real usage? | **Accepted, reframed**: sequenced strictly after independent review passes, not parallel. Also reframed as partly defensive: throttle only *reduces* WA risk per its own spec, it doesn't eliminate it — Telegram gives a genuinely risk-free channel for the project's own testing regardless of customer adoption. |
| Maintainer, 1 year later | Adding a 3rd channel later (e.g. Instagram DM) without a deliberately-designed abstraction now could force a painful refactor | **Accepted**: exact connector interface contract explicitly deferred to `/sdd-pipeline:spec`, not designed ad hoc mid-build. This ADR settles WHICH (same app, own package, raw HTTPS) not HOW. |
| Security | Telegram bot token is a new credential, same class of risk as WA/Meta credentials | **Accepted**: must follow the same `.env`-only, never-hardcoded, `.gitignore`-covered pattern already enforced for existing credentials. Flagged for build-time verification. |
| The bill | Raw HTTPS + long polling means hand-writing retry/backoff/offset-tracking instead of getting it free from a library | **Accepted as worth it**: same trade already made for `metaClient.js`, so the pattern is proven in this codebase; avoids a fresh dependency-security-audit cycle (the exact overhead paid for Baileys earlier). |
| The end user (UMKM client) | Real customer base in Indonesia is overwhelmingly WhatsApp — Telegram support may go unused by actual clients | **Accepted as open risk, not blocking**: the dev/testing-safety payoff is independent of customer adoption, so the decision has value even if customer-side Telegram usage turns out to be zero. |

## Whole-picture check
Given the reconnect-throttle pattern already proven in this codebase (raw HTTPS, injectable clock, pure-function core, package-level tests) and the fact this mirrors an existing connector's shape rather than inventing a new one, the scope is buildable in comparable effort to the throttle change itself. No scope reduction needed.

## Consequences
- Next step is `/sdd-pipeline:spec` for the HOW: `@rimba/telegram-connector`'s exact interface, how `server.js`/`inboundMessageProcessor.js` route by channel, and the Lead schema migration adding `channel`.
- Project 2/3 (standalone, unmigrated) are unaffected — this only touches the monorepo app.
