'use strict';

const { decideNextAction, ACTIONS, hasUsableText } = require('./stateMachine');
const { log } = require('../utils/logger');
const { sendWithHumanizedTiming } = require('@rimba/humanized-timing');
const { matchProduct } = require('@rimba/product-matcher');

/**
 * TICKET-1302 (docs/sdd/specs/002-telegram-multichannel/erd.md): maps this
 * module's own `channel` param -- the finer-grained connector MODE
 * ('whatsapp_cloud_api' | 'whatsapp_baileys' today, used only for
 * logging/FailedEvent attribution, per FR-305 of
 * docs/sdd/changes/2026-09-01-baileys-dual-mode.md) -- onto the coarser
 * channel-FAMILY value the `leads.channel` DB column actually stores
 * ('whatsapp' | 'telegram', per erd.md). These are deliberately different
 * vocabularies: Decision 001 §1 treats "channel" as a Lead attribute
 * describing which messaging platform a contact used, not which connector
 * implementation handled it -- the mode distinction (Cloud API vs Baileys)
 * is purely a WhatsApp-side operational detail the Lead itself has no
 * reason to know about. Both WhatsApp modes therefore collapse to the same
 * family; any other value (e.g. 'telegram', once TICKET-1303's connector
 * starts calling in) is assumed to already be a valid family value and is
 * passed through unchanged -- this function's only job is normalizing the
 * two known WhatsApp-mode strings, not validating every possible input.
 *
 * @param {string} channel - the mode-specific value passed into
 *   `processInboundMessage()`.
 * @returns {string} the channel-family value to persist via
 *   `leadsRepo.create()`.
 */
function toLeadChannel(channel) {
  if (channel === 'whatsapp_cloud_api' || channel === 'whatsapp_baileys') return 'whatsapp';
  return channel;
}

/**
 * FR-901 (docs/sdd/changes/2026-09-02-fix-matching-safety-bugs.md, Bug 1,
 * safety-critical): matching only ever scores the ACTIVE product pool
 * (`productsRepo.listActive()`) -- so deactivating a product can silently
 * misroute a customer to a *different* active product that would have lost
 * (or tied into ambiguity) had the deactivated product still been in the
 * running. Concretely: deactivating "Kaos Rimba Navy" and sending its exact
 * name ("kaos rimba navy ada?") used to score a confident match on "Kaos
 * Rimba Hitam" against the active-only pool (2 of Hitam's 3 name tokens --
 * "kaos", "rimba" -- matched, clearing threshold), even though the message
 * obviously names Navy, not Hitam.
 *
 * The fix: whenever the active-only pool just produced a confident match,
 * ALSO score the same text against the FULL catalog (active + inactive,
 * via `productsRepo.listAll()`). If the full catalog's own confident
 * winner is an inactive product, that's proof the active-only result was
 * an artifact of the deactivated product's absence, not a genuine best
 * match -- so the result is forced to no-match/needs_review, regardless of
 * what the active-only pool computed. Gated on `matchResult.matched` (only
 * runs the extra full-catalog pass when there's a confident match to
 * second-guess in the first place) and on `productsRepo` being provided at
 * all -- the static `products` array path (every pre-existing caller/test)
 * has no active/inactive concept, so it is left completely untouched
 * (NFR-901).
 *
 * @param {{product: object|null, score: number, matched: boolean, flaggedTerms: string[], ambiguous: boolean}} matchResult
 * @param {string} text - the same customer text `matchResult` was computed from.
 * @param {object} params
 * @param {ReturnType<typeof import('./productsRepo').createProductsRepo>} [params.productsRepo]
 * @param {number} [params.matchThreshold]
 * @param {string[]} [params.intentDenylist]
 * @returns {typeof matchResult}
 */
function guardAgainstInactiveFullCatalogWinner(matchResult, text, { productsRepo, matchThreshold, intentDenylist }) {
  if (!matchResult.matched || !productsRepo) return matchResult;

  const fullCatalog = productsRepo.listAll();
  const fullCatalogResult = matchProduct(text, fullCatalog, { threshold: matchThreshold, intentDenylist });

  if (fullCatalogResult.matched && fullCatalogResult.product && fullCatalogResult.product.is_active === false) {
    log('product_match_forced_no_match_inactive_full_catalog_winner', {
      activePoolWinner: matchResult.product?.name,
      activePoolScore: matchResult.score,
      fullCatalogWinner: fullCatalogResult.product.name,
      fullCatalogScore: fullCatalogResult.score,
    });
    return { ...matchResult, product: null, matched: false };
  }

  return matchResult;
}

/**
 * The shared inbound-message contract (FR-302 of
 * docs/sdd/changes/2026-09-01-baileys-dual-mode.md).
 *
 * This is the ONE place that drives the qualifying-question state machine
 * from an inbound WhatsApp message, regardless of which connector received
 * it. It was extracted verbatim (same DB calls, same reply-send loop, same
 * decision logic) from what used to be `processMessage()` inside
 * src/routes/webhook.js -- that route is now just a thin adapter that maps
 * Meta's webhook payload shape onto this function's params, and the new
 * Baileys connector (@rimba/whatsapp-connector's baileysConnector.js) does the same for
 * Baileys' `messages.upsert` event shape.
 *
 * The state machine (stateMachine.js), the Lead repo (leadsRepo.js) and the
 * dashboard have zero mode-specific branching -- this function and its two
 * callers are the only places that know a "mode" concept exists at all.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('./leadsRepo').createLeadsRepo>} deps.leadsRepo
 * @param {object} deps.questionsConfig - loaded config/questions.json
 * @param {(contactId: string, text: string) => Promise<unknown>} deps.sendTextMessage
 *   - the outbound half of FR-302's shared contract. Both metaClient and the
 *   Baileys connector expose a function with this exact shape, so this
 *   module never needs to know which one it's talking to.
 * @param {ReturnType<typeof import('./settingsRepo').createSettingsRepo>} [deps.settingsRepo]
 *   - FR-402/NFR-401 (docs/sdd/changes/2026-09-01-auto-reply-toggle.md):
 *   queried fresh on every single inbound message to decide whether the
 *   reply-send loop below runs at all. Optional and defaults to "always
 *   enabled" so every pre-existing caller/test that constructs this
 *   processor without it (there are several) keeps working completely
 *   unmodified -- same additive-parameter pattern already used for
 *   `channel` above.
 * @param {(contactId: string, messageId: string|undefined) => Promise<unknown>} [deps.markAsRead]
 *   - FR-601/FR-604 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
 *   the connector-specific "mark this inbound message as read" primitive
 *   (metaClient.markAsRead / baileysConnector.markAsRead). Optional and
 *   defaults to a no-op so every pre-existing caller/test that constructs
 *   this processor without it keeps working unmodified -- same
 *   additive-parameter pattern as `settingsRepo` above.
 * @param {(contactId: string, messageId: string|undefined) => Promise<unknown>} [deps.sendTypingIndicator]
 *   - FR-601/FR-603: the connector-specific "show typing" primitive.
 *   Optional, defaults to a no-op, same reasoning as `markAsRead` above.
 * @param {(ms: number) => Promise<unknown>} [deps.sleep] - injectable delay
 *   mechanism forwarded straight into
 *   @rimba/humanized-timing#sendWithHumanizedTiming (NFR-603). Left
 *   undefined in production (real setTimeout-based delay); tests pass a
 *   fast/instant fake so the suite never actually waits in real time.
 * @param {() => number} [deps.random] - injectable RNG forwarded straight
 *   into @rimba/humanized-timing#sendWithHumanizedTiming (NFR-603, same
 *   reasoning as `sleep`). Left undefined in production (real
 *   `Math.random`); tests pass a fixed function so the exact typing-delay
 *   duration -- and therefore how many times FR-603's periodic
 *   typing-indicator refresh fires -- is deterministic instead of
 *   depending on which side of the ~20s refresh threshold real jitter
 *   happens to land on for a given message length.
 * @param {Array<{name: string, aliases?: string[]}>} [deps.products] -
 *   FR-502..FR-504 (docs/sdd/changes/2026-09-01-fuzzy-product-matching.md):
 *   the Product catalog (see src/services/productsLoader.js) fuzzy-matched
 *   against a Q1 answer the moment it's accepted. Deliberately left
 *   `undefined` by default (rather than defaulting to `[]`) -- same
 *   additive-parameter pattern as `settingsRepo`/`markAsRead` above -- so
 *   the many pre-existing callers/tests that construct this processor
 *   without it keep exercising the exact pre-fuzzy-matching behavior
 *   (Q2 always sent on a usable Q1 answer), completely unmodified
 *   (NFR-502). Matching only activates when this is explicitly provided
 *   (an empty array `[]` counts as "provided" and activates matching --
 *   see productMatcher.js for why an empty catalog then safely always
 *   resolves to "no match"/needs_review rather than crashing).
 * @param {ReturnType<typeof import('./productsRepo').createProductsRepo>} [deps.productsRepo] -
 *   FR-702 (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md):
 *   when provided, the Product catalog is read fresh from the database
 *   (`productsRepo.listActive()`) on every single call, instead of using
 *   the static `products` array above -- same "no caching, always current"
 *   pattern settingsRepo already uses for the auto-reply toggle (see
 *   NFR-401 above), so a product just deactivated/edited via the dashboard
 *   (src/routes/products.js) affects the very next inbound message, not
 *   just after a server restart. `products` still takes precedence when
 *   BOTH are provided (it never is, in production -- src/server.js injects
 *   only `productsRepo` from here on) purely so every pre-existing
 *   caller/test that passes a static `products` array (there are many, all
 *   predating this change) keeps exercising fuzzy-matching exactly as
 *   before, unmodified (NFR-701). Only `productsRepo` alone activates the
 *   new DB-backed path.
 * @param {number} [deps.matchThreshold] - forwarded straight into
 *   productMatcher.js's `matchProduct` (defaults to
 *   productMatcher.js's DEFAULT_MATCH_THRESHOLD when omitted).
 * @param {string[]} [deps.intentDenylist] - forwarded straight into
 *   productMatcher.js's `matchProduct` (defaults to
 *   productMatcher.js's DEFAULT_INTENT_DENYLIST when omitted). Post-review
 *   fix (Critical finding): independent safety net that forces
 *   needs_review whenever the customer's text contains a complaint/
 *   intent-shifting word (e.g. "refund", "rusak"), regardless of the
 *   token-similarity score -- see productMatcher.js's doc comment for why
 *   this is necessary in addition to (not instead of) the scoring fix.
 */
function createInboundMessageProcessor({
  leadsRepo,
  questionsConfig,
  sendTextMessage,
  settingsRepo,
  markAsRead,
  sendTypingIndicator,
  sleep,
  random,
  products,
  productsRepo,
  matchThreshold,
  intentDenylist,
}) {
  return {
    /**
     * @param {object} params
     * @param {string} params.contactId - contact identifier in the same
     *   format leadsRepo/Lead rows already use for this channel (for
     *   WhatsApp: no leading '+', digits only -- matches Meta's format; the
     *   Baileys adapter normalizes its JIDs to this same shape before
     *   calling in. For Telegram, once TICKET-1303 lands: the chat_id,
     *   stringified). TICKET-1302: renamed from `phoneNumber` -- this was
     *   always "whatever identifies this contact on this channel", never
     *   guaranteed to be a literal phone number even before Telegram
     *   support existed (see leadsRepo.js's findByContact()).
     * @param {string|null} params.messageBody - inbound text, or null for a
     *   non-text message type (image/sticker/etc).
     * @param {string} params.messageType - e.g. 'text', 'sticker', 'image'.
     *   Not consumed by the state machine (which only cares whether usable
     *   text is present -- see stateMachine.js), but threaded through and
     *   logged for observability/debugging parity with the old behavior.
     * @param {string} [params.timestamp] - ISO-8601 string for the
     *   message's original timestamp; each caller is responsible for
     *   converting its platform-specific timestamp format (Meta: unix
     *   seconds as a string; Baileys: unix seconds as a number) into ISO
     *   before calling in. Falls back to "now" if omitted.
     * @param {string} [params.channel] - 'whatsapp_cloud_api' |
     *   'whatsapp_baileys' (today), purely for logging/FailedEvent
     *   attribution -- NOT the same vocabulary as the `leads.channel` DB
     *   column. TICKET-1302: this mode-specific value is now ALSO mapped
     *   (via `toLeadChannel()` above) down to the coarser channel-family
     *   value ('whatsapp' | 'telegram') and persisted to
     *   `leadsRepo.create()` -- previously it was logged only, never
     *   stored.
     * @param {string} [params.messageId] - FR-601: the inbound message's own
     *   id (Meta's WAMID, or Baileys' `msg.key.id`), threaded through to
     *   `markAsRead`/`sendTypingIndicator` below so the read receipt/typing
     *   indicator can reference the specific message that triggered this
     *   reply. Optional -- if omitted, markAsRead simply has nothing to mark.
     */
    async processInboundMessage({
      contactId,
      messageBody,
      messageType,
      timestamp,
      channel = 'whatsapp_cloud_api',
      messageId,
    }) {
      const dbChannel = toLeadChannel(channel);
      const existingLead = leadsRepo.findByContact(contactId, dbChannel);
      // FR-1001/FR-1003/FR-1005 (docs/sdd/changes/2026-09-02-numbered-product-selection.md):
      // computed here, BEFORE decideNextAction(), rather than after (as it
      // used to be, right before the fuzzy-matching block below) -- the
      // state machine now needs this same catalog both to build Q1's
      // numbered-list prompt and to interpret a numbered reply to it.
      // Precedence (`products` static array wins over `productsRepo`) and
      // freshness (`productsRepo.listActive()` read fresh on every call,
      // never cached) are both unchanged from before this change -- see
      // the constructor's doc comment above for the full FR-702 reasoning.
      const catalog = Array.isArray(products) ? products : productsRepo ? productsRepo.listActive() : undefined;
      const decision = decideNextAction({
        existingLead,
        messageText: messageBody,
        config: questionsConfig,
        activeProducts: catalog,
      });

      let lead = existingLead;
      if (decision.createLead) {
        lead = leadsRepo.create({
          contactId,
          channel: dbChannel,
          firstMessageAt: timestamp || new Date().toISOString(),
        });
      }
      if (decision.leadPatch && lead) {
        lead = leadsRepo.saveAnswers(lead.id, decision.leadPatch);
      }

      // HIGH-severity post-review fix (docs/sdd/changes/2026-09-02-numbered-
      // product-selection.md): whenever this turn actually (re)sent Q1's
      // numbered list (START_FLOW, or a RETRY while Q1 is pending),
      // decideNextAction() returns the exact ordered product-ID snapshot of
      // what was shown -- persisted here so a LATER numbered reply from
      // this same lead is resolved against what they actually saw, never a
      // fresh productsRepo.listActive() re-query. See stateMachine.js's
      // header comment (judgment call 4) and schema.sql's doc comment on
      // `shown_product_ids` for the full misrouting bug this prevents.
      if (decision.shownProductIdsToPersist && lead) {
        lead = leadsRepo.updateShownProductIds(lead.id, decision.shownProductIdsToPersist);
      }

      // FR-502..FR-504: the instant a Q1 answer is accepted, fuzzy-match it
      // against the Product catalog (see @rimba/product-matcher's productMatcher.js).
      // Gated on `Array.isArray(products)` rather than truthiness so an
      // explicitly-empty catalog (`products: []`) still activates matching
      // -- NFR-502's "empty catalog -> always no match -> needs_review,
      // never a crash" case -- while an *omitted* `products` dependency
      // (every pre-existing caller/test) leaves this whole block inert,
      // preserving today's unmodified behavior (see the constructor's doc
      // comment above).
      //
      // This intentionally never touches the state machine's own
      // question1_answer/retry/fallback bookkeeping (already committed
      // above, unconditionally) -- Settled Decision #3 in the change doc:
      // "no fallback/retry triggered by this alone." The ONLY two things a
      // low-confidence/no match changes are (a) `matched_product`/
      // `needs_review` on the Lead row, for the dashboard, and (b)
      // suppressing this turn's would-be Q2 prompt reply -- the customer's
      // raw answer is still saved and visible, and the very next message
      // they send is handled completely normally by the (unmodified)
      // state machine.
      let replies = decision.replies;
      if (decision.action === ACTIONS.ANSWER_Q1 && lead && decision.numberedProductMatch) {
        // FR-1002/NFR-1002: the state machine already deterministically
        // resolved this Q1 answer to an exact catalog entry via its 1-based
        // list position -- the fuzzy matcher (matchProduct(), below) is
        // NEVER invoked for this path. `replies` is left as-is (Q2 still
        // gets sent), same shape as the FR-503 confident-match branch below.
        lead = leadsRepo.updateProductMatch(lead.id, {
          matchedProduct: decision.numberedProductMatch.name,
          matchedProductScore: 1.0,
          needsReview: false,
        });
      } else if (decision.action === ACTIONS.ANSWER_Q1 && lead && decision.numberedProductStale) {
        // HIGH-severity post-review fix: the customer's numbered reply
        // resolved (via the shown_product_ids snapshot) to a specific
        // product that is no longer active right now -- the catalog
        // changed between Q1-send and this reply. NEVER confidently
        // substitute whatever a fresh re-query would now put at that same
        // position instead (that's the exact misrouting bug this fixes),
        // and don't bother calling the fuzzy matcher on a bare digit
        // string either (structurally meaningless -- it would only ever
        // score 0/no-match anyway). Treated exactly like FR-504's no-match
        // branch below: Q2 suppressed, needs_review flagged, so the owner
        // sees this needs a manual look instead of a silently wrong match.
        lead = leadsRepo.updateProductMatch(lead.id, { matchedProduct: null, matchedProductScore: null, needsReview: true });
        replies = [];
      } else if (decision.action === ACTIONS.ANSWER_Q1 && lead && Array.isArray(catalog)) {
        // FR-1003: a Q1 reply that did NOT resolve to a numbered selection
        // (free text, or no numbered list was even shown -- FR-1005) falls
        // through to the existing, four-times-hardened fuzzy matcher below,
        // completely unchanged.
        const rawMatchResult = matchProduct(messageBody, catalog, { threshold: matchThreshold, intentDenylist });
        // FR-901: never return a confident match that only "wins" because
        // the actually-best-matching product was deactivated -- see the
        // guard function's doc comment above.
        const matchResult = guardAgainstInactiveFullCatalogWinner(rawMatchResult, messageBody, {
          productsRepo,
          matchThreshold,
          intentDenylist,
        });
        if (matchResult.matched) {
          // FR-503: above threshold, today's flow proceeds completely
          // unchanged (`replies` is left as-is, so Q2 still gets sent) --
          // the only addition is recording the matched product name.
          lead = leadsRepo.updateProductMatch(lead.id, {
            matchedProduct: matchResult.product.name,
            matchedProductScore: matchResult.score,
            needsReview: false,
          });
        } else {
          // FR-504: below threshold (including "no match found" -- score
          // 0, or the empty-catalog case above) -- suppress this turn's Q2
          // prompt and flag the lead for manual review.
          lead = leadsRepo.updateProductMatch(lead.id, { matchedProduct: null, matchedProductScore: null, needsReview: true });
          replies = [];
        }
      }

      // FR-801..FR-803 (docs/sdd/changes/2026-09-02-capture-post-completion-messages.md):
      // stateMachine.js resolves ANY further message from a Lead it already
      // considers resolved -- both questions answered
      // ('flow_already_complete'), fallback already triggered
      // ('fallback_already_triggered'), or the owner already marked the
      // lead 'responded'/'closed' (`lead_status_${status}`) -- to NO_OP:
      // zero replies, and (before this change) zero record of the message
      // ever having existed. That last part is the bug: a real customer's
      // actual product question ("spill harga kaos rimba nya dong") arrived
      // as a post-completion message and was silently lost.
      //
      // Judgment call: this fix applies to EVERY NO_OP reason, not just
      // 'flow_already_complete' (the one the real bug report happened to
      // hit). The change doc's own examples are all
      // 'flow_already_complete', but its stated intent -- "never silently
      // drop a message" -- draws no principled line at the other NO_OP
      // reasons: a customer writing back after the owner marked their lead
      // 'responded', or after fallback already fired, is exactly as real
      // and exactly as easy to lose as one that arrives one message earlier
      // (before Q1/Q2 wrapped up). Applying it uniformly is also simpler to
      // reason about than re-litigating "drop or capture" per reason string
      // -- one condition (`decision.action === ACTIONS.NO_OP && lead`)
      // covers all of them.
      //
      // Gated on `hasUsableText(messageBody)` -- the same bar the state
      // machine itself already uses to decide whether an inbound message
      // carries anything worth acting on. A non-text message (sticker/
      // image/empty body) has no text to append to the log or fuzzy-match
      // against the catalog, so it's left exactly as before: genuinely
      // NO_OP, nothing recorded (consistent with how non-text messages are
      // treated everywhere else in the flow -- they never get stored raw).
      if (decision.action === ACTIONS.NO_OP && lead && hasUsableText(messageBody)) {
        // Post-review fix (Medium finding): 'lead_status_responded' /
        // 'lead_status_closed' are terminal -- leadsRepo.updateStatus()
        // blocks any transition away from 'closed', and leads.ejs shows
        // zero action buttons for a closed lead ("No further action").
        // Force-flagging needs_review=true here would create a
        // permanently-stuck, self-contradictory dashboard state that
        // wasn't reachable before this change: "needs review" with no way
        // to ever clear it, and a misleading "unmatched product" badge for
        // an issue that has nothing to do with matching. So FR-803's
        // unconditional needs_review=true is scoped to the two NON-terminal
        // NO_OP reasons only (flow_already_complete,
        // fallback_already_triggered, i.e. NOT starting with
        // 'lead_status_') -- those are still-open leads where the flag is
        // genuinely actionable. FR-801's additional_notes capture still
        // applies to EVERY NO_OP reason, including closed/responded --
        // data is never lost, only the needs_review side-effect is scoped
        // down.
        const isTerminalStatusReason = typeof decision.reason === 'string' && decision.reason.startsWith('lead_status_');
        const noteTimestamp = (timestamp ? new Date(timestamp) : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
        lead = leadsRepo.appendAdditionalNote(lead.id, `[${noteTimestamp}] ${messageBody}`, {
          needsReview: !isTerminalStatusReason,
        });

        // FR-802: re-run the fuzzy matcher against this later message too.
        // Only adopted if it's a STRICTLY better match than whatever's
        // currently stored (`matched_product_score`) -- see that column's
        // schema.sql doc comment for why the comparison is against a
        // persisted score rather than one re-derived from
        // question1_answer (the currently-stored match may itself have
        // come from an earlier post-completion message, not Q1).
        // `currentScore === null` (no confident match recorded yet, at any
        // point) always loses to any confident new match.
        if (Array.isArray(catalog)) {
          const rawPostCompletionMatch = matchProduct(messageBody, catalog, { threshold: matchThreshold, intentDenylist });
          // FR-901: same inactive-full-catalog-winner guard as the Q1 path above.
          const postCompletionMatch = guardAgainstInactiveFullCatalogWinner(rawPostCompletionMatch, messageBody, {
            productsRepo,
            matchThreshold,
            intentDenylist,
          });
          const currentScore = typeof lead.matched_product_score === 'number' ? lead.matched_product_score : null;
          if (postCompletionMatch.matched && (currentScore === null || postCompletionMatch.score > currentScore)) {
            lead = leadsRepo.updateProductMatch(lead.id, {
              matchedProduct: postCompletionMatch.product.name,
              matchedProductScore: postCompletionMatch.score,
              // FR-803, same terminal-status scoping as the note append
              // above: true for the two non-terminal reasons (even on a
              // confident match found right here -- an ongoing
              // conversation after the scripted flow ended always warrants
              // a fresh look, not a silent database update), but for a
              // closed/responded lead, preserve whatever needs_review
              // already was instead of force-setting it.
              needsReview: isTerminalStatusReason ? Boolean(lead.needs_review) : true,
            });
          }
        }
        // NFR-802: deliberately no touch of `replies` anywhere above --
        // decision.replies for every NO_OP action is already `[]` from
        // stateMachine.js, and nothing in this block pushes into it. This
        // change is data capture only; the send loop below still sends
        // nothing for this message.
      }

      // FR-402/NFR-401: read fresh on every call, no caching -- a toggle
      // flipped between two inbound messages (or by a concurrent dashboard
      // request) is picked up on the very next message, never stale.
      const autoReplyEnabled = settingsRepo ? settingsRepo.isAutoReplyEnabled() : true;

      if (autoReplyEnabled) {
        // FR-601/FR-604: every automated reply (ack, question, retry, or
        // fallback) is routed through the shared, transport-agnostic
        // humanized-timing module (@rimba/humanized-timing's humanizedTiming.js) instead of
        // being sent immediately -- see
        // docs/sdd/changes/2026-09-01-humanized-timing-module.md and
        // Decision 001 for why this replaces the original 5s reply budget.
        //
        // Post-review fix (gap found: markAsRead was silently skipped
        // whenever decision.replies was empty -- not just in the
        // multi-reply-batch case the original comment here described, but
        // also for NO_OP on an already-responded/closed lead, fallback
        // already triggered, flow already complete, or ANSWER_Q2 with no
        // completionMessage configured. In every one of those cases a
        // customer's genuinely new inbound message got no read receipt at
        // all.) Decision made: (b) -- markAsRead now fires unconditionally
        // for any new inbound message while auto-reply is ON, regardless of
        // whether a scripted reply follows. Decision 001 frames the read
        // receipt purely as "the customer gets an early signal their
        // message was received", which does not logically depend on
        // whether a reply is queued -- so it is called here, exactly once,
        // before the reply loop (not per-reply -- there is still only one
        // inbound message to mark read, and re-marking it before every
        // reply in a multi-reply batch would just add compounding latency
        // with no real human-behavior justification). Each reply below
        // still gets its own full typing-indicator + length-proportional
        // delay -- only the already-fired markAsRead is a no-op there.
        if (markAsRead) await markAsRead(contactId, messageId);

        for (const replyText of replies) {
          // eslint-disable-next-line no-await-in-loop -- messages must go out in this exact order
          await sendWithHumanizedTiming({
            messageText: replyText,
            sleep,
            random,
            markAsRead: async () => {}, // already fired once, above, for this inbound message
            sendTypingIndicator: async () => {
              if (sendTypingIndicator) await sendTypingIndicator(contactId, messageId);
            },
            sendMessage: (text) => sendTextMessage(contactId, text),
          });
        }
      }
      // FR-402: when OFF, the Lead bookkeeping above still ran exactly as
      // today -- only the outbound send loop is skipped. No reply is
      // "queued" or sent later either; toggling back ON does not
      // retroactively message whoever wrote in while it was OFF (there is
      // nothing pending to flush -- decision.replies for this message simply
      // never got sent).

      log('inbound_message_processed', {
        channel,
        leadId: lead?.id,
        messageType,
        action: decision.action,
        autoReplyEnabled,
        reason: decision.reason,
        needsReview: lead?.needs_review === 1,
      });

      // `replies` (rather than the state machine's original decision.replies)
      // is returned here so callers/tests observe what was actually sent --
      // identical to decision.replies for every action except a
      // below-threshold ANSWER_Q1 (FR-504), where the Q2 prompt was
      // suppressed above.
      return { lead, decision: { ...decision, replies } };
    },
  };
}

module.exports = { createInboundMessageProcessor };
