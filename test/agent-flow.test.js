'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { runAgentTurn } = require('../src/lib/agent');

function sendNdjson(response, chunk) {
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  response.end(`${JSON.stringify(chunk)}\n`);
}

test('agent asks for approval, executes an approved tool, and feeds its result back to Ollama', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      if (requests.length === 1) {
        sendNdjson(response, {
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ type: 'function', function: { name: 'remember', arguments: { note: 'Предпочитает короткие ответы на русском.' } } }],
          },
          done: true,
        });
      } else {
        sendNdjson(response, { message: { role: 'assistant', content: 'Запомнил предпочтение.', tool_calls: [] }, done: true });
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
    runId: 'test-run-1234', model: 'mock-model', history: [], text: 'Запомни мой стиль ответа.', attachmentIds: [],
  }, {
    signal: controller.signal,
    workspaceRoot: '/tmp/localis-test-workspace',
    config: { ollamaBaseUrl: `http://127.0.0.1:${address.port}`, model: 'mock-model', temperature: 0.2 },
    memory: [],
    attachmentsById: new Map(),
    emit: (event) => events.push(event),
    requestApproval: async (approval) => { approvals.push(approval); return true; },
    openBrowser: async () => {},
    addMemory: async (note) => { savedNote = note; return { saved: true, note }; },
  });

  assert.equal(output, 'Запомнил предпочтение.');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].name, 'remember');
  assert.equal(savedNote, 'Предпочитает короткие ответы на русском.');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some((message) => message.role === 'tool' && message.tool_name === 'remember'));
  assert.ok(events.some((event) => event.type === 'tool-running'));
  assert.ok(events.some((event) => event.type === 'turn-complete'));
});
