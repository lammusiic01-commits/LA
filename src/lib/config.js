'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeLocalServiceUrl, isLoopbackHost, isPrivateIp } = require('./security');
const net = require('node:net');
const { BUILTIN_PLUGINS } = require('./plugins');

const LOCAL_MODEL_ID = 'lam-v1.0';

function defaultConfig(documentsPath) {
  return {
    model: LOCAL_MODEL_ID,
    uiScale: 1,
    reducedMotion: false,
    selfLearning: true,
    workspaceDirectory: path.join(documentsPath, 'Localis Workspace'),
    imageProvider: 'automatic1111',
    imageEndpoint: 'http://127.0.0.1:7860',
    temperature: 0.35,
    uiLanguage: 'ru',
    theme: 'midnight',
    approvalMode: 'ask',
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
  const provider = ['automatic1111', 'comfyui'].includes(input?.imageProvider) ? input.imageProvider : defaults.imageProvider;
  const imageEndpoint = normalizeLocalServiceUrl(input?.imageEndpoint || defaults.imageEndpoint, defaults.imageEndpoint);
  const temperature = Number(input?.temperature);
  const enabledPluginIds = Array.isArray(input?.enabledPluginIds)
    ? [...new Set(input.enabledPluginIds.map((id) => String(id).slice(0, 80)))].slice(0, 100)
    : defaults.enabledPluginIds;
  const uiLanguage = ['ru', 'en', 'lv'].includes(input?.uiLanguage) ? input.uiLanguage : defaults.uiLanguage;
  const theme = ['midnight', 'graphite', 'forest', 'light'].includes(input?.theme) ? input.theme : defaults.theme;
  const approvalMode = ['ask', 'full'].includes(input?.approvalMode) ? input.approvalMode : defaults.approvalMode;
  const uiScale = Number(input?.uiScale);

  return {
    model: LOCAL_MODEL_ID,
    uiScale: Number.isFinite(uiScale) ? Math.min(1.25, Math.max(0.8, uiScale)) : defaults.uiScale,
    reducedMotion: Boolean(input?.reducedMotion),
    selfLearning: input?.selfLearning !== false,
    workspaceDirectory: path.resolve(String(input?.workspaceDirectory || defaults.workspaceDirectory)),
    imageProvider: provider,
    imageEndpoint,
    temperature: Number.isFinite(temperature) ? Math.min(1.5, Math.max(0, temperature)) : defaults.temperature,
    uiLanguage,
    theme,
    approvalMode,
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

module.exports = { defaultConfig, LOCAL_MODEL_ID, normalizeMcpServers, readJson, validateConfig, writeJsonAtomic };
