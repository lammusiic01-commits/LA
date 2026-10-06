'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { defaultConfig, normalizeMcpServers, validateConfig } = require('../src/lib/config');

test('LamV1.0 is the only accepted local model alias', () => {
  const documentsPath = path.join(path.sep, 'tmp', 'documents');
  const defaults = defaultConfig(documentsPath);
  const config = validateConfig({ ...defaults, model: 'arbitrary-model' }, documentsPath);
  assert.equal(defaults.model, 'lam-v1.0');
  assert.equal(config.model, 'lam-v1.0');
});

test('general settings preserve supported language, theme and permission modes', () => {
  const defaults = defaultConfig(path.join(path.sep, 'tmp', 'documents'));
  const config = validateConfig({
    ...defaults,
    uiLanguage: 'lv',
    theme: 'forest',
    approvalMode: 'full',
    temperature: 0.8,
    enabledPluginIds: ['design', 'design', 'custom-demo'],
  }, path.join(path.sep, 'tmp', 'documents'));
  assert.equal(config.uiLanguage, 'lv');
  assert.equal(config.theme, 'forest');
  assert.equal(config.approvalMode, 'full');
  assert.deepEqual(config.enabledPluginIds, ['design', 'custom-demo']);
});

test('MCP settings allow HTTPS public endpoints and localhost HTTP only', () => {
  const servers = normalizeMcpServers([
    { id: 'notion', name: 'Notion', url: 'https://mcp.example.com/mcp', enabled: true },
    { id: 'local', name: 'Local', url: 'http://127.0.0.1:9000/mcp', enabled: true },
    { id: 'unsafe-http', name: 'Unsafe', url: 'http://mcp.example.com/mcp', enabled: true },
    { id: 'private-ip', name: 'Private', url: 'https://192.168.1.20/mcp', enabled: true },
  ]);
  assert.deepEqual(servers.map((server) => server.id), ['notion', 'local']);
});

test('configuration clamps invalid temperature and falls back to allowed enumerations', () => {
  const config = validateConfig({ temperature: 99, theme: 'rainbow', uiLanguage: 'xx', approvalMode: 'unrestricted' }, '/tmp/documents');
  assert.equal(config.temperature, 1.5);
  assert.equal(config.theme, 'midnight');
  assert.equal(config.uiLanguage, 'ru');
  assert.equal(config.approvalMode, 'ask');
});
