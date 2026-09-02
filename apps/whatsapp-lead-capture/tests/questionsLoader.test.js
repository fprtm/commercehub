'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadQuestionsConfig, DEFAULT_CONFIG_PATH } = require('../src/services/questionsLoader');

test('NFR-005 loadQuestionsConfig: loads the real config/questions.json shipped with the app', () => {
  const config = loadQuestionsConfig();
  assert.equal(config.questions.length, 2);
  assert.ok(config.acknowledgment.length > 0);
  assert.ok(fs.existsSync(DEFAULT_CONFIG_PATH));
});

test('NFR-005 loadQuestionsConfig: swapping in a different config file changes the questions with no code change', () => {
  const tmpPath = path.join(os.tmpdir(), `questions-test-${Date.now()}.json`);
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({
      acknowledgment: 'Custom ack',
      questions: [
        { id: 'q1', text: 'Custom question 1' },
        { id: 'q2', text: 'Custom question 2' },
      ],
      fallbackMessage: 'Custom fallback',
    }),
  );
  try {
    const config = loadQuestionsConfig(tmpPath);
    assert.equal(config.questions[0].text, 'Custom question 1');
    assert.equal(config.acknowledgment, 'Custom ack');
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('loadQuestionsConfig: rejects a config with the wrong number of questions', () => {
  const tmpPath = path.join(os.tmpdir(), `questions-bad-${Date.now()}.json`);
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({ acknowledgment: 'x', questions: [{ id: 'q1', text: 'only one' }], fallbackMessage: 'y' }),
  );
  try {
    assert.throws(() => loadQuestionsConfig(tmpPath), /exactly 2 questions/);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('loadQuestionsConfig: rejects a config missing required top-level fields', () => {
  const tmpPath = path.join(os.tmpdir(), `questions-bad2-${Date.now()}.json`);
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({ questions: [{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }] }),
  );
  try {
    assert.throws(() => loadQuestionsConfig(tmpPath), /acknowledgment/);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});
