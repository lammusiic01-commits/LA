'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeLocalServiceUrl, isLoopbackHost, isPrivateIp } = require('./security');
const net = require('node:net');
const { BUILTIN_PLUGINS } = require('./plugins');
const { PROVIDERS } = require('./providers');

function defaultConfig(documentsPath) {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    model: '',
    workspaceDirectory: path.join(documentsPath, 'Localis Workspace'),
    imageProvider: 'automatic1111',
    imageEndpoint: 'http://127.0.0.1:7860',
    temperature: 0.35,
    uiLanguage: 'ru',
    theme: 'midnight',
    approvalMode: 'ask',
    cloudFallbackEnabled: false,
    fallbackProvider: 'openai',
    enabledPluginIds: BUILTIN_PLUGINS.map((plugin) => plugin.id),
    mcpServers: [],
  };
}

function normalizeMcpServers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 30).map((server) => {
    if (!server || typeof server !== 'object') return null;
    const id = String(server.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48);
    const name = String(server.name || id).trim().slice(0, 100);
    let url;
    try { url = new URL(String(server.url || '')); } catch { return null; }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const local = isLoopbackHost(hostname);
    if (!id || !name || seen.has(id) || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !local) || (!local && net.isIP(hostname) && isPrivateIp(hostname)) || url.username || url.password) return null;
    seen.add(id);
    return {
      id, name, url: url.href,
      enabled: Boolean(server.enabled),
      toolNames: Array.isArray(server.toolNames) ? server.toolNames.slice(0, 200).map((item) => String(item).slice(0, 100)) : [],
      connectedAt: String(server.connectedAt || ''),
    };
  }).filter(Boolean);
}

function validateConfig(input, documentsPath) {
  const defaults = defaultConfig(documentsPath);
  const ollamaRaw = String(input?.ollamaBaseUrl || defaults.ollamaBaseUrl).trim();
  let ollamaUrl;
  try { ollamaUrl = new URL(ollamaRaw); } catch { throw new Error('Адрес Ollama указан неверно.'); }
  if (!['http:', 'https:'].includes(ollamaUrl.protocol) || ollamaUrl.username || ollamaUrl.password) throw new Error('Для Ollama укажите адрес http:// или https:// без пароля в URL.');
  const provider = ['automatic1111', 'comfyui'].includes(input?.imageProvider) ? input.imageProvider : defaults.imageProvider;
  const imageEndpoint = normalizeLocalServiceUrl(input?.imageEndpoint || defaults.imageEndpoint, defaults.imageEndpoint);
  const temperature = Number(input?.temperature);
  const providerId = String(input?.fallbackProvider || defaults.fallbackProvider);
  const enabledPluginIds = Array.isArray(input?.enabledPluginIds)
    ? [...new Set(input.enabledPluginIds.map((id) => String(id).slice(0, 80)))].slice(0, 100)
    : defaults.enabledPluginIds;
  const uiLanguage = ['ru', 'en', 'lv'].includes(input?.uiLanguage) ? input.uiLanguage : defaults.uiLanguage;
  const theme = ['midnight', 'graphite', 'forest', 'light'].includes(input?.theme) ? input.theme : defaults.theme;
  const approvalMode = ['ask', 'full'].includes(input?.approvalMode) ? input.approvalMode : defaults.approvalMode;

  return {
    ollamaBaseUrl: ollamaUrl.origin.replace(/\/$/, ''),
    model: String(input?.model || '').slice(0, 200),
    workspaceDirectory: path.resolve(String(input?.workspaceDirectory || defaults.workspaceDirectory)),
    imageProvider: provider,
    imageEndpoint,
    temperature: Number.isFinite(temperature) ? Math.min(1.5, Math.max(0, temperature)) : defaults.temperature,
    uiLanguage,
    theme,
    approvalMode,
    cloudFallbackEnabled: Boolean(input?.cloudFallbackEnabled),
    fallbackProvider: PROVIDERS[providerId] ? providerId : defaults.fallbackProvider,
    enabledPluginIds,
    mcpServers: normalizeMcpServers(input?.mcpServers),
  };
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) {
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

module.exports = { defaultConfig, normalizeMcpServers, readJson, validateConfig, writeJsonAtomic };
