# WhatsApp Lead Capture & Auto-Responder

## Simulated Business Case

This is a concept/simulated project built to demonstrate a real freelance service. "Rimba Apparel" is a fictional business created for this purpose — no real client, revenue, or testimonial is implied anywhere in this document.

## The Business Context

Rimba Apparel is a 2-person apparel seller (owner + one part-time helper) that markets on Instagram and takes all actual orders through a single personal WhatsApp number, replied to manually by the owner between other tasks.

## The Problem

WhatsApp is being used as a raw chat tool, not a lead-capture channel. Replies are slow — sometimes hours late, sometimes never sent — because everything depends on the owner noticing a notification in a busy chat list.

## Why It Matters

After a marketing post drove a spike in inquiries, dozens of WhatsApp messages went unanswered for over a day, and several customers said "nevermind" once they finally got a reply. The business's own marketing success was actively working against it: the busier it got, the worse its response time became, and the more leads silently disappeared with no record they ever existed.

## The Old Workflow

Customer messages → sits unread in a busy chat list → owner eventually sees it, often hours later → owner types a fully manual reply, even for repeat questions ("is this in stock," "how much is shipping") → if the message gets buried, no reply is ever sent → no record of the interaction exists anywhere outside the raw chat thread.

## The Solution

An official WhatsApp Business Cloud API integration that:
- Acknowledges every inquiry instantly, and clearly identifies itself as automated (no pretending to be a human)
- Asks two qualifying questions (product interest, then a follow-up) so the owner has real context to follow up with
- Logs every inquiry as a structured lead record — even ones that don't fit the expected flow — so no lead depends on a notification being seen in time
- Notifies the owner of new leads via a simple dashboard, with a status workflow (`new` → `responded` → `closed`)

## Key Features

- Instant, self-identifying auto-reply on first contact
- Two-question qualification flow with a one-retry-before-fallback safety net (a customer who sends something unexpected gets asked once more before the system hands off to "a human will follow up")
- A plain-language dashboard for a non-technical owner — no jargon, no training needed
- Every processing failure (a malformed event, a failed Meta API call) is captured as a logged, reviewable record instead of silently disappearing — the same "monitored integration" principle this entire freelance positioning is built on, demonstrated even in the smallest possible project

## Technical Architecture

A single small Node.js/Express service handles both the public WhatsApp webhook and the owner-facing dashboard — no microservices, no message queue, no SPA framework. SQLite stores two tables (`Lead`, `FailedEvent`); the dashboard is server-rendered EJS; the qualifying-question script lives in an external config file so it can be changed per client without a code change. Full detail: `docs/sdd/design/technical-design.md`.

This proportionality is deliberate, not a shortcut: a 2-person business doesn't need Kubernetes, and over-architecting a lead-capture tool would be a worse signal in a freelance portfolio than the plain, working system that's actually here.

## Technical Challenges

- **Webhook idempotency vs. Meta's retry behavior:** if the webhook ever returned a non-200 on internal failure, Meta would retry the same event and risk duplicate leads/replies. Resolved by always returning 200 and routing failures into a separate `FailedEvent` log instead (see TD-004 in the technical design) — verified with an adversarial test that traces a body-parser-level failure (invalid JSON) through the same path, not just the "well-formed but semantically bad" case.
- **A real independent review caught two spec/code mismatches** (FR-002's promised retry-before-fallback wasn't built yet; FR-007's spec text named a case — "an unrelated question" — that would require NLP to detect and was never actually in scope). Both were resolved properly: FR-002 got a real retry implementation, and FR-007's spec text was corrected to match the deliberately narrower, honest scope, with an explicit cross-reference to why (semantic relevance detection is a "MAYBE LATER" item, not silently dropped). Full detail: `docs/sdd/review/portfolio-review.md`.
- **A security fail-open gap** — signature verification against Meta's webhook payload was implemented correctly but was silently skippable if one environment variable was left unset. Fixed by making that variable a hard boot requirement, matching how the other secrets are already enforced.

## Important Decisions

Full rationale for every major technical choice — including two rejected alternatives per decision — is documented in `docs/sdd/design/technical-design.md` (TD-001 through TD-004): Node/Express over a no-code tool (portfolio ownership), SQLite over Postgres (proportional to actual data volume), server-rendered EJS over a SPA (matches the plain-usability requirement, avoids needless build complexity), and "webhook always returns 200" over "return an error code on failure" (prevents Meta's retry behavior from creating duplicate leads).

## Pricing-Tier Flexibility: Official API vs. Baileys

Added after the initial build (`docs/sdd/changes/2026-09-01-baileys-dual-mode.md`): the WhatsApp connector now supports two interchangeable modes behind one shared interface — the official Meta Cloud API (recommended default, zero ban risk, but needs Meta Business verification and per-message cost) and Baileys (an unofficial, reverse-engineered connection method, free and instantly set up on an existing number, at the cost of a real — though usage-pattern-dependent — ban risk). This exists specifically for a client not yet ready to invest in the official API's setup friction and cost, with the ban-risk trade-off disclosed in plain language directly on the pairing screen, not just buried in documentation.

Because the state machine, database, and dashboard were already built behind a clean adapter boundary, adding Baileys required touching zero business logic — only a new adapter module and a pairing screen. The Baileys path also needed real reconnection engineering: automatically recovering from ordinary network drops with exponential backoff, while correctly recognizing several genuinely permanent failure states (logged out, re-paired to another device, a corrupted session, or the number being blocked) and surfacing those clearly instead of retrying forever. An independent review initially caught a real gap here — three of those permanent-failure cases were being silently retried forever with a false "no action needed" message — which was fixed and re-verified before this was called done. Full detail: `docs/sdd/review/baileys-dual-mode-review.md`.

This directly strengthens the freelance pitch: it's not "here's a WhatsApp bot," it's "here's a WhatsApp bot with an honest, explained choice between free-but-risky and paid-but-safe, backed by a real answer to 'what happens if the connection drops.'"

## Before vs After

| | Before | After |
|---|---|---|
| First response time | Hours, sometimes never | Seconds, always |
| Lead record | None — lives only in the raw chat thread | Structured record with timestamp, answers, status |
| Visibility for the owner | Must personally see each chat notification | Single dashboard, sorted most-recent-first |
| What happens when a message doesn't fit the script | N/A (no script existed) | One retry, then an honest "a human will follow up" — never silently dropped |
| What happens when something breaks | N/A | Logged as a reviewable event, not a silent failure |

## What the Project Demonstrates

This directly proves the **Entry Service** from the freelance positioning: "WhatsApp Auto-Responder & Lead Capture Setup" (official WhatsApp Business Cloud API, not a shortcut that risks the client's number). It's the smallest sellable slice of the **Primary Niche** — API & Systems Integration for WhatsApp-first small businesses — and specifically demonstrates the Primary USP in miniature: a monitored integration with a documented handover, not a one-time script that quietly breaks. It also demonstrates something a generic "I built a chatbot" portfolio piece can't: a documented instance of a specification catching real implementation gaps before they reached a client, and those gaps being closed transparently rather than hidden — which is itself part of the pitch to a prospective client evaluating whether this freelancer's delivery process can be trusted.

## Future Expansion

The natural next step for a real client on this system is exactly Project 2 (Connected Orders System) — once WhatsApp leads are flowing reliably, the next real pain point is connecting them to whatever the client uses to track orders (a form, a spreadsheet, a CRM), which this project's data model and integration pattern extend directly into rather than replace.
