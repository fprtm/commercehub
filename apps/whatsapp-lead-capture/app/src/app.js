'use strict';

const express = require('express');
const session = require('express-session');
const path = require('path');

const { createHealthRouter } = require('./routes/health');
const { createWebhookRouter } = require('./routes/webhook');
const { createAuthRouter } = require('./routes/auth');
const { createLeadsRouter } = require('./routes/leads');
const { createSettingsRouter } = require('./routes/settings');
const { createWhatsappPairRouter } = require('./routes/whatsappPair');
const { createProductsRouter } = require('./routes/products');
const { createFailedEventsRouter } = require('./routes/failedEvents');
const { createLeadsRepo } = require('./services/leadsRepo');
const { createFailedEventsRepo } = require('./services/failedEventsRepo');
const { createSettingsRepo } = require('./services/settingsRepo');
const { createProductsRepo } = require('./services/productsRepo');

/**
 * Builds a fully-wired Express app from injected dependencies. Kept as a
 * factory (rather than a module-level app singleton) so tests can supply an
 * in-memory DB and a mock Meta client instead of the real ones -- see
 * tests/*.test.js.
 *
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {ReturnType<typeof import('./services/metaClient').createMetaClient>} deps.metaClient
 * @param {object} deps.questionsConfig
 * @param {string} deps.verifyToken
 * @param {string|undefined} deps.appSecret
 * @param {string} deps.sessionSecret
 * @param {string} deps.ownerUsername
 * @param {string} deps.ownerPassword
 * @param {string} [deps.whatsappMode] - 'cloud_api' (default) | 'baileys'
 *   (FR-301). Defaulted here (rather than required) so every pre-existing
 *   caller of createApp() -- including all 61 original tests -- keeps
 *   working unmodified, exactly as if this dual-mode change didn't exist.
 * @param {ReturnType<typeof import('./services/baileysConnector').createBaileysConnector>|null} [deps.baileysConnector]
 *   - only relevant when whatsappMode is 'baileys'; used solely to render
 *   the pairing screen's live status (FR-303). createApp() never calls
 *   `.start()` on it -- that's src/server.js's job, same pattern as
 *   metaClient already being constructed outside createApp() and injected
 *   in.
 * @param {Array<{name: string, aliases?: string[]}>} [deps.productsConfig]
 *   - FR-501..FR-504 (docs/sdd/changes/2026-09-01-fuzzy-product-matching.md):
 *   the loaded Product catalog (see src/services/productsLoader.js),
 *   forwarded into the webhook route's inboundMessageProcessor wiring.
 *   Left `undefined` by default -- same additive-parameter pattern as
 *   `sleep`/`random` below -- so every pre-existing caller of createApp()
 *   (including all 128 tests predating this change) keeps exercising
 *   fuzzy-matching as a complete no-op, exactly as if this change didn't
 *   exist (NFR-502). `src/server.js` is the one production caller that
 *   always passes a real (possibly empty) array here.
 * @param {number} [deps.matchThreshold] - forwarded straight through, same
 *   reasoning as `productsConfig` above.
 * @param {string[]} [deps.intentDenylist] - forwarded straight through,
 *   same reasoning as `productsConfig` above (post-review Critical fix).
 * @param {ReturnType<typeof import('./services/productsRepo').createProductsRepo>} [deps.productsRepo]
 *   - FR-702 (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md):
 *   when injected, this exact instance is what both the `/products`
 *   dashboard CRUD routes AND the webhook's DB-backed fuzzy-matching (see
 *   inboundMessageProcessor.js) read/write. When omitted (every
 *   pre-existing test), createApp() still builds its own instance from
 *   `db` for the `/products` routes (same construct-from-`db` pattern as
 *   leadsRepo/failedEventsRepo/settingsRepo below) so that page works in
 *   every environment -- but that internally-defaulted instance is
 *   deliberately NOT forwarded into the webhook wiring, so fuzzy-matching
 *   stays exactly as inert as before for every caller that doesn't
 *   explicitly opt in (NFR-701). `src/server.js` is the one production
 *   caller that injects a real instance here (after seeding it once from
 *   config/products.json -- see `src/services/productsSeed.js`).
 */
function createApp(deps) {
  const {
    db,
    metaClient,
    questionsConfig,
    verifyToken,
    appSecret,
    sessionSecret,
    ownerUsername,
    ownerPassword,
    whatsappMode = 'cloud_api',
    baileysConnector = null,
    // FR-601/NFR-603 (docs/sdd/changes/2026-09-01-humanized-timing-module.md):
    // forwarded to the webhook route's inboundMessageProcessor wiring below.
    // Undefined in production (real delay/RNG); tests override both with a
    // fast fake sleep and a fixed random (see tests/helpers/testApp.js) so
    // the suite stays fast *and* deterministic -- including which side of
    // FR-603's ~20s typing-indicator-refresh threshold a given message
    // length lands on, which would otherwise vary run-to-run with real
    // jitter (post-review fix).
    sleep,
    random,
    productsConfig,
    matchThreshold,
    intentDenylist,
    productsRepo: injectedProductsRepo,
  } = deps;

  const leadsRepo = createLeadsRepo(db);
  const failedEventsRepo = createFailedEventsRepo(db);
  // FR-702: always available for the /products dashboard routes below;
  // only forwarded into the webhook's matching wiring when explicitly
  // injected by the caller -- see the doc comment above and
  // inboundMessageProcessor.js's own doc comment for the full reasoning.
  const productsRepo = injectedProductsRepo || createProductsRepo(db);
  // FR-401..FR-403 (docs/sdd/changes/2026-09-01-auto-reply-toggle.md):
  // constructed here (same pattern as leadsRepo/failedEventsRepo above) so
  // both the webhook route and the dashboard/settings routes below share
  // one settingsRepo instance backed by this same `db` -- the Baileys
  // connector's own inbound-message processor (built separately, in
  // src/server.js) constructs its own instance against the same db file,
  // which is fine: settingsRepo never caches, every read hits SQLite fresh
  // (NFR-401), so both instances always agree.
  const settingsRepo = createSettingsRepo(db);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  // Disable etag/x-powered-by noise; this is a small internal dashboard,
  // not a public API that needs caching negotiation.
  app.disable('x-powered-by');

  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax' },
    }),
  );

  app.use(createHealthRouter());
  app.use(
    createWebhookRouter({
      leadsRepo,
      failedEventsRepo,
      metaClient,
      questionsConfig,
      verifyToken,
      appSecret,
      settingsRepo,
      sleep,
      random,
      products: productsConfig,
      // FR-702: deliberately the raw injected dep, not the possibly
      // internally-defaulted `productsRepo` above -- see that const's
      // comment for why this distinction matters (NFR-701).
      productsRepo: injectedProductsRepo,
      matchThreshold,
      intentDenylist,
    }),
  );
  app.use(createAuthRouter({ ownerUsername, ownerPassword }));
  app.use(createLeadsRouter({ leadsRepo, settingsRepo }));
  app.use(createSettingsRouter({ settingsRepo }));
  app.use(createWhatsappPairRouter({ whatsappMode, baileysConnector }));
  app.use(createProductsRouter({ productsRepo }));
  app.use(createFailedEventsRouter({ failedEventsRepo }));

  app.get('/', (req, res) => res.redirect('/leads'));

  // Fallback error handler for anything not already caught by the
  // webhook route's own error handler (e.g. an error thrown in the
  // dashboard routes). Dashboard errors are surfaced normally (not
  // swallowed to 200) -- TD-004's "always 200" rule is specific to the
  // Meta webhook, not the owner-facing dashboard.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send('Something went wrong.');
  });

  return app;
}

module.exports = { createApp };
