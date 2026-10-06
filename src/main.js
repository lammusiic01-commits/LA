'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const {
  app, BrowserWindow, WebContentsView, dialog, ipcMain, shell, safeStorage, screen,
} = require('electron');
app.setName('localis-ai');

const { runAgentTurn } = require('./lib/agent');
const { defaultConfig, readJson, validateConfig, writeJsonAtomic } = require('./lib/config');
const { normalizeLocalServiceUrl, assertPublicHttpUrl, isLoopbackHost } = require('./lib/security');
const fs = require('node:fs/promises');
const { listWorkspaceFiles } = require('./lib/files');
const { SecretVault } = require('./lib/secrets');
const { normalizeMemory, appendTurn, redactSensitive } = require('./lib/memory');
const { BUILTIN_PLUGINS, installPluginFromUrl, normalizeImportedPlugin } = require('./lib/plugins');
const { HttpMcpClient, buildMcpToolMap, toModelTool } = require('./lib/mcp');
const { installGithubAgent, runLocalSubagent } = require('./lib/agents');
const { createWorkspaceFolder, createWorkspaceProject, projectById, validateProjectRoot } = require('./lib/projects');
const { CONNECTOR_CATALOG, availableConnectorTools, executeConnectorTool, testGithub, testInstagram, testProvider } = require('./lib/connectors');
const { PROVIDERS, callProvider, providerInfo } = require('./lib/providers');
const { LocalisEngine } = require('./lib/localis-engine');
const { GOOGLE_SCOPES, startGoogleOAuth } = require('./lib/google-oauth');
const { isPathInside } = require('./lib/security');

let mainWindow = null;
let browserWindow = null;
let browserView = null;
let configCache = null;
let vaultCache = null;
let localisEngine = null;
const mcpClients = new Map();
const activeRuns = new Map();
const pendingApprovals = new Map();
const stagedAttachments = new Map();

const configPath = () => path.join(app.getPath('userData'), 'settings.json');
const statePath = () => path.join(app.getPath('userData'), 'conversations.json');
const memoryPath = () => path.join(app.getPath('userData'), 'memory.json');
const sharedMemoryPath = () => path.join(app.getPath('userData'), 'global-memory.json');
const secretsPath = () => path.join(app.getPath('userData'), 'secrets.enc');
const projectsPath = () => path.join(app.getPath('userData'), 'projects.json');
const agentsPath = () => path.join(app.getPath('userData'), 'agents.json');
const pluginsPath = () => path.join(app.getPath('userData'), 'plugins.json');

function getLocalisEngine() {
  if (!localisEngine) {
    const assetRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'localis-bundle')
      : path.resolve(process.env.LOCALIS_ASSET_ROOT || path.join(app.getAppPath(), 'release-assets'));
    localisEngine = new LocalisEngine({ assetRoot });
    localisEngine.on('ready', (status) => sendApp('model:status', status));
    localisEngine.on('error-state', (message) => sendApp('model:status', { online: false, checking: false, runtime: 'lam-v1.0', engine: 'LamV1.0', models: [], error: message }));
  }
  return localisEngine;
}

function requireAppSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Недоверенный источник IPC-запроса.');
}

function requireBrowserSender(event) {
  if (!browserWindow || event.sender !== browserWindow.webContents) throw new Error('Недоверенный источник browser IPC-запроса.');
}

function sendApp(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function emitAgent(payload) {
  sendApp('agent:event', payload);
}

function updateBrowserState(state = {}) {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.webContents.send('browser:state', state);
}

async function getConfig() {
  if (configCache) return configCache;
  const defaults = defaultConfig(app.getPath('documents'));
  const raw = await readJson(configPath(), defaults);
  try {
    configCache = validateConfig(raw, app.getPath('documents'));
  } catch {
    configCache = defaults;
  }
  return configCache;
}

async function getMemory() {
  const value = await readJson(memoryPath(), []);
  return Array.isArray(value) ? value.filter((item) => item && typeof item.note === 'string').slice(-100).map((item) => ({ ...item, note: redactSensitive(item.note).slice(0, 1500) })) : [];
}

async function getSharedMemory() {
  return normalizeMemory(await readJson(sharedMemoryPath(), { entries: [], summary: '' }));
}

async function getVault() {
  if (!vaultCache) vaultCache = new SecretVault({ filePath: secretsPath(), safeStorage });
  return vaultCache;
}

async function getProjects() {
  const value = await readJson(projectsPath(), []);
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && typeof item.path === 'string').slice(-100) : [];
}

async function getAgents() {
  const value = await readJson(agentsPath(), []);
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && typeof item.instructions === 'string').slice(-100) : [];
}

async function getCustomPlugins() {
  const value = await readJson(pluginsPath(), []);
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && typeof item.instructions === 'string').slice(-100) : [];
}

async function getIntegrationStatus() {
  const vault = await getVault();
  const [github, google, instagram, providerEntries] = await Promise.all([
    vault.get(['connectors', 'github'], {}),
    vault.get(['connectors', 'google'], {}),
    vault.get(['connectors', 'instagram'], {}),
    Promise.all(Object.keys(PROVIDERS).map(async (id) => [id, Boolean(await vault.get(['providers', id, 'key'], ''))])),
  ]);
  const config = await getConfig();
  return {
    github: { connected: Boolean(github?.token), account: String(github?.account || '') },
    google: { connected: Boolean(google?.refreshToken || google?.accessToken), account: String(google?.email || ''), name: String(google?.name || '') },
    instagram: { connected: Boolean(instagram?.token && instagram?.instagramUserId), account: String(instagram?.username || instagram?.instagramUserId || '') },
    providers: Object.fromEntries(providerEntries),
    mcp: (config.mcpServers || []).map((server) => ({ id: server.id, name: server.name, enabled: server.enabled, toolCount: server.toolNames?.length || 0 })),
    catalog: CONNECTOR_CATALOG,
  };
}

async function checkModelRuntime() {
  const engine = getLocalisEngine();
  sendApp('model:status', { online: false, checking: true, runtime: 'lam-v1.0', engine: 'LamV1.0', baseUrl: '', models: [] });
  try {
    return await engine.start();
  } catch (error) {
    const status = await engine.status();
    const failed = { ...status, online: false, checking: false, runtime: 'lam-v1.0', engine: 'LamV1.0', error: error.message || String(error) };
    sendApp('model:status', failed);
    return failed;
  }
}

function createMainWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const initialWidth = Math.min(1600, Math.round(workArea.width * 0.88));
  const initialHeight = Math.min(1050, Math.round(workArea.height * 0.88));
  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: Math.min(920, initialWidth),
    minHeight: Math.min(620, initialHeight),
    backgroundColor: '#0d131c',
    title: 'Localis · локальный AI-агент',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const expected = pathToFileURL(path.join(__dirname, 'index.html')).href;
    if (url !== expected) event.preventDefault();
  });
  mainWindow.webContents.once('did-finish-load', () => {
    getConfig().then((config) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomFactor(config.uiScale || 1);
    }).catch(() => {});
  });
  mainWindow.on('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const [runId, run] of activeRuns) run.controller.abort(new Error('Окно приложения закрыто.'));
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  return mainWindow;
}

function browserBounds() {
  if (!browserWindow || !browserView || browserWindow.isDestroyed()) return;
  const [width, height] = browserWindow.getContentSize();
  browserView.setBounds({ x: 0, y: 88, width, height: Math.max(100, height - 88) });
}

function normalizeBrowserAddress(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Введите адрес сайта.');
  let candidate = text;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = /^[\w-]+\.[a-z]{2,}(?:\/|$)/i.test(candidate)
      ? `https://${candidate}`
      : `https://duckduckgo.com/?q=${encodeURIComponent(candidate)}`;
  }
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Разрешены только HTTP и HTTPS адреса.');
  return url.href;
}

async function openBrowser(targetUrl = 'https://duckduckgo.com') {
  const safeUrl = (await assertPublicHttpUrl(normalizeBrowserAddress(targetUrl))).href;
  if (browserWindow && !browserWindow.isDestroyed() && browserView && !browserView.webContents.isDestroyed()) {
    browserWindow.show();
    browserWindow.focus();
    await browserView.webContents.loadURL(safeUrl);
    return safeUrl;
  }

  browserWindow = new BrowserWindow({
    width: 1260,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0c121b',
    title: 'Браузер · Localis',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'browser-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  const browserPageUrl = pathToFileURL(path.join(__dirname, 'browser.html')).href;
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== browserPageUrl) event.preventDefault();
  });
  browserView = new WebContentsView({
    webPreferences: {
      partition: 'persist:localis-browser',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  browserWindow.contentView.addChildView(browserView);
  browserBounds();
  browserWindow.on('resize', browserBounds);
  browserWindow.on('closed', () => {
    browserWindow = null;
    browserView = null;
  });

  const remoteContents = browserView.webContents;
  remoteContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    assertPublicHttpUrl(details.url).then(() => callback({})).catch(() => callback({ cancel: true }));
  });
  remoteContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  remoteContents.session.setPermissionCheckHandler(() => false);
  remoteContents.setWindowOpenHandler(({ url }) => {
    updateBrowserState({ error: 'Всплывающее окно заблокировано. Ссылку можно открыть вручную.' });
    return { action: 'deny' };
  });
  const allowWebNavigation = (event, url) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) event.preventDefault();
    } catch { event.preventDefault(); }
  };
  remoteContents.on('will-navigate', allowWebNavigation);
  remoteContents.on('will-redirect', allowWebNavigation);
  remoteContents.on('did-start-loading', () => updateBrowserState({ url: remoteContents.getURL(), title: remoteContents.getTitle(), loading: true }));
  remoteContents.on('did-navigate', (_event, url) => updateBrowserState({ url, title: remoteContents.getTitle(), loading: false }));
  remoteContents.on('did-navigate-in-page', (_event, url) => updateBrowserState({ url, title: remoteContents.getTitle(), loading: false }));
  remoteContents.on('page-title-updated', (_event, title) => updateBrowserState({ url: remoteContents.getURL(), title, loading: false }));
  remoteContents.on('did-stop-loading', () => updateBrowserState({ url: remoteContents.getURL(), title: remoteContents.getTitle(), loading: false }));
  remoteContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) updateBrowserState({ url: remoteContents.getURL(), error: description, loading: false });
  });

  await browserWindow.loadFile(path.join(__dirname, 'browser.html'));
  browserWindow.show();
  await remoteContents.loadURL(safeUrl);
  updateBrowserState({ url: safeUrl, title: safeUrl, loading: false });
  return safeUrl;
}

async function requestApproval(detail, signal) {
  const config = await getConfig();
  if (config.approvalMode === 'full') {
    emitAgent({ type: 'approval-auto', runId: detail.runId || '', toolId: detail.toolId || '', name: detail.name, summary: detail.summary, risk: detail.risk || 'read' });
    return true;
  }
  if (!mainWindow || mainWindow.isDestroyed() || signal?.aborted) return false;
  return new Promise((resolve) => {
    let settled = false;
    const id = detail.id;
    const timer = setTimeout(() => settle(false), 4 * 60_000);
    const onAbort = () => settle(false);
    function settle(approved) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pendingApprovals.delete(id);
      resolve(Boolean(approved));
    }
    pendingApprovals.set(id, settle);
    signal?.addEventListener('abort', onAbort, { once: true });
    sendApp('agent:approval', detail);
  });
}

async function readSelectedAttachments(attachmentIds) {
  const selected = (Array.isArray(attachmentIds) ? attachmentIds : []).map((id) => stagedAttachments.get(String(id))).filter(Boolean);
  for (const attachment of selected) stagedAttachments.delete(attachment.id);
  return selected;
}

function setupIpc() {
  ipcMain.handle('app:get-state', async (event) => {
    requireAppSender(event);
    const config = await getConfig();
    const storedState = await readJson(statePath(), { conversations: [], activeId: null });
    const memory = await getMemory();
    const sharedMemory = await getSharedMemory();
    const projects = await getProjects();
    const agents = await getAgents();
    const plugins = await getCustomPlugins();
    const integrations = await getIntegrationStatus();
    return {
      config,
      appState: storedState && typeof storedState === 'object' ? storedState : { conversations: [], activeId: null, activeProjectId: null, activity: [] },
      memoryCount: memory.length,
      memoryNotes: memory,
      sharedMemory,
      projects,
      agents: agents.map(({ instructions, ...summary }) => summary),
      plugins,
      integrations,
      providers: Object.entries(PROVIDERS).map(([id, provider]) => ({ id, ...provider })),
      workspace: config.workspaceDirectory,
    };
  });

  ipcMain.handle('app:save-state', async (event, value) => {
    requireAppSender(event);
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 8 * 1024 * 1024) throw new Error('История чатов превышает локальный лимит 8 МБ.');
    await writeJsonAtomic(statePath(), value);
    return { saved: true };
  });

  ipcMain.handle('settings:save', async (event, value) => {
    requireAppSender(event);
    const previous = await getConfig();
    const normalized = validateConfig(value, app.getPath('documents'));
    if (activeRuns.size && normalized.approvalMode !== previous.approvalMode) throw new Error('Дождитесь завершения текущего запуска, прежде чем менять режим доступа.');
    if (previous.approvalMode !== 'full' && normalized.approvalMode === 'full') {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: 'Включить полный доступ Localis?',
        message: 'Вы отключаете запрос разрешения перед каждым действием.',
        detail: 'Агент сможет автоматически читать и записывать файлы вне рабочей папки, запускать команды с правами вашей учётной записи Windows, обращаться к включённым внешним сервисам и передавать данные подключённым AI-провайдерам. Это не OS-песочница; ошибка или prompt injection может причинить ущерб. Включайте только если доверяете выбранной модели и текущей задаче.',
        buttons: ['Включить полный доступ', 'Оставить подтверждения'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (choice.response !== 0) throw new Error('Полный доступ не включён; сохранён режим подтверждения каждого действия.');
    }
    await writeJsonAtomic(configPath(), normalized);
    configCache = normalized;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomFactor(normalized.uiScale || 1);
    sendApp('model:status', { online: false, runtime: 'lam-v1.0', engine: 'LamV1.0', baseUrl: '', models: [], checking: true });
    setImmediate(() => checkModelRuntime().catch((error) => emitAgent({ type: 'runtime-error', message: error.message || String(error) })));
    return normalized;
  });

  ipcMain.handle('api-key:test', async (event, payload) => {
    requireAppSender(event);
    const providerId = String(payload?.provider || '');
    const apiKey = String(payload?.apiKey || '').trim() || await (await getVault()).get(['providers', providerId, 'key'], '');
    return testProvider(providerId, apiKey);
  });

  ipcMain.handle('api-key:save', async (event, payload) => {
    requireAppSender(event);
    const providerId = String(payload?.provider || '');
    providerInfo(providerId);
    const key = String(payload?.apiKey || '').trim();
    if (key.length < 8 || key.length > 5000) throw new Error('API-ключ пустой или имеет недопустимую длину.');
    const vault = await getVault();
    await vault.set(['providers', providerId], { key, model: String(payload?.model || '').slice(0, 160), savedAt: new Date().toISOString() });
    return getIntegrationStatus();
  });

  ipcMain.handle('api-key:remove', async (event, providerId) => {
    requireAppSender(event);
    providerInfo(String(providerId || ''));
    await (await getVault()).remove(['providers', String(providerId)]);
    return getIntegrationStatus();
  });

  ipcMain.handle('connectors:github', async (event, payload) => {
    requireAppSender(event);
    const token = String(payload?.token || '').trim();
    const identity = await testGithub(token);
    await (await getVault()).set(['connectors', 'github'], { token, account: identity.account, name: identity.name, connectedAt: new Date().toISOString() });
    return getIntegrationStatus();
  });

  ipcMain.handle('connectors:instagram', async (event, payload) => {
    requireAppSender(event);
    const connection = { token: String(payload?.token || '').trim(), instagramUserId: String(payload?.instagramUserId || '').trim() };
    const identity = await testInstagram(connection);
    await (await getVault()).set(['connectors', 'instagram'], { ...connection, username: identity.account, accountType: identity.accountType, connectedAt: new Date().toISOString() });
    return getIntegrationStatus();
  });

  ipcMain.handle('connectors:google', async (event, payload) => {
    requireAppSender(event);
    const connection = await startGoogleOAuth({
      clientId: String(payload?.clientId || ''), clientSecret: String(payload?.clientSecret || ''),
      openExternal: (url) => shell.openExternal(url),
    });
    await (await getVault()).set(['connectors', 'google'], connection);
    return getIntegrationStatus();
  });

  ipcMain.handle('connectors:disconnect', async (event, connectorId) => {
    requireAppSender(event);
    const id = String(connectorId || '');
    if (['github', 'google', 'instagram'].includes(id)) await (await getVault()).remove(['connectors', id]);
    else if (id.startsWith('mcp-')) {
      const serverId = id.slice(4);
      const config = await getConfig();
      config.mcpServers = config.mcpServers.filter((server) => server.id !== serverId);
      await writeJsonAtomic(configPath(), config);
      configCache = config;
      await (await getVault()).remove(['connectors', 'mcp', serverId]);
      mcpClients.delete(serverId);
    } else throw new Error('Неизвестный тип подключения.');
    return getIntegrationStatus();
  });

  ipcMain.handle('mcp:connect', async (event, payload) => {
    requireAppSender(event);
    const name = String(payload?.name || '').trim().slice(0, 100);
    const endpoint = String(payload?.url || '').trim();
    const token = String(payload?.token || '').trim();
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('Введите URL MCP-сервера.'); }
    const localEndpoint = isLoopbackHost(url.hostname);
    if (!name || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'http:' && !localEndpoint)) {
      throw new Error('MCP-подключение должно иметь имя и публичный HTTPS URL (HTTP разрешён только для localhost).');
    }
    if (!localEndpoint) await assertPublicHttpUrl(url.href);
    const controller = new AbortController();
    const approval = await requestApproval({ id: randomUUID(), name: 'mcp_connect', risk: 'high', summary: `Подключить MCP-сервер «${name}» и разрешить ему предоставлять Localis инструменты?`, arguments: `URL: ${url.href}\nСервер сможет получать вызовы выбранных вами инструментов. При режиме подтверждения каждый вызов будет показан отдельно.` }, controller.signal);
    if (!approval) throw new Error('Подключение MCP-сервера отклонено.');
    const id = `mcp-${randomUUID().slice(0, 8)}`;
    const client = new HttpMcpClient({ url: url.href, token });
    const tools = await client.listTools();
    if (tools.length > 200) throw new Error('MCP-сервер вернул больше 200 инструментов; подключение отменено.');
    const server = { id, name, url: url.href, enabled: true, toolNames: tools.map((tool) => String(tool.name || '').slice(0, 100)), connectedAt: new Date().toISOString() };
    const config = await getConfig();
    config.mcpServers = [...config.mcpServers.filter((item) => item.id !== id), server];
    await writeJsonAtomic(configPath(), config);
    configCache = config;
    mcpClients.set(id, { client, tools });
    await (await getVault()).set(['connectors', 'mcp', id], { token });
    return { server: { ...server, toolCount: tools.length }, integrations: await getIntegrationStatus() };
  });

  ipcMain.handle('workspace:create-folder', async (event, name) => {
    requireAppSender(event);
    const config = await getConfig();
    return createWorkspaceFolder(config.workspaceDirectory, String(name || ''));
  });

  ipcMain.handle('projects:create', async (event, payload) => {
    requireAppSender(event);
    const config = await getConfig();
    const projects = await getProjects();
    const { project, projects: next } = await createWorkspaceProject(config.workspaceDirectory, String(payload?.name || ''), String(payload?.goal || ''), projects);
    await writeJsonAtomic(projectsPath(), next);
    return project;
  });

  ipcMain.handle('projects:open', async (event, projectId) => {
    requireAppSender(event);
    const project = projectById(await getProjects(), String(projectId || ''));
    if (!project) throw new Error('Проект не найден.');
    const error = await shell.openPath(project.path);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('agent:install-github', async (event, payload) => {
    requireAppSender(event);
    const repositoryUrl = String(payload?.url || '');
    const runId = String(payload?.runId || randomUUID());
    if (!/^[\w-]{8,80}$/.test(runId) || activeRuns.has(runId)) throw new Error('Некорректный идентификатор установки агента.');
    const controller = new AbortController();
    activeRuns.set(runId, { controller });
    try {
      const approval = await requestApproval({ id: randomUUID(), runId, name: 'agent_install', risk: 'high', summary: `Импортировать текстовые навыки из GitHub: ${repositoryUrl.slice(0, 300)}`, arguments: 'Localis прочитает только небольшие AGENTS.md / SKILL.md / agent.md / README.md из корня публичного репозитория и сохранит их как текстовые инструкции. Исходный код не клонируется и не запускается; после импорта инструкции можно просмотреть и удалить.' }, controller.signal);
      if (!approval) throw new Error('Установка агента отменена.');
      const agents = await getAgents();
      const installed = await installGithubAgent({ repositoryUrl, signal: controller.signal, onProgress: (progress) => sendApp('agent:event', { type: 'agent-install-progress', runId, ...progress }) });
      const next = [...agents.filter((agent) => agent.url !== installed.url), installed].slice(-100);
      await writeJsonAtomic(agentsPath(), next);
      sendApp('agent:event', { type: 'agent-installed', runId, agent: { id: installed.id, name: installed.name, url: installed.url } });
      return { agent: { id: installed.id, name: installed.name, url: installed.url, skillFiles: installed.skillFiles }, count: next.length };
    } finally {
      activeRuns.delete(runId);
    }
  });

  ipcMain.handle('agents:inspect', async (event, agentId) => {
    requireAppSender(event);
    const agent = (await getAgents()).find((item) => item.id === String(agentId || ''));
    if (!agent) throw new Error('Агент не найден.');
    return { id: agent.id, name: agent.name, url: agent.url, defaultBranch: agent.defaultBranch, skillFiles: agent.skillFiles || [], execution: agent.execution, instructions: String(agent.instructions || '') };
  });

  ipcMain.handle('agents:remove', async (event, agentId) => {
    requireAppSender(event);
    const id = String(agentId || '');
    const agents = await getAgents();
    if (!agents.some((agent) => agent.id === id)) throw new Error('Агент не найден.');
    const next = agents.filter((agent) => agent.id !== id);
    await writeJsonAtomic(agentsPath(), next);
    return next.map(({ instructions, ...summary }) => summary);
  });

  ipcMain.handle('agents:toggle', async (event, payload) => {
    requireAppSender(event);
    const agents = await getAgents();
    const agent = agents.find((item) => item.id === String(payload?.id || ''));
    if (!agent) throw new Error('Агент не найден.');
    agent.enabled = Boolean(payload.enabled);
    await writeJsonAtomic(agentsPath(), agents);
    return agents.map(({ instructions, ...summary }) => summary);
  });

  ipcMain.handle('plugins:import', async (event) => {
    requireAppSender(event);
    const dialogResult = await dialog.showOpenDialog(mainWindow, { title: 'Добавить plugin skill', properties: ['openFile'], filters: [{ name: 'Localis plugins', extensions: ['md', 'txt', 'json'] }] });
    if (dialogResult.canceled || !dialogResult.filePaths[0]) return null;
    const filePath = dialogResult.filePaths[0];
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 40_000) throw new Error('Файл plugin должен быть меньше 40 КБ.');
    const text = await fs.readFile(filePath, 'utf8');
    let manifest = text;
    if (path.extname(filePath).toLowerCase() === '.json') {
      try { manifest = JSON.parse(text); } catch { throw new Error('JSON plugin не удалось прочитать.'); }
    }
    const plugin = normalizeImportedPlugin(manifest, path.basename(filePath, path.extname(filePath)));
    const plugins = await getCustomPlugins();
    await writeJsonAtomic(pluginsPath(), [...plugins.filter((item) => item.id !== plugin.id), plugin].slice(-100));
    const config = await getConfig();
    config.enabledPluginIds = [...new Set([...config.enabledPluginIds, plugin.id])];
    await writeJsonAtomic(configPath(), config);
    configCache = config;
    return plugin;
  });

  ipcMain.handle('plugins:install-url', async (event, value) => {
    requireAppSender(event);
    const url = String(value || '').trim();
    const controller = new AbortController();
    const approved = await requestApproval({ id: randomUUID(), name: 'plugin_download', risk: 'read', summary: `Импортировать текстовый skill из интернета · ${url.slice(0, 400)}`, arguments: 'Localis проверит публичный URL и загрузит только небольшой файл .md, .txt или .json (максимум 40 КБ). Скрипты, HTML и исполняемый код не запускаются.' }, controller.signal);
    if (!approved) throw new Error('Загрузка plugin отклонена.');
    const plugin = await installPluginFromUrl(url, { signal: controller.signal });
    const plugins = await getCustomPlugins();
    await writeJsonAtomic(pluginsPath(), [...plugins.filter((item) => item.id !== plugin.id), plugin].slice(-100));
    const config = await getConfig();
    config.enabledPluginIds = [...new Set([...config.enabledPluginIds, plugin.id])];
    await writeJsonAtomic(configPath(), config);
    configCache = config;
    return plugin;
  });

  ipcMain.handle('plugins:toggle', async (event, payload) => {
    requireAppSender(event);
    const config = await getConfig();
    const id = String(payload?.id || '');
    config.enabledPluginIds = payload.enabled ? [...new Set([...config.enabledPluginIds, id])] : config.enabledPluginIds.filter((item) => item !== id);
    await writeJsonAtomic(configPath(), config);
    configCache = config;
    return config.enabledPluginIds;
  });

  ipcMain.handle('plugins:remove', async (event, pluginId) => {
    requireAppSender(event);
    const id = String(pluginId || '');
    const plugins = await getCustomPlugins();
    await writeJsonAtomic(pluginsPath(), plugins.filter((plugin) => plugin.id !== id));
    const config = await getConfig();
    config.enabledPluginIds = config.enabledPluginIds.filter((item) => item !== id);
    await writeJsonAtomic(configPath(), config);
    configCache = config;
    return true;
  });

  ipcMain.handle('plugins:search', async (event, query) => {
    requireAppSender(event);
    const controller = new AbortController();
    const approved = await requestApproval({ id: randomUUID(), name: 'web_search', risk: 'read', summary: `Поиск плагинов в интернете · ${String(query || '').slice(0, 300)}`, arguments: 'Поисковый запрос будет отправлен сервису DuckDuckGo.' }, controller.signal);
    if (!approved) return { results: [] };
    const { searchWeb } = require('./lib/web');
    return searchWeb(`${String(query || '').trim().slice(0, 250)} Localis agent skill plugin GitHub`, { signal: controller.signal });
  });

  ipcMain.handle('model:check', (event) => {
    requireAppSender(event);
    return checkModelRuntime();
  });

  ipcMain.handle('workspace:choose', async (event) => {
    requireAppSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите рабочую папку Localis',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('workspace:open', async (event) => {
    requireAppSender(event);
    const config = await getConfig();
    const { mkdir } = require('node:fs/promises');
    await mkdir(config.workspaceDirectory, { recursive: true });
    const error = await shell.openPath(config.workspaceDirectory);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('attachments:select', async (event) => {
    requireAppSender(event);
    const dialogResult = await dialog.showOpenDialog(mainWindow, {
      title: 'Прикрепить файлы для анализа',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Изображения и текст', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'txt', 'md', 'json', 'csv', 'html', 'css', 'js', 'ts', 'py', 'log', 'xml', 'yaml', 'yml'] }],
    });
    if (dialogResult.canceled) return { attachments: [] };
    const fs = require('node:fs/promises');
    const attachments = [];
    const errors = [];
    for (const filePath of dialogResult.filePaths.slice(0, 5)) {
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new Error('максимальный размер — 12 МБ');
        const id = randomUUID();
        const name = path.basename(filePath);
        const extension = path.extname(name).toLowerCase();
        const kind = /^\.(png|jpe?g|webp|gif|bmp)$/.test(extension) ? 'image' : 'text';
        const attachment = { id, name, kind, size: stat.size, path: filePath };
        stagedAttachments.set(id, attachment);
        attachments.push({ id, name, kind, size: stat.size });
      } catch (error) {
        errors.push(`${path.basename(filePath)}: ${error.message}`);
      }
    }
    return { attachments, errors };
  });

  ipcMain.handle('browser:open', async (event, url) => {
    requireAppSender(event);
    return openBrowser(url || 'https://duckduckgo.com');
  });

  ipcMain.handle('browser:navigate', async (event, value) => {
    requireBrowserSender(event);
    if (!browserView || browserView.webContents.isDestroyed()) throw new Error('Браузер закрыт.');
    const url = await assertPublicHttpUrl(normalizeBrowserAddress(value));
    await browserView.webContents.loadURL(url.href);
    return true;
  });
  ipcMain.handle('browser:back', (event) => { requireBrowserSender(event); if (browserView?.webContents.canGoBack()) browserView.webContents.goBack(); });
  ipcMain.handle('browser:forward', (event) => { requireBrowserSender(event); if (browserView?.webContents.canGoForward()) browserView.webContents.goForward(); });
  ipcMain.handle('browser:reload', (event) => { requireBrowserSender(event); browserView?.webContents.reload(); });
  ipcMain.handle('browser:open-external', async (event) => {
    requireBrowserSender(event);
    const current = browserView?.webContents.getURL() || '';
    if (!/^https?:\/\//i.test(current)) throw new Error('Нет безопасного веб-адреса для открытия.');
    await shell.openExternal(current);
  });

  ipcMain.handle('memory:clear', async (event) => {
    requireAppSender(event);
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'Очистить локальную память?',
      message: 'Удалить все заметки памяти Localis?', detail: 'История диалогов останется без изменений.',
      buttons: ['Очистить память', 'Отмена'], defaultId: 1, cancelId: 1, noLink: true,
    });
    if (choice.response !== 0) return false;
    await writeJsonAtomic(memoryPath(), []);
    await writeJsonAtomic(sharedMemoryPath(), { updatedAt: new Date().toISOString(), entries: [], summary: '' });
    return true;
  });

  ipcMain.handle('approval:resolve', (event, payload) => {
    requireAppSender(event);
    const settle = pendingApprovals.get(String(payload?.id || ''));
    if (!settle) return false;
    settle(Boolean(payload.approved));
    return true;
  });

  ipcMain.handle('agent:cancel', (event, runId) => {
    requireAppSender(event);
    const run = activeRuns.get(String(runId || ''));
    if (!run) return false;
    run.controller.abort(new Error('Запрос отменён пользователем.'));
    return true;
  });

  ipcMain.handle('agent:start', (event, payload) => {
    requireAppSender(event);
    const runId = String(payload?.runId || '');
    if (!/^[\w-]{8,80}$/.test(runId)) throw new Error('Некорректный идентификатор запроса.');
    if (activeRuns.has(runId)) throw new Error('Этот запрос уже выполняется.');
    const controller = new AbortController();
    const run = { controller };
    activeRuns.set(runId, run);
    Promise.resolve(getConfig()).then(async (config) => {
      const canonicalWorkspace = await fs.realpath(config.workspaceDirectory).catch(async () => { await fs.mkdir(config.workspaceDirectory, { recursive: true }); return fs.realpath(config.workspaceDirectory); });
      const projects = await getProjects();
      const project = projectById(projects, String(payload?.projectId || ''));
      let workspaceRoot = canonicalWorkspace;
      if (payload?.projectId && !project) throw new Error('Выбранный проект не найден. Обновите приложение и выберите проект снова.');
      if (project) {
        const proposed = validateProjectRoot(canonicalWorkspace, project);
        workspaceRoot = await fs.realpath(proposed);
        if (!isPathInside(canonicalWorkspace, workspaceRoot)) throw new Error('Папка проекта через символьную ссылку выходит за пределы рабочего пространства.');
      }

      const memoryNotes = await getMemory();
      const sharedMemory = await getSharedMemory();
      const memory = { summary: sharedMemory.summary, notes: memoryNotes };
      const agents = await getAgents();
      const plugins = await getCustomPlugins();
      const vault = await getVault();
      const attachments = await readSelectedAttachments(payload.attachmentIds);
      const attachmentMap = new Map(attachments.map((attachment) => [attachment.id, attachment]));
      const status = await getIntegrationStatus();
      const allConnectedIds = [];
      if (status.github?.connected) allConnectedIds.push('github');
      if (status.google?.connected) allConnectedIds.push('google');
      if (status.instagram?.connected) allConnectedIds.push('instagram');
      for (const server of config.mcpServers.filter((item) => item.enabled)) allConnectedIds.push(server.id);
      const selectedConnectorIds = project ? allConnectedIds : [...new Set((Array.isArray(payload?.connectorIds) ? payload.connectorIds : []).map(String))].filter((id) => allConnectedIds.includes(id));
      const selectedProviderIds = project
        ? Object.entries(status.providers || {}).filter(([, connected]) => connected).map(([id]) => id)
        : [...new Set((Array.isArray(payload?.providerIds) ? payload.providerIds : []).map(String))].filter((id) => status.providers?.[id]);
      const modelRuntime = await getLocalisEngine().start();
      if (!modelRuntime.online || !modelRuntime.baseUrl) throw new Error(modelRuntime.error || 'LamV1.0 не запущена.');
      const runConfig = {
        ...config,
        modelBaseUrl: modelRuntime.baseUrl,
        cloudFallbackEnabled: Boolean(config.cloudFallbackEnabled && selectedProviderIds.includes(config.fallbackProvider)),
      };
      const directTools = await availableConnectorTools(vault, selectedConnectorIds);
      const connectorNames = [];
      for (const id of selectedConnectorIds) {
        const item = status[id];
        connectorNames.push(`${item?.name || item?.account || id}${item?.account ? ` (${item.account})` : ''}`);
      }
      for (const id of selectedProviderIds) connectorNames.push(`${PROVIDERS[id]?.name || id} API`);

      const mcpToolDefinitions = [];
      const mcpToolMap = new Map();
      for (const server of config.mcpServers.filter((item) => item.enabled && selectedConnectorIds.includes(item.id))) {
        try {
          const endpoint = new URL(server.url);
          if (!isLoopbackHost(endpoint.hostname)) await assertPublicHttpUrl(endpoint.href);
          let connection = mcpClients.get(server.id);
          if (!connection) {
            const token = await vault.get(['connectors', 'mcp', server.id, 'token'], '');
            const client = new HttpMcpClient({ url: server.url, token });
            connection = { client, tools: await client.listTools(controller.signal) };
            mcpClients.set(server.id, connection);
          }
          for (const tool of connection.tools) {
            const definition = toModelTool(server, tool);
            mcpToolDefinitions.push(definition);
            mcpToolMap.set(definition.function.name, { client: connection.client, tool, server });
          }
          connectorNames.push(`${server.name} · MCP`);
        } catch (error) {
          emitAgent({ type: 'connector-error', runId, name: server.name, message: String(error.message || error).slice(0, 500) });
        }
      }
      const allAgents = [...agents, ...BUILTIN_PLUGINS.map((plugin) => ({ ...plugin, enabled: config.enabledPluginIds.includes(plugin.id) }))];
      const providerKey = async (providerId) => selectedProviderIds.includes(providerId) ? vault.get(['providers', String(providerId), 'key'], '') : '';
      const providerModel = async (providerId) => vault.get(['providers', String(providerId), 'model'], '');
      const runOutput = await runAgentTurn(payload, {
        signal: controller.signal, workspaceRoot, config: runConfig, project, memory, agents: allAgents, plugins, providerIds: selectedProviderIds,
        connectorNames, connectorTools: [...directTools, ...mcpToolDefinitions], attachmentsById: attachmentMap,
        plugins: [...plugins, ...BUILTIN_PLUGINS],
        emit: emitAgent, requestApproval, openBrowser,
        getProviderKey: providerKey, providerModel,
        executeConnectorTool: (name, args, signal) => executeConnectorTool(name, args, { vault, signal }),
        callMcpTool: async (name, args, signal) => {
          const entry = mcpToolMap.get(name);
          if (!entry) throw new Error('Инструмент MCP устарел или больше не подключён. Перезапустите подключение.');
          return entry.client.callTool(entry.tool.name, args, signal);
        },
        delegateAgent: async (agentId, task, signal) => {
          const target = allAgents.find((agent) => agent.enabled && (agent.id === agentId || agent.name.toLowerCase() === agentId.toLowerCase()));
          if (!target) throw new Error(`Активный агент «${agentId}» не найден. Включите его в настройках → Агенты.`);
          return runLocalSubagent({ baseUrl: runConfig.modelBaseUrl, instructions: target.instructions, task, signal });
        },
        askSpecialist: async (providerId, task, signal) => {
          const key = await providerKey(providerId);
          if (!key) throw new Error(`Для ${providerId} не сохранён API-ключ. Откройте настройки → API.`);
          const provider = providerInfo(providerId);
          const specialistMemory = String(sharedMemory.summary || '').slice(-2500);
          return callProvider({
            providerId, apiKey: key, model: await providerModel(providerId), signal,
            messages: [
              { role: 'system', content: `Ты — внешний specialist-консультант для Localis. Дай конкретное решение, явно укажи риски и то, что нужно проверить. Не утверждай, что выполнил локальные действия.${specialistMemory ? `\nОбщая локальная сводка пользователя:\n${specialistMemory}` : ''}` },
              { role: 'user', content: task },
            ],
          });
        },
        addMemory: async (note) => {
          const current = await getMemory();
          const item = { id: randomUUID(), note: redactSensitive(note).slice(0, 1500), savedAt: new Date().toISOString() };
          const next = [...current, item].slice(-100);
          await writeJsonAtomic(memoryPath(), next);
          sendApp('agent:event', { type: 'memory-updated', count: next.length });
          return { saved: true, note: item.note, memoryCount: next.length };
        },
      });
      if (!controller.signal.aborted) {
        const requestText = redactSensitive(String(payload?.text || (attachments.length ? `Разобрать вложения: ${attachments.map((file) => file.name).join(', ')}` : '')).slice(0, 1200));
        const previous = await getSharedMemory();
        const nextMemory = appendTurn(previous, { request: requestText, outcome: redactSensitive(runOutput), project: project?.name || '' });
        await writeJsonAtomic(sharedMemoryPath(), nextMemory);
        sendApp('agent:event', { type: 'memory-updated', count: memoryNotes.length, sharedSummary: nextMemory.summary, updatedAt: nextMemory.updatedAt });
      }
      return runOutput;
    }).catch((error) => {
      emitAgent({ type: controller.signal.aborted ? 'cancelled' : 'error', runId, message: error.message || String(error) });
    }).finally(() => {
      activeRuns.delete(runId);
    });
    return { accepted: true, runId };
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('ai.localis.desktop');
  setupIpc();
  createMainWindow();
  checkModelRuntime();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  for (const run of activeRuns.values()) run.controller.abort(new Error('Приложение завершает работу.'));
  for (const settle of pendingApprovals.values()) settle(false);
  if (localisEngine) localisEngine.stop().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
