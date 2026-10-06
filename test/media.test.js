'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { runProcess } = require('../src/lib/media');

test('approved shell runner captures output and exits cleanly', async () => {
  const command = process.platform === 'win32' ? 'echo localis-ready' : 'printf localis-ready';
  const result = await runProcess(command, [], { cwd: os.tmpdir(), timeoutMs: 5000, shell: true });
  assert.equal(result.code, 0);
  assert.match(result.output, /localis-ready/);
});
