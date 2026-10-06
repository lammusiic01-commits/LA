'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSystemPrompt, normalizeOpenAiMessages, readOpenAiStream, sanitizeHistory } = require('../src/lib/agent');
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

test('system prompt identifies LamV1.0 and explains the local tool and memory boundaries', () => {
  const prompt = makeSystemPrompt({ workspaceRoot: 'C:\\Localis', memory: [{ note: 'Писать по-русски' }], model: 'lam-v1.0' });
  assert.match(prompt, /LamV1\.0/);
  assert.match(prompt, /lam-v1\.0/);
  assert.match(prompt, /не дообучает модель/);
  assert.match(prompt, /Писать по-русски/);
});

test('tool arguments accept parsed objects and JSON strings', () => {
  assert.deepEqual(parseArguments({ function: { arguments: { query: 'test' } } }), { query: 'test' });
  assert.deepEqual(parseArguments({ function: { arguments: '{"query":"test"}' } }), { query: 'test' });
  assert.throws(() => parseArguments({ function: { arguments: 'not json' } }), /некорректные/);
});

test('OpenAI-compatible SSE parser streams text and assembles fragmented tool calls', async () => {
  const messages = [];
  const chunks = [
    { choices: [{ delta: { content: 'Сейчас ищу. ', tool_calls: [{ index: 0, id: 'call-search-1', type: 'function', function: { name: 'web_' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: '{"query":"Lam' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'V1.0"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  const result = await readOpenAiStream(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), (text) => messages.push(text));
  assert.equal(result.content, 'Сейчас ищу. ');
  assert.equal(messages.join(''), result.content);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call-search-1');
  assert.equal(result.toolCalls[0].function.name, 'web_search');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { query: 'LamV1.0' });
});

test('OpenAI message normalization retains tool-call IDs and rejects images for the text model', () => {
  const normalized = normalizeOpenAiMessages([
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'remember', arguments: { note: 'local note' } } }] },
    { role: 'tool', name: 'remember', tool_call_id: 'call-1', content: 'Saved.' },
  ]);
  assert.deepEqual(normalized, [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'remember', arguments: '{"note":"local note"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'Saved.' },
  ]);
  assert.throws(() => normalizeOpenAiMessages([{ role: 'user', content: 'Describe', images: ['base64'] }]), /текстовая модель/);
});
