'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const AGENT_CHANNELS = new Set(['agent:event', 'agent:approval', 'ollama:status']);
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
  checkOllama: () => ipcRenderer.invoke('ollama:check'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  openBrowser: (url) => ipcRenderer.invoke('browser:open', url),
  selectAttachments: () => ipcRenderer.invoke('attachments:select'),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  sendTurn: (payload) => ipcRenderer.invoke('agent:start', payload),
  cancelTurn: (runId) => ipcRenderer.invoke('agent:cancel', runId),
  resolveApproval: (id, approved) => ipcRenderer.invoke('approval:resolve', { id, approved }),
  onAgentEvent: (callback) => subscribe('agent:event', callback),
  onApproval: (callback) => subscribe('agent:approval', callback),
  onOllamaStatus: (callback) => subscribe('ollama:status', callback),
}));
