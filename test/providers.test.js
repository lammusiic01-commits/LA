'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, providerInfo, safeMessages } = require('../src/lib/providers');

test('supported providers expose executable completion endpoints and defaults', () => {
  for (const id of ['openai', 'deepseek', 'openrouter', 'xai']) {
    const provider = providerInfo(id);
    assert.match(provider.endpoint, /^https:\/\//);
    assert.ok(provider.defaultModel);
  }
  assert.equal(Object.keys(PROVIDERS).length, 4);
  assert.throws(() => providerInfo('unknown'), /неизвестный/i);
});

test('cloud provider context excludes tool calls and bounds history/content', () => {
  const input = [
    { role: 'tool', content: 'private tool response' },
    { role: 'system', content: 'context' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ];
  assert.deepEqual(safeMessages(input), [
    { role: 'system', content: 'context' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ]);
  assert.equal(safeMessages(Array.from({ length: 40 }, (_, index) => ({ role: 'user', content: `${index}` }))).length, 32);
  assert.equal(safeMessages([{ role: 'user', content: 'a'.repeat(30_000) }])[0].content.length, 24_000);
  const key = 'sk-proj-' + 'Z'.repeat(30);
  assert.doesNotMatch(safeMessages([{ role: 'user', content: `Do not transmit ${key}` }])[0].content, /sk-proj-/);
});
