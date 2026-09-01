# GitHub Portfolio Strategy — Project 1

## Repository Name
`whatsapp-lead-capture` (or `rimba-apparel-whatsapp-lead-capture` if disambiguation against Projects 2/3 is wanted in a multi-repo layout)

## README Structure
1. One-line headline (from `sales-assets.md` #1) + a "Concept/Simulated Project" badge or bold notice at the very top — the honesty disclosure must be the first thing anyone sees, not buried.
2. **The Problem** — 2–3 sentences from `portfolio-case-study.md`'s "The Problem"/"Why It Matters," written for a non-technical reader (a prospective client), not a developer.
3. **The Solution** — what it does, in plain language, before any tech stack talk.
4. **Architecture diagram** — the Phase H sequence diagram (Mermaid renders natively on GitHub) plus a one-paragraph explanation of why the stack is intentionally small (TD-001–TD-004 summarized, not pasted in full).
5. **Key Features** — bulleted, from the case study.
6. **Tech Stack** — Node.js, Express, SQLite, EJS, WhatsApp Business Cloud API — each with a one-line "why" (pulled from the Phase J table), not a bare badge list.
7. **Setup Instructions** — from `app/README.md` (env vars, `npm install`, `npm run migrate`, `npm start`, `npm test`).
8. **Demo Instructions** — how to run the scripted rehearsal locally (referencing `docs/sdd/verification/demo-verification.md`), plus an honest note that live WhatsApp round-trip requires a real Meta developer account.
9. **Screenshots Needed** (see below).
10. **Case Study Link** — link to `portfolio-case-study.md` for the full narrative.
11. **What This Demonstrates** — 2–3 sentences directly naming the freelance service this proves (from `service-mapping.md`), so a visiting prospective client doesn't have to infer it.

## Project Description (GitHub "About" field, ~140 chars)
"Concept project: official WhatsApp Business API auto-responder + lead capture for small sellers. Node.js/Express/SQLite, monitored & documented."

## Problem Statement (for README section 2)
"WhatsApp-first small sellers lose leads because there's no system between 'a customer messages' and 'someone follows up' — this concept project fixes that with an instant, official-API auto-responder that never silently drops an inquiry."

## Architecture Diagram
Reuse the Phase H Mermaid sequence diagram from `docs/sdd/design/technical-design.md` directly — GitHub renders Mermaid natively in Markdown, no image export needed.

## Setup Instructions
Point to `app/README.md` rather than duplicating it — keep one source of truth for env vars and commands.

## Demo Instructions
Two tiers, clearly labeled:
- "Run it yourself" (local, scripted, no real WhatsApp account needed) — matches the rehearsal in `demo-verification.md`.
- "See it against real WhatsApp" — explicitly marked as **not verified in this environment** (no Meta developer account available), with instructions for what a real deployment would additionally need (a Meta app, a test phone number, `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`).

## Screenshots Needed
1. The lead dashboard with 2–3 seeded example leads (different statuses visible: `new`, `responded`, `closed`)
2. The login screen
3. A terminal screenshot of the `npm test` run showing 61 passing tests (concrete, verifiable proof — stronger than a claim in prose)
4. (Optional, if a real Meta test number is ever set up) an actual WhatsApp conversation screenshot showing the acknowledgment + two questions

## Case Study Link
`./portfolio-case-study.md` (relative link from the README)

## Technology Explanation (for README section 6, one line each)
- **Node.js + Express** — one small, readable codebase for both the webhook and the dashboard; matches the JS-centric tooling most small-business automation work already uses.
- **SQLite (`better-sqlite3`)** — zero infrastructure for the actual data volume of a small business; intentionally not Postgres, which would be disproportionate here (see Project 2/3 for where that changes).
- **EJS (server-rendered)** — the dashboard is a list and a status toggle; a full SPA framework would add build complexity with no user-facing benefit for a non-technical owner.
- **WhatsApp Business Cloud API (official)** — the only channel the client actually uses; "official API" is itself part of what differentiates this from a cheap/unofficial-shortcut chatbot gig.

## Sales Note
The README should read as a case study a client could stumble onto directly — every section title above deliberately leads with the business problem, not the tech stack, per the whole positioning's guiding principle: "this developer understands a business problem similar to mine," not just "this developer knows Node.js."
