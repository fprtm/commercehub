# Glossary

**Channel** — a distinct messaging surface an app can send/receive through (e.g. WhatsApp via Baileys, WhatsApp via Cloud API, Telegram). An app can support multiple channels at once; a Lead/Order record carries a `channel` attribute so the same business data model works regardless of which surface a customer messaged in on.

**Connector** — a package under `packages/` that implements the low-level "talk to one channel" concern (auth, send, receive, connection lifecycle if any) behind a send-oriented interface, decoupled from any app's business logic. Existing: `@rimba/whatsapp-connector` (Baileys + Cloud API dual-mode). New: `@rimba/telegram-connector`.
