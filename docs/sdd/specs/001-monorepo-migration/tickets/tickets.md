# Ticket Breakdown — Monorepo Migration

```
TICKET-1101 (Turborepo skeleton)
    └─▶ TICKET-1102 (git-history migration of Project 1 into apps/)
            ├─▶ TICKET-1103 (extract packages/humanized-timing)
            ├─▶ TICKET-1104 (extract packages/whatsapp-connector)
            └─▶ TICKET-1105 (extract packages/product-matcher)
                    └─▶ TICKET-1106 (wire app to packages, dedupe, full re-verify)
                            ├─▶ TICKET-1107 (extraction script + secret-guardrail test)
                            └─▶ TICKET-1108 (Turborepo caching verification)
ALL ─▶ TICKET-1109 (migration report)
```

| Ticket | Coverage | Description | Acceptance | Verification |
|---|---|---|---|---|
| **TICKET-1101** | FR-1101 | Root `package.json` (npm workspaces: `apps/*`, `packages/*`), `turbo.json` with `dev`/`test`/`build` pipelines | `npx turbo run test` works from root (even with nothing in it yet) | Manual run |
| **TICKET-1102** | FR-1102, NFR-1102 | `git subtree add --prefix=apps/whatsapp-lead-capture <path-to-project-01> master` (or equivalent), preserving history | `git log --follow` on a file under the new path shows pre-migration commits | `git log --follow -- apps/whatsapp-lead-capture/app/src/services/stateMachine.js` shows all prior commits touching that file |
| **TICKET-1103** | FR-1103 | Move `humanizedTiming.js` + its tests into `packages/humanized-timing`, own `package.json`, exported functions unchanged | Package's own test suite passes in isolation | `cd packages/humanized-timing && npm test` |
| **TICKET-1104** | FR-1104 | Move `baileysConnector.js` + `metaClient.js` into `packages/whatsapp-connector`, uniform interface exposed regardless of mode, pairing UI stays in the app | App's WhatsApp-related tests pass against the packaged version, no behavior change | Full app test suite + package's own isolated tests |
| **TICKET-1105** | FR-1105 | Move `productMatcher.js` into `packages/product-matcher`, confirm/clean the `(text, products[], options)` interface, no DB dependency inside the package | Package's own test suite (denylist, ambiguity, all 4 prior bug-fix regression tests) passes in isolation | `cd packages/product-matcher && npm test` |
| **TICKET-1106** | FR-1103–1105, NFR-1101, NFR-1103 | App's `package.json` depends on all 3 packages via `workspace:*`; remove the now-duplicated source from the app; re-run the FULL 276-test suite | 276/276 pass, identical count, no weakened assertions. *(Superseded by a post-build review fix: TICKET-1106 as originally executed still had 4 app-side test files — `humanizedTiming`/`baileysConnector`/`metaClient`/`productMatcher`.test.js, 78 tests — that were byte-for-byte duplicates of the packages' own tests, reintroducing `natural`/`@whiskeysockets/baileys` as app devDependencies purely to support them. Fixed: those 4 files deleted from the app (the packages already own this coverage in isolation per NFR-1103), and the two now-unused devDependencies removed. App's own count is now 199 (its genuine integration/wiring tests); combined with the 3 packages' own suites (10+32+35), the total is still 276, each test owned exactly once.)* | Full suite run from both root (`turbo run test`) and app-only |
| **TICKET-1107** | FR-1106, FR-1107 | `scripts/extract-app.js`: copy app + vendor its package dependencies' source, rewrite `package.json`, exclude `.env`/`data/`/credentials | Extracted output `npm install && npm test` passes standalone; a planted fake secret file is confirmed absent from output | Run the script, inspect output, run its tests independently |
| **TICKET-1108** | NFR-1104 | Verify Turborepo's dependency graph is declared correctly (app depends on all 3 packages) | Changing only one package's source and running `turbo run test` re-runs that package + the app, nothing unrelated | `turbo run test --dry-run` / actual run with a trivial source touch |
| **TICKET-1109** | DoD | Migration report | Test counts before/after, history-preservation proof, extraction-script demo output, any judgment calls | Written report |

**Build order**: 1101 → 1102 → {1103, 1104, 1105} → 1106 → {1107, 1108} → 1109. Tickets 1103/1104/1105 can be done in any order relative to each other once 1102 is done, but 1106 needs all three finished first.
