'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODEL_ID = 'lam-v1.0';
const MODEL_FILE = 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf';
const MODEL_TITLE = 'LamV1.0 · Qwen3 4B Q4_K_M';
const START_TIMEOUT_MS = 180_000;

function engineAssetPaths(assetRoot) {
  return {
    launcher: path.join(assetRoot, 'localis-engine.exe'),
    runtime: path.join(assetRoot, 'localis-runtime', 'llama-server.exe'),
    model: path.join(assetRoot, 'models', MODEL_FILE),
    runtimeDirectory: path.join(assetRoot, 'localis-runtime'),
  };
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LocalisEngine extends EventEmitter {
  constructor({ assetRoot, spawnImpl = spawn, fetchImpl = fetch, startTimeoutMs = START_TIMEOUT_MS, logger = console } = {}) {
    super();
    if (!assetRoot) throw new Error('Localis Engine asset root is required.');
    this.assetRoot = path.resolve(assetRoot);
    this.paths = engineAssetPaths(this.assetRoot);
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.startTimeoutMs = startTimeoutMs;
    this.logger = logger;
    this.child = null;
    this.startPromise = null;
    this.port = null;
    this.ready = false;
    this.lastError = '';
    this.logs = '';
  }

  async inspectAssets() {
    const files = [this.paths.launcher, this.paths.runtime, this.paths.model];
    const checks = await Promise.all(files.map(async (file) => {
      try {
        const stat = await fs.stat(file);
        return stat.isFile() && stat.size > 0;
      } catch { return false; }
    }));
    return { available: checks.every(Boolean), modelBytes: checks[2] ? (await fs.stat(this.paths.model)).size : 0 };
  }

  async status() {
    const assets = await this.inspectAssets();
    const endpoint = this.port ? `http://127.0.0.1:${this.port}/v1` : '';
    return {
      online: Boolean(this.ready && this.child && this.child.exitCode === null),
      checking: Boolean(this.startPromise && !this.ready),
      runtime: 'lam-v1.0',
      engine: 'LamV1.0 · llama.cpp',
      baseUrl: endpoint,
      models: assets.available ? [{
        name: MODEL_ID,
        title: MODEL_TITLE,
        family: 'qwen3',
        parameterSize: '4B',
        quantization: 'Q4_K_M',
        size: assets.modelBytes,
      }] : [],
      error: assets.available ? this.lastError : 'Встроенный движок или файл модели LamV1.0 не найдены. Установите Localis из комплектного установщика с включённой моделью.',
    };
  }

  async start() {
    if (this.ready && this.child && this.child.exitCode === null) return this.status();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startInternal() {
    this.lastError = '';
    this.logs = '';
    const assets = await this.inspectAssets();
    if (!assets.available) throw new Error('Не удалось найти встроенный Localis Engine или файл модели.');

    this.port = await reserveLoopbackPort();
    const child = this.spawnImpl(this.paths.launcher, [
      '--runtime', this.paths.runtime,
      '--model', this.paths.model,
      '--port', String(this.port),
    ], {
      cwd: this.paths.runtimeDirectory,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.ready = false;
    let launchError = null;
    child.stdout?.on('data', (chunk) => { this.appendLog(chunk); });
    child.stderr?.on('data', (chunk) => { this.appendLog(chunk); });
    child.once('error', (error) => {
      launchError = error;
      this.lastError = error.message || String(error);
      this.ready = false;
      this.emit('error-state', this.lastError);
    });
    child.once('exit', (code, signal) => {
      this.ready = false;
      if (this.child === child) {
        this.child = null;
        this.port = null;
      }
      if (code !== 0 && code !== null) {
        this.lastError = `Localis Engine завершился с кодом ${code}${signal ? ` (${signal})` : ''}.`;
        this.emit('error-state', this.lastError);
      }
    });

    const deadline = Date.now() + this.startTimeoutMs;
    let lastHealthError = '';
    while (Date.now() < deadline) {
      if (launchError) {
        await this.stop();
        throw new Error(`Не удалось запустить Localis Engine: ${launchError.message || launchError}`);
      }
      if (child.exitCode !== null) {
        const details = this.logs.trim().slice(-1200);
        throw new Error(`${this.lastError || `Localis Engine завершился с кодом ${child.exitCode}.`}${details ? `\n${details}` : ''}`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await this.fetchImpl(`http://127.0.0.1:${this.port}/health`, {
          redirect: 'error', signal: controller.signal,
        });
        if (response.ok) {
          this.ready = true;
          const status = await this.status();
          this.emit('ready', status);
          return status;
        }
        lastHealthError = `HTTP ${response.status}`;
      } catch (error) {
        if (!controller.signal.aborted) lastHealthError = String(error.message || error).slice(0, 200);
      } finally {
        clearTimeout(timer);
      }
      await delay(700);
    }
    const details = this.logs.trim().slice(-1200);
    this.lastError = `Локальная модель не загрузилась за ${Math.round(this.startTimeoutMs / 1000)} секунд${lastHealthError ? ` (${lastHealthError})` : ''}.${details ? ` ${details}` : ''}`;
    await this.stop();
    throw new Error(this.lastError);
  }

  appendLog(chunk) {
    const text = String(chunk || '').replace(/[\r\n]+/g, ' ').slice(-1500);
    if (!text) return;
    this.logs = `${this.logs} ${text}`.slice(-6000);
    this.logger.info?.(`[LamV1.0 runtime] ${text}`);
  }

  async stop() {
    const child = this.child;
    this.ready = false;
    if (!child) return false;
    if (child.exitCode === null && !child.killed) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, delay(5000)]);
    }
    if (this.child === child && child.exitCode !== null) this.child = null;
    this.port = null;
    return true;
  }
}

module.exports = { LocalisEngine, MODEL_FILE, MODEL_ID, MODEL_TITLE, engineAssetPaths, reserveLoopbackPort };
