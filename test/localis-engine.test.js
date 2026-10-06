'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalisEngine, MODEL_FILE, MODEL_ID, MODEL_TITLE, engineAssetPaths } = require('../src/lib/localis-engine');

test('the bundled local runtime is fixed to the LamV1.0 model alias', () => {
  assert.equal(MODEL_ID, 'lam-v1.0');
  assert.match(MODEL_TITLE, /^LamV1\.0/);
  assert.equal(MODEL_FILE, 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
  assert.deepEqual(engineAssetPaths('/bundle'), {
    launcher: path.join('/bundle', 'localis-engine.exe'),
    runtime: path.join('/bundle', 'localis-runtime', 'llama-server.exe'),
    model: path.join('/bundle', 'models', MODEL_FILE),
    runtimeDirectory: path.join('/bundle', 'localis-runtime'),
  });
});

test('missing bundled assets fail locally and never fall back to another backend', async (t) => {
  const assetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localis-lam-engine-'));
  t.after(() => fs.rm(assetRoot, { recursive: true, force: true }));
  let spawned = false;
  const engine = new LocalisEngine({
    assetRoot,
    spawnImpl: () => { spawned = true; throw new Error('Unexpected process launch.'); },
    logger: { info() {} },
  });
  const status = await engine.status();
  assert.equal(status.runtime, 'lam-v1.0');
  assert.equal(status.online, false);
  assert.deepEqual(status.models, []);
  assert.match(status.error, /LamV1\.0/);
  await assert.rejects(engine.start(), /встроенный Localis Engine или файл модели/);
  assert.equal(spawned, false);
});

test('a successful startup reports LamV1.0 ready rather than still checking', async (t) => {
  const assetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localis-lam-ready-'));
  t.after(() => fs.rm(assetRoot, { recursive: true, force: true }));
  const assets = engineAssetPaths(assetRoot);
  await Promise.all([
    fs.mkdir(path.dirname(assets.launcher), { recursive: true }),
    fs.mkdir(assets.runtimeDirectory, { recursive: true }),
    fs.mkdir(path.dirname(assets.model), { recursive: true }),
  ]);
  await Promise.all([assets.launcher, assets.runtime, assets.model].map((file) => fs.writeFile(file, 'bundled-test-asset')));

  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    killed: false,
    kill() {
      this.killed = true;
      this.exitCode = 0;
      this.emit('exit', 0, null);
      return true;
    },
  });
  const requests = [];
  const engine = new LocalisEngine({
    assetRoot,
    spawnImpl: () => child,
    fetchImpl: async (url) => { requests.push(String(url)); return new Response('', { status: 200 }); },
    startTimeoutMs: 2000,
    logger: { info() {} },
  });
  t.after(() => engine.stop());

  const status = await engine.start();
  assert.equal(status.online, true);
  assert.equal(status.checking, false);
  assert.equal(status.models[0].name, 'lam-v1.0');
  assert.equal(status.baseUrl, `http://127.0.0.1:${engine.port}/v1`);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^http:\/\/127\.0\.0\.1:\d+\/health$/);
  await engine.stop();
});
