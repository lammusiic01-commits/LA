'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installGithubAgent, parseGithubRepository } = require('../src/lib/agents');

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('GitHub agent URLs only accept an owner and repository on github.com', () => {
  assert.deepEqual(parseGithubRepository('https://github.com/example/skill.git'), {
    owner: 'example', repo: 'skill', canonicalUrl: 'https://github.com/example/skill', slug: 'example-skill',
  });
  assert.throws(() => parseGithubRepository('https://example.com/a/b'), /GitHub/);
  assert.throws(() => parseGithubRepository('https://github.com/a/b/tree/main'), /корень репозитория/);
});

test('GitHub installation imports Markdown instructions only, without cloning or running repository code', async () => {
  const requested = [];
  const skillText = '# Research skill\n\nInspect source text carefully. Never execute downloaded code.';
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    requested.push(new URL(url).pathname);
    if (requested.length === 1) return response({ private: false, full_name: 'example/skill', default_branch: 'main' });
    if (requested.length === 2) return response([
      { name: 'SKILL.md', type: 'file', size: Buffer.byteLength(skillText) },
      { name: 'setup.js', type: 'file', size: 300 },
    ]);
    if (requested.length === 3) return response({ encoding: 'base64', content: Buffer.from(skillText).toString('base64') });
    throw new Error(`Unexpected request: ${url}`);
  };
  const progress = [];
  const installed = await installGithubAgent({
    repositoryUrl: 'https://github.com/example/skill',
    fetchImpl,
    assertUrl: async (value) => new URL(value),
    onProgress: (event) => progress.push(event.message),
  });
  assert.equal(installed.name, 'example/skill');
  assert.equal(installed.execution, 'prompt-skill-only');
  assert.equal(installed.instructions, `## SKILL.md\n${skillText}`);
  assert.deepEqual(installed.skillFiles, ['SKILL.md']);
  assert.equal(requested.length, 3);
  assert.ok(progress.some((message) => message.includes('текстовые инструкции')));
});

test('private GitHub repositories are rejected before reading skill files', async () => {
  let calls = 0;
  await assert.rejects(installGithubAgent({
    repositoryUrl: 'https://github.com/example/private-skill',
    fetchImpl: async () => { calls += 1; return response({ private: true, default_branch: 'main' }); },
    assertUrl: async (value) => new URL(value),
  }), /публичный/);
  assert.equal(calls, 1);
});
