'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class SecretVault {
  constructor({ filePath, safeStorage }) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.cache = null;
  }

  assertEncryption() {
    if (!this.safeStorage || typeof this.safeStorage.isEncryptionAvailable !== 'function' || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Защищённое хранилище Windows недоступно. Секреты не будут сохранены в открытом виде.');
    }
  }

  async read() {
    if (this.cache) return structuredClone(this.cache);
    try {
      const encrypted = await fs.readFile(this.filePath);
      this.assertEncryption();
      const decoded = this.safeStorage.decryptString(encrypted);
      const value = JSON.parse(decoded);
      this.cache = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.cache = {};
      } else {
        this.cache = {};
        throw new Error(`Не удалось открыть зашифрованное хранилище: ${error.message}`);
      }
    }
    return structuredClone(this.cache);
  }

  async get(pathKeys, fallback = undefined) {
    const keys = Array.isArray(pathKeys) ? pathKeys : [pathKeys];
    let value = await this.read();
    for (const key of keys) value = value?.[key];
    return value === undefined ? fallback : value;
  }

  async set(pathKeys, value) {
    const keys = Array.isArray(pathKeys) ? pathKeys : [pathKeys];
    if (!keys.length || keys.some((key) => !/^[\w-]{1,80}$/.test(String(key)))) throw new Error('Некорректный путь секрета.');
    const store = await this.read();
    let target = store;
    for (const key of keys.slice(0, -1)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      target = target[key];
    }
    target[keys.at(-1)] = value;
    await this.write(store);
  }

  async remove(pathKeys) {
    const keys = Array.isArray(pathKeys) ? pathKeys : [pathKeys];
    const store = await this.read();
    let target = store;
    for (const key of keys.slice(0, -1)) target = target?.[key];
    if (!target || typeof target !== 'object') return;
    delete target[keys.at(-1)];
    await this.write(store);
  }

  async write(value) {
    this.assertEncryption();
    const encrypted = this.safeStorage.encryptString(JSON.stringify(value));
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, encrypted, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    this.cache = structuredClone(value);
  }
}

module.exports = { SecretVault };
