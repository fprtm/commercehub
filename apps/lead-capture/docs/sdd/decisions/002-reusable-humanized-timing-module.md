# Decision 002: Humanized-Timing Built as a Standalone, Reusable Module

**Status:** Settled (rule-of-three: real trade-off between speed-of-build and future reusability, moderately hard to reverse once other code depends on the shape)

## Context
The humanized-timing feature (read delay, typing-simulation, periodic typing-indicator refresh) is not conceptually tied to WhatsApp lead capture specifically — it's a generic "make an automated messaging flow feel human-paced" capability that is plausibly reusable in Project 2/3 or other future automation work (e.g., the Secondary Niche's AI-automation offer).

## Decision
Build it as a self-contained module with a clean, transport-agnostic interface — not baked directly into `metaClient.js` or `baileysConnector.js`. It should accept generic inputs (message text, a "send typing indicator" callback, a "mark as read" callback, a "send message" callback) and own all timing/orchestration logic internally, so a caller only needs to supply thin transport-specific callbacks.

## Consequences
- Slightly more upfront structuring effort than inlining the delay logic directly into the existing WhatsApp send paths.
- Pays off if/when Project 2, Project 3, or a future AI-automation project needs the same "don't respond instantly, feel human" behavior — reused, not rebuilt.
- The module's own tests should be transport-agnostic (mock callbacks), separate from WhatsApp-specific integration tests.
