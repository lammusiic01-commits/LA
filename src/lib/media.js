'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { realWorkspace, safeExistingPath, safeWriteTarget } = require('./files');
const { normalizeLocalServiceUrl } = require('./security');

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Запрос отменён.'));
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), ms);
    const onAbort = () => finish(signal.reason || new Error('Запрос отменён.'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function localFetch(endpoint, pathname, options = {}) {
  const base = normalizeLocalServiceUrl(endpoint, endpoint);
  const url = new URL(pathname.replace(/^\/+/, ''), `${base}/`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Локальный генератор не ответил вовремя.')), options.timeoutMs || 60_000);
  const onAbort = () => controller.abort(options.signal.reason || new Error('Запрос отменён.'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      redirect: 'error',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1200);
      throw new Error(`Локальный генератор ответил HTTP ${response.status}: ${body}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function safeImageName(value) {
  const base = path.basename(String(value || `image-${Date.now()}`)).replace(/\.[^.]*$/, '');
  const slug = base.normalize('NFKD').replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  return slug || `image-${Date.now()}`;
}

function clampDimension(value, fallback) {
  const number = Number(value);
  const clamped = Number.isFinite(number) ? Math.min(1024, Math.max(512, Math.round(number / 64) * 64)) : fallback;
  return clamped;
}

async function saveGeneratedImage(workspaceRoot, imageBuffer, filename, { allowOutside = false } = {}) {
  const root = await realWorkspace(workspaceRoot);
  const requested = String(filename || '');
  const relativePath = allowOutside && path.isAbsolute(requested) ? requested : `artifacts/images/${safeImageName(filename)}.png`;
  const target = await safeWriteTarget(root, relativePath, { allowOutside });
  await fs.writeFile(target, imageBuffer, { flag: 'w' });
  return { path: path.relative(root, target).split(path.sep).join('/'), size: imageBuffer.length };
}

async function generateWithAutomatic1111(workspaceRoot, endpoint, args, signal, options = {}) {
  const prompt = String(args.prompt || '').trim().slice(0, 4000);
  if (!prompt) throw new Error('Промпт для изображения пустой.');
  const response = await localFetch(endpoint, '/sdapi/v1/txt2img', {
    method: 'POST', timeoutMs: 6 * 60_000, signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: String(args.negative_prompt || '').slice(0, 2000),
      width: clampDimension(args.width, 768),
      height: clampDimension(args.height, 768),
      steps: Math.min(40, Math.max(1, Number(args.steps) || 24)),
      batch_size: 1,
      n_iter: 1,
      cfg_scale: 7,
      sampler_name: 'DPM++ 2M Karras',
    }),
  });
  const data = await response.json();
  const encoded = data?.images?.[0];
  if (!encoded) throw new Error('Генератор вернул пустой результат.');
  const image = Buffer.from(String(encoded).replace(/^data:image\/[^;]+;base64,/i, ''), 'base64');
  if (!image.length) throw new Error('Не удалось декодировать PNG от генератора.');
  return saveGeneratedImage(workspaceRoot, image, args.filename, options);
}

async function generateWithComfyUI(workspaceRoot, endpoint, args, signal, options = {}) {
  const prompt = String(args.prompt || '').trim().slice(0, 4000);
  if (!prompt) throw new Error('Промпт для изображения пустой.');
  const infoResponse = await localFetch(endpoint, '/object_info/CheckpointLoaderSimple', { timeoutMs: 12_000, signal });
  const info = await infoResponse.json();
  const checkpoints = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
  const checkpoint = String(args.checkpoint || checkpoints[0] || '');
  if (!checkpoint) throw new Error('В ComfyUI не найден checkpoint. Загрузите модель в ComfyUI или укажите её имя в задании.');
  if (checkpoints.length && !checkpoints.includes(checkpoint)) throw new Error('Выбранный checkpoint отсутствует в ComfyUI.');

  const width = clampDimension(args.width, 768);
  const height = clampDimension(args.height, 768);
  const steps = Math.min(40, Math.max(1, Number(args.steps) || 24));
  const workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: String(args.negative_prompt || '').slice(0, 2000), clip: ['1', 1] } },
    '5': { class_type: 'KSampler', inputs: {
      seed: Math.floor(Math.random() * 2_147_483_647), steps, cfg: 7,
      sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['1', 0], positive: ['3', 0], negative: ['4', 0], latent_image: ['2', 0],
    } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'localis', images: ['6', 0] } },
  };
  const promptResponse = await localFetch(endpoint, '/prompt', {
    method: 'POST', timeoutMs: 20_000, signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'localis-desktop' }),
  });
  const queued = await promptResponse.json();
  if (!queued.prompt_id) throw new Error(`ComfyUI не принял задачу: ${JSON.stringify(queued).slice(0, 1000)}`);

  let imageInfo;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(2000, signal);
    const historyResponse = await localFetch(endpoint, `/history/${encodeURIComponent(queued.prompt_id)}`, { timeoutMs: 12_000, signal });
    const history = await historyResponse.json();
    const job = history?.[queued.prompt_id];
    const outputs = job?.outputs || {};
    imageInfo = Object.values(outputs).flatMap((output) => output?.images || [])[0];
    if (imageInfo) break;
    if (job?.status?.status_str === 'error') throw new Error('ComfyUI завершил генерацию с ошибкой.');
  }
  if (!imageInfo?.filename) throw new Error('ComfyUI не завершил генерацию за 6 минут.');
  const viewUrl = new URL('/view', `${normalizeLocalServiceUrl(endpoint, endpoint)}/`);
  viewUrl.searchParams.set('filename', imageInfo.filename);
  viewUrl.searchParams.set('subfolder', imageInfo.subfolder || '');
  viewUrl.searchParams.set('type', imageInfo.type || 'output');
  const imageResponse = await localFetch(endpoint, viewUrl.pathname + viewUrl.search, { timeoutMs: 30_000, signal });
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const ext = path.extname(imageInfo.filename).toLowerCase() || '.png';
  const root = await realWorkspace(workspaceRoot);
  const requested = String(args.filename || '');
  const relative = options.allowOutside && path.isAbsolute(requested) ? requested : `artifacts/images/${safeImageName(requested)}${ext}`;
  const target = await safeWriteTarget(root, relative, options);
  await fs.writeFile(target, imageBuffer, { flag: 'w' });
  return { path: path.relative(root, target).split(path.sep).join('/'), size: imageBuffer.length };
}

async function generateImage(workspaceRoot, config, args, signal, options = {}) {
  if (config.imageProvider === 'comfyui') {
    return generateWithComfyUI(workspaceRoot, config.imageEndpoint, args, signal, options);
  }
  return generateWithAutomatic1111(workspaceRoot, config.imageEndpoint, args, signal, options);
}

function terminateProcess(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

function runProcess(executable, args, { cwd, timeoutMs = 120_000, signal, maxOutput = 24_000, env, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Операция отменена.'));
    let output = '';
    let settled = false;
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env, shell });
    const append = (chunk) => {
      if (output.length < maxOutput) output += chunk.toString('utf8').slice(0, maxOutput - output.length);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      terminateProcess(child);
      finish(new Error(`${path.basename(executable)} превысил лимит времени ${Math.round(timeoutMs / 1000)} секунд.\n${output}`));
    }, timeoutMs);
    const onAbort = () => {
      terminateProcess(child);
      finish(signal.reason || new Error('Операция отменена.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    }
    child.on('error', (error) => finish(new Error(`${path.basename(executable)} не найден или не запускается: ${error.message}`)));
    child.on('close', (code, childSignal) => {
      if (code === 0) finish(null, { code, output: output.trim() });
      else finish(new Error(`${path.basename(executable)} завершился с кодом ${code ?? childSignal}.\n${output}`));
    });
  });
}

async function makeVideo(workspaceRoot, args, signal, { allowOutside = false } = {}) {
  const relativeImages = Array.isArray(args.image_paths) ? args.image_paths.slice(0, 24) : [];
  if (!relativeImages.length) throw new Error('Нужен хотя бы один путь к изображению из рабочей папки.');
  const requestedDuration = Math.min(30, Math.max(1, Number(args.seconds_per_image) || 4));
  const root = await realWorkspace(workspaceRoot);
  const inputs = [];
  for (const relative of relativeImages) {
    const imagePath = await safeExistingPath(root, String(relative), { allowOutside });
    const stat = await fs.stat(imagePath);
    if (!stat.isFile() || stat.size > 40 * 1024 * 1024) throw new Error(`Изображение недоступно или слишком большое: ${relative}`);
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(imagePath)) throw new Error(`Неподдерживаемый формат кадра: ${relative}`);
    inputs.push(imagePath);
  }
  const duration = Math.min(requestedDuration, Math.max(1, 180 / inputs.length));
  let output = String(args.output || 'artifacts/video/slideshow.mp4').trim();
  if (!/\.mp4$/i.test(output)) output += '.mp4';
  const outputPath = await safeWriteTarget(root, output, { allowOutside });
  const filterParts = inputs.map((_, index) =>
    `[${index}:v]trim=duration=${duration},setpts=PTS-STARTPTS,fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`);
  const concatInputs = inputs.map((_, index) => `[v${index}]`).join('');
  filterParts.push(`${concatInputs}concat=n=${inputs.length}:v=1:a=0,format=yuv420p[outv]`);
  const commandArgs = [];
  for (const imagePath of inputs) commandArgs.push('-loop', '1', '-t', String(duration), '-i', imagePath);
  commandArgs.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]', '-an', '-c:v', 'libx264', '-r', '30', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-y', outputPath,
  );
  const result = await runProcess('ffmpeg', commandArgs, { cwd: workspaceRoot, timeoutMs: 5 * 60_000, signal });
  const stat = await fs.stat(outputPath);
  return { path: path.relative(root, outputPath).split(path.sep).join('/'), size: stat.size, frames: inputs.length, seconds: inputs.length * duration, log: result.output.slice(-1500) };
}

module.exports = { generateImage, makeVideo, runProcess };
