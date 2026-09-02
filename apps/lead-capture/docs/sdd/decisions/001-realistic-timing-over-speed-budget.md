# Decision 001: Prioritize Realistic Human-Like Timing Over the 5-Second Reply Budget

**Status:** Settled (rule-of-three: hard to reverse once clients expect this behavior, surprising relative to the original spec, real trade-off)

## Context
NFR-001 (original scope) required auto-replies within 5 seconds. A new requirement — human-like response delay (read-delay + typing-simulation scaled to realistic human typing speed) — was proposed specifically to reduce the "obviously a bot" signal that can contribute to spam/ban detection risk (connects to the earlier Baileys ban-risk discussion). For longer outgoing messages, fully realistic typing speed can take considerably longer than 5 seconds (potentially 15-30+ seconds).

## Decision
NFR-001 is **retired in its original form**. The system will use fully realistic human-like timing (read delay + typing-speed-proportional delay) rather than a capped/sped-up version, even when this means a customer waits significantly longer than 5 seconds for a substantive reply.

## Mitigation
The customer still gets an early signal that their message was received: a WhatsApp read receipt (blue check marks) is sent during the initial "read" delay phase, before the substantive reply is composed/sent. This preserves the core reassurance ("they saw my message") without requiring the actual text reply to be instant.

## Consequences
- A prospective client must be told plainly that responses are intentionally delayed and paced to look human, not instant — this is a deliberate trade-off (lower detection risk / more natural feel) traded against raw speed.
- The typing-indicator API (both Meta Cloud API and Baileys) auto-dismisses after ~25 seconds; the implementation must re-trigger it periodically for replies whose simulated typing time exceeds that window.
- This decision applies specifically to the *Baileys-relevant* framing (anti-detection); the same timing is applied uniformly to Cloud API mode too for a consistent, predictable experience, even though Cloud API doesn't carry ban risk — this was accepted as an intentional simplification (one shared module, not mode-specific timing behavior).
