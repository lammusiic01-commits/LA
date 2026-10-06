'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const AGENT_CHANNELS = new Set(['agent:event', 'agent:approval', 'model:status']);
function subscribe(channel, callback) {
  if (!AGENT_CHANNELS.has(channel) || typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('localis', Object.freeze({
  getState: () => ipcRenderer.invoke('app:get-state'),
  saveState: (state) => ipcRenderer.invoke('app:save-state', state),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  checkModel: () => ipcRenderer.invoke('model:check'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  createWorkspaceFolder: (name) => ipcRenderer.invoke('workspace:create-folder', name),
  createProject: (project) => ipcRenderer.invoke('projects:create', project),
  openProject: (projectId) => ipcRenderer.invoke('projects:open', projectId),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  saveLayout: (layout) => ipcRenderer.invoke('layout:save', layout),
  selectAttachments: () => ipcRenderer.invoke('attachments:select'),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  sendTurn: (payload) => ipcRenderer.invoke('agent:start', payload),
  cancelTurn: (runId) => ipcRenderer.invoke('agent:cancel', runId),
  resolveApproval: (id, approved) => ipcRenderer.invoke('approval:resolve', { id, approved }),
  installGithubAgent: (url, runId) => ipcRenderer.invoke('agent:install-github', { url, runId }),
  inspectAgent: (id) => ipcRenderer.invoke('agents:inspect', id),
  removeAgent: (id) => ipcRenderer.invoke('agents:remove', id),
  toggleAgent: (id, enabled) => ipcRenderer.invoke('agents:toggle', { id, enabled }),
  importPlugin: () => ipcRenderer.invoke('plugins:import'),
  installPluginFromUrl: (url) => ipcRenderer.invoke('plugins:install-url', url),
  togglePlugin: (id, enabled) => ipcRenderer.invoke('plugins:toggle', { id, enabled }),
  removePlugin: (id) => ipcRenderer.invoke('plugins:remove', id),
  searchPlugins: (query) => ipcRenderer.invoke('plugins:search', query),
  connectGithub: (token) => ipcRenderer.invoke('connectors:github', { token }),
  connectGoogle: (clientId, clientSecret) => ipcRenderer.invoke('connectors:google', { clientId, clientSecret }),
  connectInstagram: (token, instagramUserId) => ipcRenderer.invoke('connectors:instagram', { token, instagramUserId }),
  connectTelegram: (token, chatId) => ipcRenderer.invoke('connectors:telegram', { token, chatId }),
  disconnectConnector: (id) => ipcRenderer.invoke('connectors:disconnect', id),
  connectMcp: (name, url, token) => ipcRenderer.invoke('mcp:connect', { name, url, token }),
  onAgentEvent: (callback) => subscribe('agent:event', callback),
  onApproval: (callback) => subscribe('agent:approval', callback),
  onModelStatus: (callback) => subscribe('model:status', callback),
}));
