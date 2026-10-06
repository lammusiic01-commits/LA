'use strict';

const { randomUUID } = require('node:crypto');

const PROTOCOL_VERSION = '2025-03-26';

function extractJsonRpc(text, requestId) {
  const candidates = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const value = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!value || value === '[DONE]') continue;
    try { candidates.push(JSON.parse(value)); } catch { /* ignore SSE event labels and logs */ }
  }
  return candidates.find((item) => item?.id === requestId) || candidates.at(-1) || null;
}

class HttpMcpClient {
  constructor({ url, token = '', fetchImpl = fetch }) {
    this.url = new URL(url);
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.sessionId = '';
    this.requestId = 0;
    this.initialized = false;
  }

  async request(method, params = {}, signal) {
    const id = ++this.requestId;
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const response = await this.fetchImpl(this.url, {
      method: 'POST', redirect: 'error', headers, signal,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new Error(`MCP ${method} вернул HTTP ${response.status}: ${detail}`);
    }
    this.sessionId ||= response.headers.get('mcp-session-id') || '';
    const body = await response.text();
    const rpc = extractJsonRpc(body, id);
    if (!rpc) throw new Error(`MCP ${method} не вернул JSON-RPC ответ.`);
    if (rpc.error) throw new Error(`MCP ${method}: ${rpc.error.message || 'ошибка сервера'}`);
    return rpc.result;
  }

  async initialize(signal) {
    if (this.initialized) return;
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Localis', version: '1.1.0' },
    }, signal);
    this.initialized = true;
    await this.notify('notifications/initialized');
  }

  async notify(method, params = {}) {
    const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL_VERSION };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const response = await this.fetchImpl(this.url, { method: 'POST', redirect: 'error', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params }) });
    if (![200, 202, 204].includes(response.status)) throw new Error(`MCP notification вернула HTTP ${response.status}.`);
  }

  async listTools(signal) {
    await this.initialize(signal);
    const result = await this.request('tools/list', {}, signal);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, argumentsValue, signal) {
    await this.initialize(signal);
    const result = await this.request('tools/call', { name, arguments: argumentsValue || {} }, signal);
    if (result?.isError) throw new Error((result.content || []).map((item) => item.text || '').join('\n').slice(0, 3000) || `Инструмент MCP ${name} сообщил об ошибке.`);
    return result;
  }
}

function namespaceMcpTool(serverId, toolName) {
  const clean = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 48) || 'tool';
  return `mcp__${clean(serverId)}__${clean(toolName)}`;
}

function toModelTool(server, tool) {
  const parameters = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
  const serialized = JSON.stringify(parameters);
  if (serialized.length > 12_000) throw new Error(`Схема инструмента MCP «${tool.name}» превышает лимит.`);
  return {
    type: 'function', function: {
      name: namespaceMcpTool(server.id, tool.name),
      description: `[MCP · ${String(server.name || server.id).slice(0, 80)}] ${String(tool.description || tool.name).slice(0, 900)}`,
      parameters,
    },
  };
}

function buildMcpToolMap(servers, clientById) {
  const map = new Map();
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server?.enabled) continue;
    const tools = Array.isArray(server.tools) ? server.tools : [];
    for (const tool of tools) {
      const name = namespaceMcpTool(server.id, tool.name);
      map.set(name, { server, tool, client: clientById.get(server.id) });
    }
  }
  return map;
}

module.exports = { HttpMcpClient, PROTOCOL_VERSION, buildMcpToolMap, extractJsonRpc, namespaceMcpTool, toModelTool };
