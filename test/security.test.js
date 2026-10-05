'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  assertPublicHttpUrl, isPrivateIp, normalizeLocalServiceUrl, resolveWorkspacePath,
} = require('../src/lib/security');
const { safeExistingPath, writeWorkspaceFile } = require('../src/lib/files');

test('blocks private IPs and permits representative public addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.10', '169.254.10.2', '::1', 'fd00::1']) {
    assert.equal(isPrivateIp(address), true, `${address} should be private`);
  }
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
});

test('public web URL validation rejects local addresses and unsafe protocols', async () => {
  await assert.rejects(assertPublicHttpUrl('http://127.0.0.1:11434/api/tags'), /локальн|частн/i);
  await assert.rejects(assertPublicHttpUrl('file:///C:/secret.txt'), /http/i);
  await assert.rejects(assertPublicHttpUrl('https://user:pass@example.com/'), /логин/i);
  assert.equal((await assertPublicHttpUrl('https://8.8.8.8/')).protocol, 'https:');
});

test('image services are restricted to loopback and paths stay in workspace', () => {
  assert.equal(normalizeLocalServiceUrl('http://localhost:8188/path', 'http://127.0.0.1:7860'), 'http://localhost:8188');
  assert.throws(() => normalizeLocalServiceUrl('https://example.com', 'http://127.0.0.1:7860'), /локальным/);
  const root = path.join(os.tmpdir(), 'localis-safe-test');
  assert.equal(resolveWorkspacePath(root, 'src/index.js'), path.join(root, 'src', 'index.js'));
  assert.throws(() => resolveWorkspacePath(root, '../outside.txt'), /выходит за пределы/);
});

test('file operations reject traversal and symlink escapes', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'localis-test-'));
  const root = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));

  const created = await writeWorkspaceFile(root, 'notes/todo.md', 'hello');
  assert.equal(created.path, 'notes/todo.md');
  assert.throws(() => resolveWorkspacePath(root, '../../secret.txt'), /выходит за пределы/);
  const link = path.join(root, 'external');
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(safeExistingPath(root, 'external/secret.txt'), /символьную ссылку/);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
});
