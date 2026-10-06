'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpMcpClient, buildMcpToolMap, extractJsonRpc, namespaceMcpTool, toModelTool } = require('../src/lib/mcp');

function rpcResponse(id, result, headers = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

test('MCP JSON-RPC parses JSON and server-sent event responses', () => {
  const json = { jsonrpc: '2.0', id: 4, result: { value: true } };
  assert.deepEqual(extractJsonRpc(JSON.stringify(json), 4), json);
  assert.deepEqual(extractJsonRpc(`event: message\ndata: ${JSON.stringify(json)}\n\n`, 4), json);
  assert.equal(namespaceMcpTool('my-server', 'read file'), 'mcp__my-server__read_file');
});

test('MCP client initializes, lists tools, and calls a namespaced tool', async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push({ payload, headers: options.headers });
    if (payload.method === 'notifications/initialized') return new Response('', { status: 202, headers: { 'mcp-session-id': 'session-1' } });
    if (payload.method === 'initialize') return rpcResponse(payload.id, { protocolVersion: '2025-03-26' }, { 'mcp-session-id': 'session-1' });
    if (payload.method === 'tools/list') return rpcResponse(payload.id, { tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] });
    if (payload.method === 'tools/call') return rpcResponse(payload.id, { content: [{ type: 'text', text: 'file contents' }] });
    throw new Error(`Unexpected MCP method: ${payload.method}`);
  };
  const client = new HttpMcpClient({ url: 'https://mcp.example.com/mcp', token: 'secret-token', fetchImpl });
  const server = { id: 'server-a', name: 'Test MCP', enabled: true };
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  const definition = toModelTool(server, tools[0]);
  assert.equal(definition.function.name, 'mcp__server-a__read_file');
  assert.deepEqual(definition.function.parameters.required, ['path']);
  const map = buildMcpToolMap([{ ...server, tools }], new Map([[server.id, client]]));
  assert.equal(map.get(definition.function.name).tool.name, 'read_file');
  const result = await client.callTool('read_file', { path: 'README.md' });
  assert.equal(result.content[0].text, 'file contents');
  assert.equal(requests.at(-1).payload.method, 'tools/call');
  assert.equal(requests.at(-1).headers.authorization, 'Bearer secret-token');
  assert.ok(requests.slice(1).every((request) => request.headers['mcp-session-id'] === 'session-1'));
});
