'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const {
  app, BrowserWindow, WebContentsView, dialog, ipcMain, shell,
} = require('electron');
app.setName('localis-ai');

const { runAgentTurn } = require('./lib/agent');
const { defaultConfig, readJson, validateConfig, writeJsonAtomic } = require('./lib/config');
const { normalizeLocalServiceUrl, assertPublicHttpUrl } = require('./lib/security');
const { listWorkspaceFiles } = require('./lib/files');

let mainWindow = null;
let browserWindow = null;
let browserView = null;
let configCache = null;
const activeRuns = new Map();
const pendingApprovals = new Map();
const stagedAttachments = new Map();

const configPath = () => path.join(app.getPath('userData'), 'settings.json');
const statePath = () => path.join(app.getPath('userData'), 'conversations.json');
const memoryPath = () => path.join(app.getPath('userData'), 'memory.json');

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
  return Array.isArray(value) ? value.filter((item) => item && typeof item.note === 'string').slice(-100) : [];
}

function withTimeout(ms, callback) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Таймаут подключения.')), ms);
  return { controller, done: () => clearTimeout(timer), callback };
}

async function checkOllama() {
  const config = await getConfig();
  const request = withTimeout(4000);
  try {
    const response = await fetch(new URL('/api/tags', `${config.ollamaBaseUrl.replace(/\/$/, '')}/`), { signal: request.controller.signal });
    if (!response.ok) throw new Error(`Ollama ответила HTTP ${response.status}`);
    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models.map((model) => ({
      name: String(model.name || model.model || ''),
      size: Number(model.size) || 0,
      modifiedAt: model.modified_at || null,
      family: model.details?.family || '',
      parameterSize: model.details?.parameter_size || '',
      quantization: model.details?.quantization_level || '',
    })).filter((model) => model.name) : [];
    const result = { online: true, baseUrl: config.ollamaBaseUrl, models, version: data.version || null };
    sendApp('ollama:status', result);
    return result;
  } catch (error) {
    const result = { online: false, baseUrl: config.ollamaBaseUrl, models: [], error: error.name === 'AbortError' ? 'Ollama не ответила за 4 секунды.' : (error.message || 'Нет соединения с Ollama.') };
    sendApp('ollama:status', result);
    return result;
  } finally {
    request.done();
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1050,
    minHeight: 700,
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

function requestApproval(detail, signal) {
  if (!mainWindow || mainWindow.isDestroyed() || signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const id = detail.id;
    const timer = setTimeout(() => settle(false), 4 * 60_000);
    const onAbort = () => settle(false);
    function settle(approved) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pendingApprovals.delete(id);
      resolve(Boolean(approved));
    }
    pendingApprovals.set(id, settle);
    signal.addEventListener('abort', onAbort, { once: true });
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
    return {
      config,
      appState: storedState && typeof storedState === 'object' ? storedState : { conversations: [], activeId: null },
      memoryCount: memory.length,
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
    const normalized = validateConfig(value, app.getPath('documents'));
    await writeJsonAtomic(configPath(), normalized);
    configCache = normalized;
    sendApp('ollama:status', { online: false, baseUrl: normalized.ollamaBaseUrl, models: [], checking: true });
    return normalized;
  });

  ipcMain.handle('ollama:check', (event) => {
    requireAppSender(event);
    return checkOllama();
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
    const configPromise = getConfig();
    const run = { controller };
    activeRuns.set(runId, run);
    Promise.resolve(configPromise).then(async (config) => {
      const workspaceRoot = config.workspaceDirectory;
      const memory = await getMemory();
      const attachments = await readSelectedAttachments(payload.attachmentIds);
      const attachmentMap = new Map(attachments.map((attachment) => [attachment.id, attachment]));
      return runAgentTurn(payload, {
        signal: controller.signal,
        workspaceRoot,
        config,
        memory,
        attachmentsById: attachmentMap,
        emit: emitAgent,
        requestApproval,
        openBrowser,
        addMemory: async (note) => {
          const current = await getMemory();
          const item = { id: randomUUID(), note: String(note).slice(0, 1500), savedAt: new Date().toISOString() };
          const next = [...current, item].slice(-100);
          await writeJsonAtomic(memoryPath(), next);
          sendApp('agent:event', { type: 'memory-updated', count: next.length });
          return { saved: true, note: item.note, memoryCount: next.length };
        },
      });
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
  checkOllama();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  for (const run of activeRuns.values()) run.controller.abort(new Error('Приложение завершает работу.'));
  for (const settle of pendingApprovals.values()) settle(false);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
