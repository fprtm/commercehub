'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'questions.json');

/**
 * NFR-005: the qualifying-question script must be configurable without a
 * code change. Loading happens on demand (not cached at module-load time)
 * so editing config/questions.json takes effect on the next inbound
 * message without restarting -- and so tests can point at a fixture file.
 */
function loadQuestionsConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);

  if (!Array.isArray(config.questions) || config.questions.length !== 2) {
    throw new Error('questions.json must define exactly 2 questions (per FR-002: up to 2 sequential qualifying questions)');
  }
  for (const q of config.questions) {
    if (!q.id || !q.text) {
      throw new Error('Each question in questions.json needs an "id" and "text" field');
    }
  }
  if (!config.acknowledgment || !config.fallbackMessage) {
    throw new Error('questions.json must define "acknowledgment" and "fallbackMessage"');
  }

  return config;
}

module.exports = { loadQuestionsConfig, DEFAULT_CONFIG_PATH };
