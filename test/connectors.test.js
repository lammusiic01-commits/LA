'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONNECTOR_CATALOG, CONNECTOR_TOOL_DEFINITIONS, availableConnectorTools } = require('../src/lib/connectors');

test('connector catalog lists direct services and external MCP-backed integrations', () => {
  const ids = CONNECTOR_CATALOG.map((connector) => connector.id);
  for (const id of ['github', 'google', 'instagram', 'notion', 'slack', 'stripe', 'hubspot', 'huggingface', 'zapier']) assert.ok(ids.includes(id));
  assert.ok(CONNECTOR_TOOL_DEFINITIONS.some(({ function: fn }) => fn.name === 'github_commit_file'));
  assert.ok(CONNECTOR_TOOL_DEFINITIONS.some(({ function: fn }) => fn.name === 'google_calendar_create_event'));
  assert.ok(CONNECTOR_TOOL_DEFINITIONS.some(({ function: fn }) => fn.name === 'instagram_publish_image'));
});

test('chat connector tools are exposed only when the corresponding integration is selected and configured', async () => {
  const values = {
    'connectors.github.token': 'ghp_exampletoken',
    'connectors.google': { refreshToken: 'refresh' },
    'connectors.instagram': { token: 'meta', instagramUserId: '123' },
  };
  const vault = { get: async (keys, fallback) => values[keys.join('.')] ?? fallback };
  assert.deepEqual(await availableConnectorTools(vault, []), []);
  const tools = await availableConnectorTools(vault, ['github', 'google']);
  assert.ok(tools.some(({ function: fn }) => fn.name === 'github_read_file'));
  assert.ok(tools.some(({ function: fn }) => fn.name === 'gmail_search'));
  assert.ok(!tools.some(({ function: fn }) => fn.name.startsWith('instagram_')));
  const instagram = await availableConnectorTools(vault, ['instagram']);
  assert.ok(instagram.every(({ function: fn }) => fn.name.startsWith('instagram_')));
});
