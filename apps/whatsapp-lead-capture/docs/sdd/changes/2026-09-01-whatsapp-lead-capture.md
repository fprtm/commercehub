# Change: WhatsApp Lead Capture & Auto-Responder

**Status:** AWAITING APPROVAL (specification gate — do not proceed to design/build until approved)
**Size:** small (per SDD Pipeline task-size detection: single workflow, single integration, < 3 core components)
**Mode:** standard (approval required before BUILD; this is a portfolio proof asset, not a throwaway prototype, so the discipline of a real client engagement is intentionally kept)
**Domain:** web (backend webhook service + a small dashboard)
**Relates to:** `../../../business-simulation.md` (Rimba Apparel, simulated business case)

This file folds PLAN + the THINK-phase discovery record into one artifact, per SDD Pipeline's small/medium convention (no separate PRD exists at this size).

---

## Product Vision

Rimba Apparel — and businesses like it — sell primarily through WhatsApp but treat it as a raw chat tool instead of a lead-capture channel, silently losing sales whenever a reply is slow or a message gets buried. This project delivers the smallest possible fix: an official WhatsApp Business API auto-responder that acknowledges every inquiry instantly, asks two qualifying questions, and logs every lead into a simple dashboard the owner can actually check — so no lead depends on the owner seeing a phone notification in time.

## Problem Statement

WhatsApp-first small sellers lose leads because there is no system between "a customer messages" and "someone follows up" — replies depend entirely on one person's availability, and there is no record of inquiries that don't get an immediate reply.

## Target User

Two distinct users:
1. **The business owner** (Rimba Apparel's owner) — configures the qualifying questions, reviews captured leads, marks them as followed up.
2. **The end customer** (a person messaging the business's WhatsApp number) — receives the automated flow; does not use any dashboard.

## Primary User Goal

Owner: "I want to stop losing sales to slow WhatsApp replies, without having to watch my phone constantly."
Customer: "I want to know my message was received, even if I don't get a full human reply right away."

## Jobs To Be Done

"When a customer messages my WhatsApp about a product, I want them to get an instant, helpful acknowledgment and have their inquiry logged automatically, so I don't lose sales to slow replies without needing to watch my phone constantly."

---

## User Stories

- **US-001** — As a customer messaging the business's WhatsApp number, I want to receive an immediate acknowledgment, so that I know my message was received even if the owner isn't available right now.
- **US-002** — As a customer, I want to be asked a couple of simple questions about what I'm interested in, so that the seller has useful context when they follow up.
- **US-003** — As the business owner, I want every WhatsApp inquiry automatically logged in one place, so that no lead depends on me seeing a chat notification in time.
- **US-004** — As the business owner, I want to be notified when a new lead comes in, so that I can personally follow up when it matters.
- **US-005** — As the business owner, I want a simple list of captured leads, so that I can review activity without digging through WhatsApp chat history.
- **US-006** — As the business owner, I want the auto-responder to clearly identify itself as automated, so that I don't mislead or frustrate customers expecting a real reply.

## Functional Requirements

- **FR-001** — When a customer sends a first-time message to the connected WhatsApp Business number, the system sends an automatic acknowledgment reply. *(Acceptance: reply is sent and visible in the WhatsApp thread within 5 seconds under normal operation — see NFR-001.)*
- **FR-002** — The system asks up to 2 sequential qualifying questions (product interest, then one follow-up such as size/preferred contact method) after the acknowledgment. *(Acceptance: both questions are sent in order, and the flow stops after the second answer or after one follow-up attempt if unanswered.)*
- **FR-003** — Each captured lead is stored as a record containing: customer phone number, timestamp of first message, answer to question 1, answer to question 2 (nullable), and status (`new` / `responded` / `closed`). *(Acceptance: a new record appears with all fields populated or explicitly null — never silently missing.)*
- **FR-004** — When a new lead record is created, the system notifies the business owner (dashboard indicator, minimum; email is a stretch within scope if time allows). *(Acceptance: notification is visible/received within 2 minutes of the lead being created.)*
- **FR-005** — The business owner can view a list of captured leads in a dashboard, sorted most-recent-first. *(Acceptance: list reflects the current database state on page load, no manual refresh trick needed.)*
- **FR-006** — The business owner can mark a lead as `responded` or `closed` from the dashboard. *(Acceptance: status change persists and is reflected on next page load.)*
- **FR-007** — If a customer's message doesn't *structurally* fit the expected qualifying-question flow (e.g., a non-text message type such as a sticker/image with no caption, or an empty/whitespace-only response), the system falls back to a message stating a human will follow up, and still logs the inquiry as a lead with status `new`. *(Acceptance: no message is ever dropped without creating a lead record.)* *(Note: judging whether an answer is semantically on-topic — e.g., flagging "an unrelated question" as not a real answer — requires natural-language understanding and is explicitly out of scope for this project; see "MAYBE LATER: AI-powered (LLM) dynamic qualifying questions" below. Any non-empty text response is accepted as a valid answer to the currently-pending question, structural fit only.)*
- **FR-008** — The first automated message explicitly identifies itself as automated (e.g., "This is an automated reply from Rimba Apparel..."). *(Acceptance: verified by inspecting the exact message copy sent.)*

## Non-Functional Requirements

- **NFR-001 (Performance)** — Auto-reply is sent within 5 seconds of receiving an inbound WhatsApp message under normal operation.
- **NFR-002 (Reliability)** — If the WhatsApp Cloud API webhook fails to process an inbound message, the failure is logged (not silently dropped) — this is the concrete mechanism behind the "monitored integration" USP from `portfolio-strategy.md`, demonstrated even in the smallest project.
- **NFR-003 (Security)** — WhatsApp API credentials are stored in environment variables, never committed to source control or exposed in client-side code; customer phone numbers are not exposed in any public-facing surface.
- **NFR-004 (Usability)** — The lead dashboard is understandable by a non-technical business owner without training: plain labels, no technical jargon, no unexplained icons.
- **NFR-005 (Maintainability)** — The qualifying-question script (which questions, in what order) is configurable without a code change (e.g., a small config file), since different real clients will want different questions — this directly demonstrates the "documented, adaptable delivery" part of the USP, not just a one-off hardcoded demo.

---

## Out of Scope

**NOT NOW** (explicitly excluded from this project, may belong to Project 2/3 or a real client engagement):
- Broadcast/marketing messages to multiple customers at once
- Multi-agent live-chat handoff to a human within WhatsApp itself
- CRM integration beyond the built-in lead dashboard (that's Project 2's problem)
- Multi-language auto-responder support
- Order/payment processing

**MAYBE LATER** (realistic future expansion, not built now):
- AI-powered (LLM) dynamic qualifying questions instead of a fixed script — natural bridge to the Secondary Niche (AI Process Automation)
- Additional channel (Instagram DM) alongside WhatsApp
- Basic conversion analytics (lead → responded rate)

**NEVER FOR THIS PROJECT** (would turn a portfolio proof asset into an unbounded SaaS product):
- Full CRM feature set (pipeline stages, multi-user roles/permissions, custom fields)
- Payment gateway integration
- Enterprise features: multi-tenant support, SSO, granular audit logging

---

## Definition of Done

- [ ] FR-001 through FR-008 implemented and manually verified against their stated acceptance criteria
- [ ] NFR-001 through NFR-005 verified (including a deliberate webhook-failure test for NFR-002)
- [ ] Demo script covering the happy path (customer message → auto-reply → qualifying questions → lead appears in dashboard → owner marks it responded) rehearsed and confirmed under 5 minutes
- [ ] Out-of-scope items confirmed NOT implemented (scope discipline check before calling this done)
- [ ] `portfolio-case-study.md` draft started referencing this change file

---

## Approval

This change file is the specification approval gate for Project 1, per SDD Pipeline's plan-approval flow for small-sized tasks. **Design (screens/flows), technical architecture, data model, API contracts, and task breakdown are intentionally not started yet** — those belong to the next phase (SPEC → PLAN → BUILD) and begin only after this scope is approved or amended.
