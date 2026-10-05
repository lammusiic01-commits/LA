'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeLocalServiceUrl } = require('./security');

function defaultConfig(documentsPath) {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: '',
    workspaceDirectory: path.join(documentsPath, 'Localis Workspace'),
    imageProvider: 'automatic1111',
    imageEndpoint: 'http://127.0.0.1:7860',
    temperature: 0.35,
  };
}

function validateConfig(input, documentsPath) {
  const defaults = defaultConfig(documentsPath);
  const ollamaRaw = String(input?.ollamaBaseUrl || defaults.ollamaBaseUrl).trim();
  let ollamaUrl;
  try { ollamaUrl = new URL(ollamaRaw); } catch { throw new Error('Адрес Ollama указан неверно.'); }
  if (!['http:', 'https:'].includes(ollamaUrl.protocol) || ollamaUrl.username || ollamaUrl.password) {
    throw new Error('Для Ollama укажите адрес http:// или https:// без пароля в URL.');
  }
  const provider = ['automatic1111', 'comfyui'].includes(input?.imageProvider) ? input.imageProvider : defaults.imageProvider;
  const imageEndpoint = normalizeLocalServiceUrl(input?.imageEndpoint || defaults.imageEndpoint, defaults.imageEndpoint);
  const temperature = Number(input?.temperature);

  return {
    ollamaBaseUrl: ollamaUrl.origin.replace(/\/$/, ''),
    model: String(input?.model || '').slice(0, 200),
    workspaceDirectory: path.resolve(String(input?.workspaceDirectory || defaults.workspaceDirectory)),
    imageProvider: provider,
    imageEndpoint,
    temperature: Number.isFinite(temperature) ? Math.min(1.5, Math.max(0, temperature)) : defaults.temperature,
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

module.exports = { defaultConfig, readJson, validateConfig, writeJsonAtomic };
