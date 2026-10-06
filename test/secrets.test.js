'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SecretVault, removeLegacyProviderCredentials } = require('../src/lib/secrets');

function testSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`test-cipher:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => Buffer.from(value.toString().replace(/^test-cipher:/, ''), 'base64').toString('utf8'),
  };
}

test('secret vault persists credentials only through the operating-system encryption adapter', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'localis-vault-test-'));
  const filePath = path.join(parent, 'secrets.enc');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const key = 'example-secret-token-12345';
  const vault = new SecretVault({ filePath, safeStorage: testSafeStorage() });
  await vault.set(['connectors', 'telegram'], { botToken: key, chatId: '-10012345678' });
  const encrypted = await fs.readFile(filePath, 'utf8');
  assert.doesNotMatch(encrypted, /example-secret-token/);
  const reopened = new SecretVault({ filePath, safeStorage: testSafeStorage() });
  assert.equal((await reopened.get(['connectors', 'telegram'])).botToken, key);
  await reopened.remove(['connectors', 'telegram']);
  assert.equal(await reopened.get(['connectors', 'telegram'], null), null);
});

test('legacy cloud-model API credentials are purged without touching connector secrets', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'localis-vault-migration-'));
  const filePath = path.join(parent, 'secrets.enc');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const vault = new SecretVault({ filePath, safeStorage: testSafeStorage() });
  await vault.set(['providers', 'openai'], { key: 'legacy-api-secret' });
  await vault.set(['connectors', 'telegram'], { botToken: 'telegram-token', chatId: '-10012345678' });
  assert.equal(await removeLegacyProviderCredentials(vault), true);
  assert.equal(await vault.get(['providers'], null), null);
  assert.deepEqual(await vault.get(['connectors', 'telegram']), { botToken: 'telegram-token', chatId: '-10012345678' });
  assert.equal(await removeLegacyProviderCredentials(vault), false);
});

test('secret vault refuses to write plaintext when OS encryption is unavailable', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'localis-vault-test-'));
  const filePath = path.join(parent, 'secrets.enc');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const vault = new SecretVault({ filePath, safeStorage: testSafeStorage(false) });
  await assert.rejects(vault.set(['connectors', 'github'], { token: 'never-write-plaintext' }), /не будут сохранены в открытом виде/);
  await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
});
