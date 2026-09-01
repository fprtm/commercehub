'use strict';

require('dotenv').config();
const path = require('path');

const { createApp } = require('./app');
const { createDb } = require('./db');
const { createMetaClient } = require('./services/metaClient');
const { loadQuestionsConfig } = require('./services/questionsLoader');
const { log } = require('./utils/logger');

const REQUIRED_ENV_VARS = [
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  // Required, not optional: without this set, POST /webhook signature
  // verification is silently skipped (see webhook.js), which would let
  // anyone who finds the URL post fake WhatsApp events. A deployable build
  // must not be able to boot into that state.
  'WHATSAPP_APP_SECRET',
  'SESSION_SECRET',
  'OWNER_USERNAME',
  'OWNER_PASSWORD',
];

function assertRequiredEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('Copy .env.example to .env and fill in real values before starting the server.');
    process.exit(1);
  }
}

function main() {
  assertRequiredEnv();

  const port = process.env.PORT || 3000;
  const dbPath = process.env.DATABASE_PATH || './data/leads.db';
  const resolvedDbPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);

  const db = createDb(resolvedDbPath);
  const questionsConfig = loadQuestionsConfig();
  const metaClient = createMetaClient({
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  });

  const app = createApp({
    db,
    metaClient,
    questionsConfig,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    appSecret: process.env.WHATSAPP_APP_SECRET,
    sessionSecret: process.env.SESSION_SECRET,
    ownerUsername: process.env.OWNER_USERNAME,
    ownerPassword: process.env.OWNER_PASSWORD,
  });

  app.listen(port, () => {
    log('server_started', { port, dbPath: resolvedDbPath });
    console.log(`WhatsApp Lead Capture running on http://localhost:${port}`);
  });
}

main();
