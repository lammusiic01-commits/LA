'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { runAgentTurn } = require('../src/lib/agent');

function sendSse(response, chunks) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  response.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`);
}

test('LamV1.0 streams OpenAI-compatible tool calls, requests approval, and consumes tool results', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push({ path: request.url, payload });
      if (requests.length === 1) {
        sendSse(response, [
          { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-remember-1', type: 'function', function: { name: 'remember', arguments: '{"note":"Предпочитает короткие ответы на русском."}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      } else {
        sendSse(response, [
          { choices: [{ delta: { role: 'assistant', content: 'Запомнил ' } }] },
          { choices: [{ delta: { content: 'предпочтение.' }, finish_reason: 'stop' }] },
        ]);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const events = [];
  const approvals = [];
  let savedNote = '';
  const controller = new AbortController();
  const output = await runAgentTurn({
    runId: 'test-run-1234', model: 'ignored-model', history: [], text: 'Запомни мой стиль ответа.', attachmentIds: [],
  }, {
    signal: controller.signal,
    workspaceRoot: '/tmp/localis-test-workspace',
    config: { modelBaseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'another-ignored-model', temperature: 0.2 },
    memory: [],
    attachmentsById: new Map(),
    emit: (event) => events.push(event),
    requestApproval: async (approval) => { approvals.push(approval); return true; },
    addMemory: async (note) => { savedNote = note; return { saved: true, note }; },
  });

  assert.equal(output, 'Запомнил предпочтение.');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].name, 'remember');
  assert.equal(savedNote, 'Предпочитает короткие ответы на русском.');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.path === '/v1/chat/completions'));
  assert.ok(requests.every((request) => request.payload.model === 'lam-v1.0'));
  assert.ok(requests.every((request) => request.payload.stream === true));
  assert.ok(requests[0].payload.tools.some((tool) => tool.function.name === 'remember'));
  assert.ok(requests[1].payload.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call-remember-1'));
  assert.ok(requests[1].payload.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call-remember-1' && message.content.includes(savedNote)));
  assert.ok(events.some((event) => event.type === 'tool-running'));
  assert.ok(events.some((event) => event.type === 'turn-complete'));
});

test('Telegram sends are classified high-risk and show their text before tool execution', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      if (requests.length === 1) {
        sendSse(response, [
          { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-telegram-1', type: 'function', function: { name: 'telegram_send_message', arguments: '{"text":"Завтра в 10:00 подтвердите встречу."}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      } else {
        sendSse(response, [{ choices: [{ delta: { role: 'assistant', content: 'Сообщение отправлено.' }, finish_reason: 'stop' }] }]);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const events = [];
  const approvals = [];
  const sent = [];
  const address = server.address();
  const output = await runAgentTurn({
    runId: 'test-telegram-1234', history: [], text: 'Отправь сообщение в Telegram.', attachmentIds: [],
  }, {
    signal: new AbortController().signal,
    workspaceRoot: '/tmp/localis-test-workspace',
    config: { modelBaseUrl: `http://127.0.0.1:${address.port}/v1`, temperature: 0.2, approvalMode: 'ask' },
    connectorTools: [{ type: 'function', function: { name: 'telegram_send_message', description: 'Send Telegram text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }],
    attachmentsById: new Map(),
    emit: (event) => events.push(event),
    requestApproval: async (approval) => { approvals.push(approval); return true; },
    executeConnectorTool: async (name, args) => { sent.push({ name, args }); return { sent: true, messageId: 42 }; },
  });

  assert.equal(output, 'Сообщение отправлено.');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].name, 'telegram_send_message');
  assert.equal(approvals[0].risk, 'high');
  assert.match(approvals[0].arguments, /Завтра в 10:00 подтвердите встречу/);
  assert.deepEqual(sent, [{ name: 'telegram_send_message', args: { text: 'Завтра в 10:00 подтвердите встречу.' } }]);
  assert.ok(requests[0].tools.some((tool) => tool.function.name === 'telegram_send_message'));
  const started = events.find((event) => event.type === 'tool-start');
  assert.match(started.arguments, /Завтра в 10:00 подтвердите встречу/);
  assert.ok(events.some((event) => event.type === 'tool-complete' && event.summary.includes('Telegram')));
});
