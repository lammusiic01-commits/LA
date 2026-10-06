'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BUILTIN_PLUGINS, activePlugins, installPluginFromUrl, normalizeImportedPlugin } = require('../src/lib/plugins');

test('built-in data, design and motion skills are available and respect enabled settings', () => {
  const all = activePlugins([], ['data-analysis', 'design', 'motion']);
  assert.deepEqual(all.map((plugin) => plugin.id), ['data-analysis', 'design', 'motion']);
  assert.equal(BUILTIN_PLUGINS.some((plugin) => plugin.id === 'frontend'), true);
});

test('imported Markdown or JSON skills are stored as bounded text and support Unicode names', () => {
  const plugin = normalizeImportedPlugin({ name: 'Дизайн-помощник', instructions: 'Проверь сетку, контраст и адаптивность интерфейса перед завершением.' }, 'design.md');
  assert.match(plugin.id, /^custom-дизайн-помощник$/);
  assert.equal(plugin.source, 'design.md');
  assert.equal(plugin.builtin, false);
  assert.throws(() => normalizeImportedPlugin({ name: 'Empty', instructions: 'short' }), /от 20 до/);
});

test('online plugins import only bounded text files without following redirects', async () => {
  const markdown = '# Study skill\n\nCompare sources, cite evidence, and disclose uncertainty.';
  const plugin = await installPluginFromUrl('https://raw.example.com/Study.md', {
    assertUrl: async (value) => new URL(value),
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).hostname, 'raw.example.com');
      assert.equal(options.redirect, 'error');
      return new Response(markdown, { status: 200, headers: { 'content-type': 'text/markdown', 'content-length': String(Buffer.byteLength(markdown)) } });
    },
  });
  assert.equal(plugin.name, 'Study');
  assert.equal(plugin.source, 'https://raw.example.com/Study.md');
  assert.match(plugin.instructions, /Compare sources/);
  await assert.rejects(installPluginFromUrl('https://raw.example.com/plugin.js', { assertUrl: async (value) => new URL(value) }), /исполняемые/);
});
