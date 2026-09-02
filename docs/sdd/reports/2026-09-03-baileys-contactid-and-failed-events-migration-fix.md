# SDD Pipeline Verification Report — Baileys `contactId` regression + `failed_events` migration gap

**Scope**: two production-breaking bugs found by an independent 8-agent adversarial review of the full `002-telegram-multichannel` history (`5e6a262..HEAD`), fixed same-day. Not a new feature — a post-review correctness fix.

## SDD Pipeline Verification Report

**Verdict: PASS** — Confidence: HIGH

### Checks run
- Types: SKIPPED — no type checker configured (plain JS, no `tsconfig.json` anywhere in the repo)
- Tests: PASS — 213/213 passed (up from 211 baseline; 2 new regression tests), `npx turbo run test --force` (cache bypassed), 5/5 turbo tasks green
- Lint: SKIPPED — no ESLint/linter configured in the repo
- Spec conformance: PASS — mechanical traceability check (`check-traceability.mjs`) went from 14 problems (7 spine orphans, 2 broken refs, 5 freelance tickets) to 0; see "Key decisions" below
- Security: PASS — no new attack surface; see judgment block
- Performance: PASS — static scan only (no REQ-NF performance case exists for this fix). `ensureFailedEventsColumns()` runs one `PRAGMA table_info` + at most one `ALTER TABLE` per DB open, not per-request — same cost class as the existing `ensureLeadsColumns()` it's modeled on. No loops, no N+1, no unbounded structures introduced.
- Adversarial: PASS — targeted, not generic. Both fixes are "stale schema state" / "hand-assembled contract" bug classes, so the adversarial case that matters is "reopen a real on-disk DB created before this column/rename existed" — that's exactly what the 2 new tests in `dbMigration.test.js` do (real temp file via `fs.mkdtempSync`, not `:memory:`, which can't simulate this at all). Generic boundary/injection/auth test categories don't apply to a two-file contract-and-migration fix.

### What was fixed
1. **`packages/whatsapp-connector/src/baileysConnector.js:478`** — still passed `phoneNumber` into the shared `processInboundMessage()` contract after TICKET-1302 renamed the destructured param to `contactId`. Every inbound WhatsApp message in Baileys mode (`WHATSAPP_MODE=baileys`) silently failed: `contactId` was `undefined` → `leadsRepo.findByContact(undefined, ...)` never matched → `INSERT` hit the `NOT NULL CHECK (length(contact_id) > 0)` constraint → caught and swallowed into a `FailedEvent`, no lead ever created, no reply ever sent. Fixed by renaming the key; also fixed the two test assertions in `baileysConnector.test.js` that had locked in the wrong field name (they asserted `calls[0].phoneNumber`, which is exactly why this shipped silently — no test exercised the real, renamed contract).
2. **`apps/lead-capture/src/db/index.js`** — `ensureLeadsColumns()` backfills columns added to `leads` after its original `CREATE TABLE`, for any pre-existing on-disk DB file, but no equivalent existed for `failed_events.channel` (added by the earlier Baileys dual-mode change). `failedEventsRepo.record()` unconditionally binds `channel` on every insert, so an operator reopening a real pre-existing `data/leads.db` would get `no column named channel` on every failure-recording attempt — silently losing FailedEvent rows. Added `ensureFailedEventsColumns()`, called alongside `ensureLeadsColumns()`.

### Review Guide

**Review order** (most critical first):
1. 🔴 `packages/whatsapp-connector/src/baileysConnector.js:478` — one-line key rename (`phoneNumber` → `contactId: phoneNumber`) in the call that drives lead creation from every inbound Baileys WhatsApp message.
   VERIFY: this is the *only* thing that changed — the value itself (the JID-derived phone number) is untouched, only the key it's passed under.
   RISK: if this key doesn't match `inboundMessageProcessor.js`'s destructured param name, the entire Baileys channel silently breaks again (as it just did) with no crash, no log line pointing at the real cause — only a generic `baileys_message_processing_failed` FailedEvent.
   COVERED BY: `packages/whatsapp-connector/test/baileysConnector.test.js` (updated assertions, lines ~350/356).

2. 🟡 `apps/lead-capture/src/db/index.js` — new `ensureFailedEventsColumns()` function + its call site.
   VERIFY: matches the existing `ensureLeadsColumns()` pattern exactly (idempotent column-existence check before `ALTER TABLE`); default value (`'whatsapp_cloud_api'`) matches `schema.sql`'s own `CREATE TABLE` default and `failedEventsRepo.js`'s `record()` default, so pre-existing rows and the static schema stay consistent.
   COVERED BY: `apps/lead-capture/tests/dbMigration.test.js` (new) — reopens a real on-disk pre-existing `failed_events` table missing the column, confirms the column is added AND that a real insert through the migrated table succeeds.

3. 🟢 `docs/sdd/traceability.md` + 5 ticket files' `**Refs**` lines — mechanical hygiene only (added missing FSD/SEC/ADR ID citations in the format the traceability checker recognizes). No behavior change, no new claims — every added reference points at something that was already true (e.g. TICKET-1301 always was a consequence of ADR-001's scoping decision, it just wasn't cited in the recognized `TYPE-NNN` format before).

**Spec coverage**: mechanical traceability check now 0/0 problems (was 14). No FSD/SDS/ERD/SEC content changed — only citation formatting.
**Test coverage for 🟡 items**: 2/2 new tests cover both migration paths (leads rename+channel-add, failed_events channel-add) against a real on-disk file.
**Unreviewed from prior task**: none — the prior task (deep review + repo cleanup) was reviewed and acted on directly in this task.

### You should verify (top 2-3)
1. **Decide whether to also test the full `createBaileysConnector` → real `createInboundMessageProcessor` wiring end-to-end** (not just the param name) — the review noted no test anywhere wires the *real* Baileys connector to the *real* processor (only mocks, or `webhook.js`'s Cloud API path). This fix closes the specific bug found, but the structural gap that let it ship (three independent hand-assembled call sites for one shared contract, per the reuse-audit finding) is still open. Worth a follow-up ticket if you want to prevent the next rename from doing this again.
2. **Confirm you're fine with the `data/leads.db` file on this machine never actually having hit the pre-`channel`-column state** — the fix is verified against a *simulated* legacy schema (built by hand in the test), not against your actual real file, because your real file was likely created after both columns already existed. If you have an older backup of `data/leads.db` lying around from before 2026-09-01, worth a quick manual `PRAGMA table_info(failed_events)` on it to be extra sure.

### Not tested (blind spots)
- **The structural fix** (a shared adapter/contract type across all 3 channel call sites, so a future rename can't silently skip one) — out of scope for this task, flagged by the earlier deep review as a separate finding, not fixed here.
- **Live Telegram/Baileys traffic** — no real WhatsApp number or Telegram bot was exercised; all verification is against the test suite and a hand-built legacy-schema simulation.

### Key decisions
- **Traceability matrix fixes were mechanical, not editorial**: the checker flagged 14 problems, all caused by (a) two documentation phrasing choices that didn't match the tool's exact skip/ID-format conventions (a historical ticket-range mention, and "Next available ID" vs. the tool's expected "Next free" phrasing), and (b) five tickets whose `**Refs**` lines cited upstream docs in prose (`FSD Flow 3`, `SDS §"..."`) without the tool-recognized `TYPE-NNN` format. Every fix added a real, already-true citation — nothing was re-scoped or reinterpreted.
- **`SDS`/`ERD` alone don't satisfy the "traces to upstream" check** even though they're recognized ID types — the tool's `UPSTREAM` set is deliberately narrower (`REQ`/`REQ-NF`/`FSD`/`SEC`/`ADR` only). TICKET-1301 and TICKET-1304 needed an `ADR-001` citation specifically (not just `SDS-002`) to satisfy this — chosen because both tickets are genuinely direct consequences of ADR-001's scoping decision, not an arbitrary satisfy-the-linter citation.

---

## Impact Summary (SDD Pipeline this session)

- 2 production-breaking/silent-data-loss bugs caught and fixed (1 cross-package contract drift, 1 schema-migration gap) — both found by independent multi-agent adversarial review, not by the original implementation's own tests
- 2 regression tests added, both exercising a real on-disk DB file (a test-environment gap — the entire prior suite only ever used `:memory:` — that let the second bug ship undetected)
- 14 traceability problems resolved (7 spine orphans, 2 broken refs, 5 freelance tickets) — matrix now mechanically consistent
- 1 stale standalone repo deleted after confirming zero unique history (full history already preserved in this monorepo via TICKET-1301's `git mv`)
- Files changed: 9 (8 modified, 1 created)
