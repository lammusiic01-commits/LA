'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONNECTOR_CATALOG, CONNECTOR_TOOL_DEFINITIONS, availableConnectorTools } = require('../src/lib/connectors');

test('connector catalog lists direct services and external MCP-backed integrations', () => {
  const ids = CONNECTOR_CATALOG.map((connector) => connector.id);
  for (const id of ['github', 'google', 'instagram', 'telegram', 'notion', 'slack', 'stripe', 'hubspot', 'huggingface', 'zapier']) assert.ok(ids.includes(id));
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

test('Telegram bot tools require selected token and chat ID, and credential validation is strict', async () => {
  const { validateTelegramCredentials } = require('../src/lib/connectors');
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
  assert.deepEqual(validateTelegramCredentials(token, '-10012345678'), { token, chatId: '-10012345678' });
  assert.throws(() => validateTelegramCredentials('not-a-token', '-10012345678'), /неверный формат/);
  assert.throws(() => validateTelegramCredentials(token, 'chat id with spaces'), /Chat ID/);

  const vault = {
    get: async (keys, fallback) => keys.join('.') === 'connectors.telegram'
      ? { botToken: token, chatId: '-10012345678' }
      : fallback,
  };
  assert.ok(!(await availableConnectorTools(vault, [])).some(({ function: fn }) => fn.name.startsWith('telegram_')));
  const telegramTools = await availableConnectorTools(vault, ['telegram']);
  assert.equal(telegramTools.length, 1);
  assert.equal(telegramTools[0].function.name, 'telegram_send_message');
});

test('Telegram connection checks the bot and configured chat, and message send calls only the HTTPS Bot API', async (t) => {
  const { testTelegram, executeConnectorTool } = require('../src/lib/connectors');
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
  const chatId = '-10012345678';
  const calls = [];
  const telegramFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed.href, method: options.method, body: options.body ? JSON.parse(options.body) : {} });
    const method = parsed.pathname.split('/').at(-1);
    const result = method === 'getMe'
      ? { id: 123456789, is_bot: true, username: 'localis_helper_bot' }
      : method === 'getChat'
        ? { id: -10012345678, type: 'supergroup', title: 'Localis updates' }
        : { message_id: 87, chat: { id: -10012345678 } };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const identity = await testTelegram({ token, chatId }, { fetchImpl: telegramFetch });
  assert.deepEqual(identity, { connected: true, botUsername: 'localis_helper_bot', chatId: '-10012345678', chatName: 'Localis updates' });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url.startsWith('https://api.telegram.org/bot')));
  assert.ok(calls[0].url.endsWith('/getMe'));
  assert.ok(calls[1].url.endsWith('/getChat'));

  const originalFetch = global.fetch;
  global.fetch = telegramFetch;
  t.after(() => { global.fetch = originalFetch; });
  const vault = {
    get: async (keys, fallback) => keys.join('.') === 'connectors.telegram'
      ? { botToken: token, chatId }
      : fallback,
  };
  const sent = await executeConnectorTool('telegram_send_message', { text: 'Проверка из Localis' }, { vault });
  assert.deepEqual(sent, { sent: true, messageId: 87, chatId, textLength: 'Проверка из Localis'.length });
  assert.equal(calls.length, 3);
  assert.ok(calls[2].url.endsWith('/sendMessage'));
  assert.deepEqual(calls[2].body, { chat_id: chatId, text: 'Проверка из Localis', disable_web_page_preview: true });
});

test('Telegram API errors do not echo the bot token', async () => {
  const { testTelegram } = require('../src/lib/connectors');
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
  await assert.rejects(
    testTelegram({ token, chatId: '-10012345678' }, {
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, description: `Unauthorized bot${token}` }), { status: 401 }),
    }),
    (error) => {
      assert.match(error.message, /\[bot token\]/);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    },
  );
});
