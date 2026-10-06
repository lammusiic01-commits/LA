'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSystemPrompt, readOllamaStream, sanitizeHistory } = require('../src/lib/agent');
const { parseArguments } = require('../src/lib/tools');

test('chat history only accepts user and assistant text messages', () => {
  const history = sanitizeHistory([
    { role: 'system', content: 'bad' },
    { role: 'tool', content: 'bad' },
    { role: 'user', content: 'Привет' },
    { role: 'assistant', content: 'Здравствуйте' },
  ]);
  assert.deepEqual(history, [
    { role: 'user', content: 'Привет' },
    { role: 'assistant', content: 'Здравствуйте' },
  ]);
});

test('system prompt explains the local tool and memory boundaries', () => {
  const prompt = makeSystemPrompt({ workspaceRoot: 'C:\\Localis', memory: [{ note: 'Писать по-русски' }], model: 'gemma4:26b' });
  assert.match(prompt, /gemma4:26b/);
  assert.match(prompt, /не обучение весов/);
  assert.match(prompt, /Писать по-русски/);
});

test('tool arguments support Ollama object and JSON-string forms', () => {
  assert.deepEqual(parseArguments({ function: { arguments: { query: 'test' } } }), { query: 'test' });
  assert.deepEqual(parseArguments({ function: { arguments: '{"query":"test"}' } }), { query: 'test' });
  assert.throws(() => parseArguments({ function: { arguments: 'not json' } }), /некорректные/);
});

test('Ollama NDJSON parser streams text and accumulates native tool calls', async () => {
  const messages = [];
  const body = [
    JSON.stringify({ message: { content: 'Сейчас ищу. ' }, done: false }),
    JSON.stringify({ message: { content: '', tool_calls: [{ type: 'function', function: { name: 'web_search', arguments: { query: 'Ollama' } } }] }, done: true }),
  ].join('\n');
  const result = await readOllamaStream(new Response(body), (text) => messages.push(text));
  assert.equal(result.content, 'Сейчас ищу. ');
  assert.equal(messages.join(''), result.content);
  assert.equal(result.toolCalls[0].function.name, 'web_search');
  assert.deepEqual(result.toolCalls[0].function.arguments, { query: 'Ollama' });
});
