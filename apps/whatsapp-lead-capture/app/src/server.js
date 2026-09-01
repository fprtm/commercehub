'use strict';

require('dotenv').config();
const path = require('path');

const { createApp } = require('./app');
const { createDb } = require('./db');
const { createMetaClient } = require('./services/metaClient');
const { createBaileysConnector } = require('./services/baileysConnector');
const { createInboundMessageProcessor } = require('./services/inboundMessageProcessor');
const { createLeadsRepo } = require('./services/leadsRepo');
const { createFailedEventsRepo } = require('./services/failedEventsRepo');
const { createSettingsRepo } = require('./services/settingsRepo');
const { loadQuestionsConfig } = require('./services/questionsLoader');
const { loadProductsConfig } = require('./services/productsLoader');
const { DEFAULT_MATCH_THRESHOLD } = require('./services/productMatcher');
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
      products: productsConfig,
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
    productsConfig,
    matchThreshold,
    intentDenylist,
  });

  app.listen(port, () => {
    log('server_started', {
      port,
      dbPath: resolvedDbPath,
      whatsappMode: WHATSAPP_MODE,
      productCount: productsConfig.length,
      matchThreshold,
      intentDenylistCount: intentDenylist.length,
    });
    console.log(`WhatsApp Lead Capture running on http://localhost:${port} (mode: ${WHATSAPP_MODE})`);
    if (WHATSAPP_MODE === 'baileys') {
      console.log(`Baileys mode active -- open http://localhost:${port}/whatsapp/pair (after logging in) to pair.`);
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
}

main();
