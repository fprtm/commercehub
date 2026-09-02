'use strict';

require('dotenv').config();
const path = require('path');

const { createApp } = require('./app');
const { createDb } = require('./db');
const { createMetaClient, createBaileysConnector } = require('@rimba/whatsapp-connector');
const { createTelegramConnector } = require('@rimba/telegram-connector');
const { createInboundMessageProcessor } = require('./services/inboundMessageProcessor');
const { createLeadsRepo } = require('./services/leadsRepo');
const { createFailedEventsRepo } = require('./services/failedEventsRepo');
const { createSettingsRepo } = require('./services/settingsRepo');
const { createProductsRepo } = require('./services/productsRepo');
const { seedProductsFromJsonIfEmpty, fixBareKaosAliasOnExistingInstalls } = require('./services/productsSeed');
const { loadQuestionsConfig } = require('./services/questionsLoader');
const { loadProductsConfig } = require('./services/productsLoader');
const { DEFAULT_MATCH_THRESHOLD } = require('@rimba/product-matcher');
const { log } = require('./utils/logger');

// FR-501..FR-504 (docs/sdd/changes/2026-09-01-fuzzy-product-matching.md):
// PRODUCT_MATCH_THRESHOLD env var takes precedence over
// config/products.json's own "matchThreshold" field, which in turn takes
// precedence over productMatcher.js's coded DEFAULT_MATCH_THRESHOLD --
// same override-chain shape as every other configurable knob in this app
// (env var for ops-time tuning, config file for the business-facing
// default, code constant as the last-resort fallback).
function resolveMatchThreshold(configuredThreshold) {
  const envValue = process.env.PRODUCT_MATCH_THRESHOLD;
  if (envValue !== undefined && envValue !== '') {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed)) return parsed;
    console.error(`Invalid PRODUCT_MATCH_THRESHOLD "${envValue}" -- must be a number. Falling back to the config/coded default.`);
  }
  return typeof configuredThreshold === 'number' ? configuredThreshold : DEFAULT_MATCH_THRESHOLD;
}

// FR-301: mode is chosen at boot via env var, not switchable at runtime.
const WHATSAPP_MODE = (process.env.WHATSAPP_MODE || 'cloud_api').trim();
const VALID_WHATSAPP_MODES = ['cloud_api', 'baileys'];

// Cloud API's env vars are only required in cloud_api mode -- Baileys mode
// needs none of Meta's credentials (that's the point: zero setup friction,
// see the change doc's "Why"). SESSION_SECRET/OWNER_* are required in both
// modes since the dashboard (and the pairing screen) exist either way.
const BASE_REQUIRED_ENV_VARS = ['SESSION_SECRET', 'OWNER_USERNAME', 'OWNER_PASSWORD'];
const CLOUD_API_REQUIRED_ENV_VARS = [
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  // Required, not optional: without this set, POST /webhook signature
  // verification is silently skipped (see webhook.js), which would let
  // anyone who finds the URL post fake WhatsApp events. A deployable build
  // must not be able to boot into that state.
  'WHATSAPP_APP_SECRET',
];

function assertRequiredEnv() {
  if (!VALID_WHATSAPP_MODES.includes(WHATSAPP_MODE)) {
    console.error(`Invalid WHATSAPP_MODE "${WHATSAPP_MODE}" -- must be one of: ${VALID_WHATSAPP_MODES.join(', ')}.`);
    process.exit(1);
  }

  const requiredVars = [...BASE_REQUIRED_ENV_VARS, ...(WHATSAPP_MODE === 'cloud_api' ? CLOUD_API_REQUIRED_ENV_VARS : [])];
  const missing = requiredVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in real values before starting the server.');
    process.exit(1);
  }
}

/**
 * A stub used only as the metaClient dependency when WHATSAPP_MODE is
 * 'baileys' -- FR-301 says the unconfigured mode's code path is not
 * touched, so nothing real is ever constructed for it. In practice nothing
 * calls this (Meta isn't configured to POST /webhook in this mode), but if
 * it somehow were, this fails loudly/safely into the existing
 * always-200/FailedEvent path (webhook.js) instead of crashing the process.
 */
function createDisabledMetaClient() {
  return {
    async sendTextMessage() {
      throw new Error('Cloud API is not active (WHATSAPP_MODE=baileys) -- no message was sent.');
    },
  };
}

/**
 * TICKET-1304 (docs/sdd/specs/002-telegram-multichannel/sds.md,
 * "Architecture Decision — Composition-Root Channel Registry"): the
 * Telegram half of the composition root, factored out of main() so it can
 * be exercised directly in tests without booting a real HTTP server or
 * requiring real env vars -- same reasoning `createApp(deps)` already
 * follows for the WA/dashboard side.
 *
 * Presence-driven, not a mode string (FR-1302): `telegramBotToken` empty
 * (after trim) or omitted means Telegram is disabled and this returns
 * `null` -- no connector is constructed, no processor is constructed, zero
 * new code paths execute. This is what makes "TELEGRAM_BOT_TOKEN unset"
 * byte-for-byte identical to this app's pre-ticket behavior.
 *
 * When enabled, constructs its OWN `leadsRepo`/`settingsRepo` instances
 * against the same `db` file rather than reusing whichever instances the
 * WA side happens to have built -- identical to the pattern the existing
 * WHATSAPP_MODE=baileys branch below already uses for the same reason
 * (neither repo caches, so multiple instances against the same db always
 * agree; see settingsRepo.js's NFR-401 comment). This is what the SDS's
 * "sharedDeps passed identically to both processor instances" refers to:
 * the same *shape* of dependencies, wired the same way, not a literal
 * shared object reference (WA's cloud_api-mode processor is similarly
 * self-contained, built inside createWebhookRouter()).
 *
 * `markAsRead` is deliberately omitted -- the Telegram Bot API has no
 * read-receipt concept for private chats, and `createInboundMessageProcessor`
 * already treats it as optional/no-op by default (unmodified, see that
 * file's own doc comment) -- no new code path needed here either.
 *
 * @param {object} params
 * @param {string|undefined} params.telegramBotToken - raw `process.env.TELEGRAM_BOT_TOKEN`.
 * @param {import('better-sqlite3').Database} params.db
 * @param {object} params.questionsConfig
 * @param {ReturnType<typeof import('./services/productsRepo').createProductsRepo>} [params.productsRepo]
 * @param {number} [params.matchThreshold]
 * @param {string[]} [params.intentDenylist]
 * @param {(ms: number) => Promise<unknown>} [params.sleep] - forwarded to
 *   createInboundMessageProcessor for the same NFR-603 reasons as
 *   everywhere else it's threaded through; left undefined in production
 *   (real delay), overridable by tests for a fast/deterministic run.
 * @param {() => number} [params.random] - same reasoning as `sleep`.
 * @param {typeof createTelegramConnector} [params.createTelegramConnectorImpl]
 *   - defaults to the real `@rimba/telegram-connector` export; tests inject
 *   a fake, connector-shaped factory instead (same injection pattern
 *   `whatsappPair.test.js`'s `fakeBaileysConnector` already uses), so no
 *   real network/polling ever happens in the test suite.
 * @returns {{ connector: ReturnType<typeof createTelegramConnector> }|null}
 */
function createTelegramChannel({
  telegramBotToken,
  db,
  questionsConfig,
  productsRepo,
  matchThreshold,
  intentDenylist,
  sleep,
  random,
  createTelegramConnectorImpl = createTelegramConnector,
}) {
  const token = (telegramBotToken || '').trim();
  if (!token) return null;

  const leadsRepo = createLeadsRepo(db);
  const settingsRepo = createSettingsRepo(db);

  // sendTextMessage/sendTypingIndicator forward to the connector via
  // closure -- same circular-dependency-breaking trick the baileys branch
  // below already uses (the connector needs the processor's callback at
  // construction time, and the processor needs the connector's send
  // functions).
  let telegramConnector;
  const { processInboundMessage } = createInboundMessageProcessor({
    leadsRepo,
    questionsConfig,
    sendTextMessage: (chatId, text) => telegramConnector.sendTextMessage(chatId, text),
    sendTypingIndicator: (chatId) => telegramConnector.sendTypingIndicator(chatId),
    settingsRepo,
    productsRepo,
    matchThreshold,
    intentDenylist,
    sleep,
    random,
  });

  telegramConnector = createTelegramConnectorImpl({
    botToken: token,
    onMessage: (update) =>
      processInboundMessage({
        contactId: String(update.chatId),
        channel: 'telegram',
        messageBody: update.text,
        messageType: update.messageType,
        messageId: update.telegramMessageId,
        timestamp: update.timestampIso,
      }),
  });

  return { connector: telegramConnector };
}

function main() {
  assertRequiredEnv();

  const port = process.env.PORT || 3000;
  const dbPath = process.env.DATABASE_PATH || './data/leads.db';
  const resolvedDbPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);

  const db = createDb(resolvedDbPath);
  const questionsConfig = loadQuestionsConfig();
  const {
    products: productsConfig,
    matchThreshold: configuredMatchThreshold,
    intentDenylist,
  } = loadProductsConfig();
  const matchThreshold = resolveMatchThreshold(configuredMatchThreshold);

  // FR-702 (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md):
  // the database is the Product catalog's source of truth from here on.
  // `productsRepo` below is the ONE instance used for both the /products
  // dashboard CRUD routes (via createApp) and live fuzzy-matching (via
  // inboundMessageProcessor.js, constructed fresh per message -- see that
  // file's doc comment). `productsConfig` (just loaded above from
  // config/products.json) is used for exactly one more thing after this:
  // seeding this table the very first time it's empty (NFR-703:
  // idempotent -- seedProductsFromJsonIfEmpty() is a no-op on every boot
  // after the first). It is deliberately NOT forwarded into createApp()'s
  // `productsConfig`/`products` wiring below -- doing so would leave a
  // second, stale read-path for matching, contradicting FR-702's
  // acceptance criterion that editing config/products.json post-seed has
  // zero effect.
  const productsRepo = createProductsRepo(db);
  seedProductsFromJsonIfEmpty({ productsRepo, products: productsConfig });
  // FR-902 (docs/sdd/changes/2026-09-02-fix-matching-safety-bugs.md, Bug 2
  // data fix): a one-time, idempotent backfill for installs that already
  // completed the seed above before the bare "kaos" alias was removed from
  // config/products.json -- see fixBareKaosAliasOnExistingInstalls()'s doc
  // comment for why this is safe to call unconditionally on every boot.
  fixBareKaosAliasOnExistingInstalls({ productsRepo });

  // TICKET-1304 (SDS "Architecture Decision — Composition-Root Channel
  // Registry"): a second, independent inboundMessageProcessor instance for
  // Telegram, wired here regardless of WHATSAPP_MODE -- the two channels
  // run concurrently, not as an exclusive switch. Returns null (and
  // constructs nothing) when TELEGRAM_BOT_TOKEN is unset, so this line has
  // zero effect on every pre-existing deployment/test.
  const telegramChannel = createTelegramChannel({
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    db,
    questionsConfig,
    productsRepo,
    matchThreshold,
    intentDenylist,
  });

  let metaClient;
  let baileysConnector = null;

  if (WHATSAPP_MODE === 'baileys') {
    const authDirEnv = process.env.BAILEYS_AUTH_DIR || './data/baileys-auth';
    const authDir = path.isAbsolute(authDirEnv) ? authDirEnv : path.join(process.cwd(), authDirEnv);

    const leadsRepo = createLeadsRepo(db);
    const failedEventsRepo = createFailedEventsRepo(db);
    // FR-402 (docs/sdd/changes/2026-09-01-auto-reply-toggle.md): a separate
    // instance from the one createApp() builds internally for the
    // webhook/dashboard routes below, but both point at the same `db` file
    // and settingsRepo never caches (NFR-401), so they always agree.
    const settingsRepo = createSettingsRepo(db);

    // sendTextMessage forwards to the connector via closure -- the
    // connector itself needs `processInboundMessage` at construction time,
    // and `processInboundMessage` needs the connector's sendTextMessage, so
    // this indirection breaks the circular dependency between the two.
    // markAsRead/sendTypingIndicator (FR-601/FR-604) use the same closure
    // trick for the same reason.
    const { processInboundMessage } = createInboundMessageProcessor({
      leadsRepo,
      questionsConfig,
      sendTextMessage: (to, text) => baileysConnector.sendTextMessage(to, text),
      markAsRead: (to, messageId) => baileysConnector.markAsRead(to, messageId),
      sendTypingIndicator: (to, messageId) => baileysConnector.sendTypingIndicator(to, messageId),
      settingsRepo,
      // FR-702: DB-backed, same `productsRepo` instance seeded/constructed
      // above (against the same `db` file) -- not the config-file array.
      productsRepo,
      matchThreshold,
      intentDenylist,
    });

    baileysConnector = createBaileysConnector({ authDir, processInboundMessage, failedEventsRepo });
    metaClient = createDisabledMetaClient();
  } else {
    metaClient = createMetaClient({
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    });
  }

  const app = createApp({
    db,
    metaClient,
    questionsConfig,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET,
    sessionSecret: process.env.SESSION_SECRET,
    ownerUsername: process.env.OWNER_USERNAME,
    ownerPassword: process.env.OWNER_PASSWORD,
    whatsappMode: WHATSAPP_MODE,
    baileysConnector,
    // FR-702: DB-backed matching + the /products CRUD routes both read/
    // write this same instance -- config/products.json's own `products`
    // array is intentionally NOT passed here anymore (see the comment
    // above `productsRepo`'s construction).
    productsRepo,
    matchThreshold,
    intentDenylist,
  });

  app.listen(port, () => {
    log('server_started', {
      port,
      dbPath: resolvedDbPath,
      whatsappMode: WHATSAPP_MODE,
      // FR-702: reflects the live DB catalog (active + deactivated), not
      // config/products.json's array -- that file is seed-only from here on.
      productCount: productsRepo.listAll().length,
      activeProductCount: productsRepo.listActive().length,
      matchThreshold,
      intentDenylistCount: intentDenylist.length,
      // TICKET-1304: observability parity with whatsappMode above -- lets
      // an operator confirm from the boot log alone whether the Telegram
      // channel is active, without needing to know TELEGRAM_BOT_TOKEN was
      // even a thing to check.
      telegramEnabled: Boolean(telegramChannel),
    });
    console.log(`WhatsApp Lead Capture running on http://localhost:${port} (mode: ${WHATSAPP_MODE})`);
    if (WHATSAPP_MODE === 'baileys') {
      console.log(`Baileys mode active -- open http://localhost:${port}/whatsapp/pair (after logging in) to pair.`);
    }
    if (telegramChannel) {
      console.log('Telegram channel active (TELEGRAM_BOT_TOKEN is set).');
    }
  });

  if (WHATSAPP_MODE === 'baileys') {
    // Starts asynchronously so the HTTP server (and the pairing screen) are
    // reachable immediately, even while Baileys is still connecting.
    baileysConnector.start().catch((err) => {
      log('baileys_start_failed', { error: err.message });
      console.error('Failed to start Baileys connector:', err.message);
    });
  }

  if (telegramChannel) {
    // TICKET-1304: started alongside (not instead of) the WA connector
    // above -- both channels run concurrently, independent of
    // WHATSAPP_MODE. Same fire-and-forget-with-logged-catch pattern as the
    // baileys start above, for the same reason (don't block/crash the HTTP
    // server on a channel-specific startup failure).
    telegramChannel.connector.start().catch((err) => {
      log('telegram_start_failed', { error: err.message });
      console.error('Failed to start Telegram connector:', err.message);
    });
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, createTelegramChannel };
