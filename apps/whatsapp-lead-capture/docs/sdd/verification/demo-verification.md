# Demo Verification (T-012, Phase R)

Rehearsal of the happy-path demo described in the Definition of Done:
customer message → auto-reply → qualifying questions → lead appears in
dashboard → owner marks it responded.

## How this rehearsal was run

**Important caveat:** this rehearsal was scripted (`curl` calls against a
locally running instance of the app, plus one Node one-liner to read the
assigned lead ID from SQLite) rather than a human clicking through a real
WhatsApp conversation and a real browser session. There is no real Meta
WhatsApp Business account/credentials in this environment (see
`app/README.md`), so the "customer message" steps are simulated Meta
webhook payloads, not actual WhatsApp messages. This proves the
application-side logic and timing; it does **not** prove Meta's actual
delivery latency, which is outside this build's control anyway.

Environment: fresh SQLite DB (freshly migrated), server started with
`npm start`, `WHATSAPP_APP_SECRET` left unset for this local rehearsal (so
signature verification is skipped — see README; a real deployment would
always have Meta's actual app secret configured and signature verification
active).

## Steps and timing

| Step | Action | Result |
|---|---|---|
| 1 | Simulated customer sends first WhatsApp message ("halo, baju ini masih ada?") via `POST /webhook` | `200 {"status":"received"}`; Lead created (`status=new`) |
| 2 | Simulated customer answers Q1 ("Kaos Rimba Navy") | Lead's `question1_answer` saved |
| 3 | Simulated customer answers Q2 ("Size M, WA aja") | Lead's `question2_answer` saved |
| 4 | Owner logs into the dashboard (`POST /login`) | Session established, redirected to `/leads` |
| 5 | Owner views `/leads` | Lead visible with phone number, both Q1/Q2 answers, status `new` |
| 6 | (script reads the lead's DB id to build the status-update URL — a real owner would just click the button next to the row) | — |
| 7 | Owner marks the lead "responded" (`POST /leads/:id/status`) | `302` redirect, status persisted as `responded` on reload |

**Total scripted elapsed time: under 1 second** (steps 1-7 ran back-to-back
with no artificial delay). This comfortably satisfies the DoD's "under 5
minutes" bar; the real-world bottleneck in an actual demo would be a human
narrating each step out loud and clicking through a real WhatsApp app and
browser, not the system's own processing time.

Outbound replies (ack, Q1 text, Q2 text, completion message) were attempted
against the real Meta Graph API client with placeholder/fake credentials
(no real Meta account available) and, as expected, failed at the network/
auth layer — each failure was caught and recorded as a `FailedEvent` row
(3 rows for this run), while the webhook still returned `200` and the Lead
record was created/updated correctly in all cases. This is the exact
behavior TD-004 and NFR-002 specify, and incidentally doubles as a live
demonstration of the failure-logging path (T-011) using a completely
different fault (real Meta auth failure) than the deliberately malformed
payloads used in the automated test suite.

## Result

- FR-001–FR-003, FR-005, FR-006, FR-007 (partially — see below), FR-008:
  confirmed working end-to-end in this rehearsal.
- NFR-002: confirmed — 3 FailedEvent rows created, 0 requests returned a
  non-200 status, no Lead data lost.
- The happy-path demo finishes well under 5 minutes.

## Not covered by this rehearsal

- FR-004 (owner notification) — the "new lead" visual flag on the
  dashboard was visually confirmed separately (see `app/README.md` /
  `src/views/leads.ejs`), not re-checked in this specific timed run.
- FR-007's fallback path (customer sends an unrecognized message) —
  covered by automated tests (`tests/webhook.test.js`) and an earlier
  manual `curl` smoke test, not repeated in this specific timed rehearsal
  since it's a secondary path, not the happy path the DoD asks to be timed.
- Any real Meta WhatsApp delivery timing (NFR-001's "5 seconds" is measured
  from Meta's webhook call to this app's reply call being issued, which is
  near-instant in all runs; actual delivery time to the customer's phone is
  Meta's infrastructure, outside this app's control and not testable here).
