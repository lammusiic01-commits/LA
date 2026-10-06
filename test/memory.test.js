'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appendTurn, normalizeMemory, redactSensitive } = require('../src/lib/memory');

test('memory summaries redact common API secrets before persistence', () => {
  const secret = 'sk-proj-' + 'A'.repeat(32);
  const result = appendTurn({ entries: [], summary: '' }, {
    request: `Please use api_key=${secret}`,
    outcome: `Authorization: Bearer ${'B'.repeat(40)}; github_pat_${'C'.repeat(30)}`,
    project: 'Localis',
  });
  assert.match(result.summary, /секрет удалён/);
  assert.doesNotMatch(result.summary, /sk-proj-|BBBBBBBB|github_pat_C/);
  assert.equal(normalizeMemory(result).entries.length, 1);
});

test('memory storage remains bounded and keeps only the recent task summary', () => {
  let state = { entries: [], summary: '' };
  for (let index = 0; index < 100; index += 1) state = appendTurn(state, { request: `request-${index}`, outcome: `result-${index}` });
  assert.ok(state.entries.length <= 80);
  assert.ok(state.summary.length <= 10_000);
  assert.match(state.summary, /request-99/);
  assert.doesNotMatch(state.summary, /request-0\n/);
  assert.equal(redactSensitive('token: abc123456789secret'), 'token=[секрет удалён]');
});
