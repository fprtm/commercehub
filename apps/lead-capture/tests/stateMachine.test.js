'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideNextAction, ACTIONS, DEFAULT_RETRY_PREFIX } = require('../src/services/stateMachine');

const CONFIG = {
  acknowledgment: 'This is an automated reply from Rimba Apparel...',
  questions: [
    { id: 'q1', text: 'Which product are you interested in?' },
    { id: 'q2', text: 'What size / how should we contact you?' },
  ],
  fallbackMessage: 'A team member will follow up with you shortly.',
  completionMessage: "Thanks! We've got what we need.",
};

function baseLead(overrides = {}) {
  return {
    id: 1,
    phone_number: '6281234567890',
    first_message_at: '2026-09-01T00:00:00.000Z',
    question1_answer: null,
    question2_answer: null,
    status: 'new',
    fallback_triggered: 0,
    retry_count: 0,
    ...overrides,
  };
}

test('T-005 state machine: new phone number (no existing lead) starts the flow', () => {
  const result = decideNextAction({ existingLead: null, messageText: 'halo, baju ini masih ada?', config: CONFIG });
  assert.equal(result.action, ACTIONS.START_FLOW);
  assert.equal(result.createLead, true);
  assert.deepEqual(result.replies, [CONFIG.acknowledgment, CONFIG.questions[0].text]);
  assert.equal(result.leadPatch, null);
});

test('T-005 state machine: new phone number with undefined existingLead also starts the flow', () => {
  const result = decideNextAction({ existingLead: undefined, messageText: 'hi', config: CONFIG });
  assert.equal(result.action, ACTIONS.START_FLOW);
});

test('T-005 state machine: valid answer to Q1 saves it, resets retry count, and sends Q2', () => {
  const lead = baseLead();
  const result = decideNextAction({ existingLead: lead, messageText: 'Kaos Rimba Hitam', config: CONFIG });
  assert.equal(result.action, ACTIONS.ANSWER_Q1);
  assert.deepEqual(result.replies, [CONFIG.questions[1].text]);
  assert.equal(result.createLead, false);
  assert.deepEqual(result.leadPatch, {
    question1Answer: 'Kaos Rimba Hitam',
    question2Answer: null,
    fallbackTriggered: false,
    retryCount: 0,
  });
});

test('T-005 state machine: valid answer to Q2 completes the flow', () => {
  const lead = baseLead({ question1_answer: 'Kaos Rimba Hitam' });
  const result = decideNextAction({ existingLead: lead, messageText: 'Size L, WhatsApp aja', config: CONFIG });
  assert.equal(result.action, ACTIONS.ANSWER_Q2);
  assert.deepEqual(result.replies, [CONFIG.completionMessage]);
  assert.deepEqual(result.leadPatch, {
    question1Answer: 'Kaos Rimba Hitam',
    question2Answer: 'Size L, WhatsApp aja',
    fallbackTriggered: false,
    retryCount: 0,
  });
});

test('T-005/FR-002 state machine: first unusable message while awaiting Q1 retries once (does not fall back yet)', () => {
  const lead = baseLead();
  const result = decideNextAction({ existingLead: lead, messageText: null, config: CONFIG });
  assert.equal(result.action, ACTIONS.RETRY);
  assert.deepEqual(result.replies, [`${DEFAULT_RETRY_PREFIX}${CONFIG.questions[0].text}`]);
  assert.deepEqual(result.leadPatch, {
    question1Answer: null,
    question2Answer: null,
    fallbackTriggered: false,
    retryCount: 1,
  });
});

test('T-005/FR-002 state machine: whitespace-only message while awaiting Q1 (first attempt) retries once', () => {
  const lead = baseLead();
  const result = decideNextAction({ existingLead: lead, messageText: '   ', config: CONFIG });
  assert.equal(result.action, ACTIONS.RETRY);
});

test('T-005/FR-002 state machine: a second unusable message in a row while awaiting Q1 (retry already used) falls back', () => {
  const lead = baseLead({ retry_count: 1 });
  const result = decideNextAction({ existingLead: lead, messageText: null, config: CONFIG });
  assert.equal(result.action, ACTIONS.FALLBACK);
  assert.deepEqual(result.replies, [CONFIG.fallbackMessage]);
  assert.equal(result.leadPatch.fallbackTriggered, true);
});

test('T-005/FR-002 state machine: a usable answer after one retry still succeeds normally (retry does not poison the flow)', () => {
  const lead = baseLead({ retry_count: 1 });
  const result = decideNextAction({ existingLead: lead, messageText: 'Kaos Rimba Hitam', config: CONFIG });
  assert.equal(result.action, ACTIONS.ANSWER_Q1);
  assert.equal(result.leadPatch.retryCount, 0);
});

test('T-005/FR-002 state machine: first unusable message while awaiting Q2 retries once and preserves the Q1 answer', () => {
  const lead = baseLead({ question1_answer: 'Kaos Rimba Hitam' });
  const result = decideNextAction({ existingLead: lead, messageText: null, config: CONFIG });
  assert.equal(result.action, ACTIONS.RETRY);
  assert.deepEqual(result.replies, [`${DEFAULT_RETRY_PREFIX}${CONFIG.questions[1].text}`]);
  assert.deepEqual(result.leadPatch, {
    question1Answer: 'Kaos Rimba Hitam',
    question2Answer: null,
    fallbackTriggered: false,
    retryCount: 1,
  });
});

test('T-005/FR-002 state machine: a second unusable message in a row while awaiting Q2 (retry already used) falls back and preserves Q1 answer', () => {
  const lead = baseLead({ question1_answer: 'Kaos Rimba Hitam', retry_count: 1 });
  const result = decideNextAction({ existingLead: lead, messageText: null, config: CONFIG });
  assert.equal(result.action, ACTIONS.FALLBACK);
  assert.deepEqual(result.replies, [CONFIG.fallbackMessage]);
  assert.equal(result.leadPatch.question1Answer, 'Kaos Rimba Hitam');
  assert.equal(result.leadPatch.question2Answer, null);
  assert.equal(result.leadPatch.fallbackTriggered, true);
});

test('T-005/FR-002 state machine: a config-supplied retryPrefix overrides the default', () => {
  const lead = baseLead();
  const customConfig = { ...CONFIG, retryPrefix: 'Hmm, ' };
  const result = decideNextAction({ existingLead: lead, messageText: null, config: customConfig });
  assert.equal(result.action, ACTIONS.RETRY);
  assert.deepEqual(result.replies, [`Hmm, ${CONFIG.questions[0].text}`]);
});

test('T-005 state machine: further messages after fallback already triggered are a no-op', () => {
  const lead = baseLead({ fallback_triggered: 1 });
  const result = decideNextAction({ existingLead: lead, messageText: 'are you there?', config: CONFIG });
  assert.equal(result.action, ACTIONS.NO_OP);
  assert.deepEqual(result.replies, []);
  assert.equal(result.reason, 'fallback_already_triggered');
});

test('T-005 state machine: further messages after flow already complete are a no-op', () => {
  const lead = baseLead({ question1_answer: 'Kaos Hitam', question2_answer: 'L' });
  const result = decideNextAction({ existingLead: lead, messageText: 'thanks!', config: CONFIG });
  assert.equal(result.action, ACTIONS.NO_OP);
  assert.equal(result.reason, 'flow_already_complete');
});

test('T-005 state machine: messages after owner marked lead "responded" are a no-op', () => {
  const lead = baseLead({ status: 'responded' });
  const result = decideNextAction({ existingLead: lead, messageText: 'still there?', config: CONFIG });
  assert.equal(result.action, ACTIONS.NO_OP);
  assert.equal(result.reason, 'lead_status_responded');
});

test('T-005 state machine: messages after owner marked lead "closed" are a no-op', () => {
  const lead = baseLead({ status: 'closed', question1_answer: 'x' });
  const result = decideNextAction({ existingLead: lead, messageText: 'hello again', config: CONFIG });
  assert.equal(result.action, ACTIONS.NO_OP);
  assert.equal(result.reason, 'lead_status_closed');
});

test('T-005 state machine: an unrelated question during Q1 is still accepted as a free-text answer (judgment call: no semantic validation in scope)', () => {
  const lead = baseLead();
  const result = decideNextAction({ existingLead: lead, messageText: 'do you ship to Bali?', config: CONFIG });
  assert.equal(result.action, ACTIONS.ANSWER_Q1);
  assert.equal(result.leadPatch.question1Answer, 'do you ship to Bali?');
});

test('T-005 state machine: config with no completionMessage sends no reply on Q2 completion', () => {
  const lead = baseLead({ question1_answer: 'Kaos Hitam' });
  const configNoCompletion = { ...CONFIG, completionMessage: undefined };
  const result = decideNextAction({ existingLead: lead, messageText: 'L', config: configNoCompletion });
  assert.equal(result.action, ACTIONS.ANSWER_Q2);
  assert.deepEqual(result.replies, []);
});
