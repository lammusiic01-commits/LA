'use strict';

const $ = (selector) => document.querySelector(selector);
const api = window.localis;
const view = {
  sidebar: $('#sidebar'),
  conversationList: $('#conversation-list'),
  welcome: $('#welcome-screen'),
  messageList: $('#message-list'),
  stage: $('#conversation-stage'),
  input: $('#prompt-input'),
  sendButton: $('#send-button'),
  attachmentStrip: $('#attachment-strip'),
  connection: $('#connection-pill'),
  connectionLabel: $('#connection-label'),
  modelSelect: $('#model-select'),
  title: $('#active-title'),
  approvalBackdrop: $('#approval-backdrop'),
  settingsBackdrop: $('#settings-backdrop'),
  createBackdrop: $('#create-backdrop'),
  appShell: $('.app-shell'),
  activitySidebar: $('#activity-sidebar'),
};

let state = { conversations: [], activeId: null, activeProjectId: null, activity: [] };
let config = {};
let memoryCount = 0;
let memoryNotes = [];
let sharedMemory = { summary: '', entries: [] };
let projects = [];
let agents = [];
let customPlugins = [];
let providerCatalog = [];
let integrationStatus = {};
let pendingConnectorIds = [];
let pendingProviderIds = [];
let modelStatus = { online: false, models: [] };
let pendingAttachments = [];
let activeRunId = null;
let runtimeState = 'idle';
let runtimeTitle = 'Агент ожидает задачу';
let runtimeDescription = 'Здесь появятся шаги, вызовы инструментов и ошибки.';
let createMode = 'project';
const runContexts = new Map();
const approvals = [];
let activeApproval = null;
let saveTimer = null;
let searchQuery = '';
let oldestFirst = false;
let initialized = false;

function uuid() {
  return globalThis.crypto?.randomUUID?.() || `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function inlineMarkdown(value) {
  const code = [];
  let html = escapeHtml(value).replace(/`([^`]+)`/g, (_match, inner) => {
    const token = `LOCALISCODE${code.length}TOKEN`;
    code.push(`<code>${inner}</code>`);
    return token;
  });
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, text, url) =>
    `<a href="${url}" data-external-link="1" rel="noreferrer">${text}</a>`);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
  code.forEach((fragment, index) => { html = html.replace(`LOCALISCODE${index}TOKEN`, fragment); });
  return html;
}

function markdownToHtml(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const output = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];

  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listItems.length) output.push(`<${listType}>${listItems.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</${listType}>`);
    listItems = [];
    listType = null;
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```([^`]*)\s*$/);
    if (fence) {
      if (!inCode) {
        flushParagraph(); flushList(); inCode = true; codeLang = fence[1].trim(); codeLines = [];
      } else {
        const languageClass = codeLang ? ` class="language-${escapeHtml(codeLang.slice(0, 24))}"` : '';
        output.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCode = false; codeLang = ''; codeLines = [];
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const listMatch = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/);
    if (listMatch) {
      flushParagraph();
      const nextType = /^\s*\d+[.)]\s+/.test(line) ? 'ol' : 'ul';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push(listMatch[1]);
      continue;
    }
    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      flushParagraph(); flushList();
      output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    flushList(); paragraph.push(line);
  }
  if (inCode) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushParagraph(); flushList();
  return output.join('');
}

function activeConversation() {
  return state.conversations.find((item) => item.id === state.activeId) || null;
}

function activeProject() {
  const conversation = activeConversation();
  const projectId = conversation ? conversation.projectId : state.activeProjectId;
  return projects.find((item) => item.id === projectId) || null;
}

function connectedConnectorIds() {
  const ids = [];
  if (integrationStatus.github?.connected) ids.push('github');
  if (integrationStatus.google?.connected) ids.push('google');
  if (integrationStatus.instagram?.connected) ids.push('instagram');
  for (const server of integrationStatus.mcp || []) if (server.enabled) ids.push(server.id);
  return ids;
}

function currentConnectorSelection() {
  if (activeProject()) return connectedConnectorIds();
  const conversation = activeConversation();
  return conversation ? (conversation.connectorIds || []) : pendingConnectorIds;
}

function currentProviderSelection() {
  if (activeProject()) return Object.entries(integrationStatus.providers || {}).filter(([, connected]) => connected).map(([id]) => id);
  const conversation = activeConversation();
  return conversation ? (conversation.providerIds || []) : pendingProviderIds;
}

function updateConnectorSelectionUi() {
  const selectedConnectors = new Set(currentConnectorSelection());
  document.querySelectorAll('[data-connector]').forEach((button) => {
    const id = button.dataset.connector;
    const connected = connectedConnectorIds().includes(id);
    button.classList.toggle('selected', selectedConnectors.has(id));
    button.classList.toggle('unavailable', !connected);
    button.title = !connected ? 'Сначала настройте это подключение в настройках.' : selectedConnectors.has(id) ? 'Подключение активно в этом чате' : 'Нажмите, чтобы включить в этом чате';
  });
  const providerId = $('#chat-provider-select')?.value;
  const providerActive = currentProviderSelection().includes(providerId);
  const providerReady = Boolean(integrationStatus.providers?.[providerId]);
  const providerToggle = $('#chat-provider-toggle');
  providerToggle?.classList.toggle('selected', providerActive);
  if (providerToggle) providerToggle.innerHTML = `<span>✦</span> API: ${providerActive ? 'вкл.' : providerReady ? 'выкл.' : 'ключ?'}`;
  for (const chip of document.querySelectorAll('[data-mcp-connector]')) {
    chip.classList.toggle('selected', selectedConnectors.has(chip.dataset.mcpConnector));
  }
}

function toggleConnectorSelection(id) {
  if (activeProject()) { showToast('В проекте уже автоматически включены все настроенные подключения.', ''); return; }
  const connected = connectedConnectorIds().includes(id);
  if (!connected) { openSettings('connectors'); showToast('Сначала настройте этот коннектор в разделе «Коннекторы».', ''); return; }
  const conversation = activeConversation();
  const selected = conversation ? (conversation.connectorIds || []) : pendingConnectorIds;
  const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
  if (conversation) conversation.connectorIds = next; else pendingConnectorIds = next;
  render(); scheduleSave();
}

function toggleProviderSelection() {
  if (activeProject()) { showToast('В проекте доступны все сохранённые AI-провайдеры.', ''); return; }
  const id = $('#chat-provider-select').value;
  if (!integrationStatus.providers?.[id]) { openSettings('api'); showToast('Сначала добавьте API-ключ для этого провайдера.', ''); return; }
  const conversation = activeConversation();
  const selected = conversation ? (conversation.providerIds || []) : pendingProviderIds;
  const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
  if (conversation) conversation.providerIds = next; else pendingProviderIds = next;
  updateConnectorSelectionUi(); scheduleSave();
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function basename(value) {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || value;
}

function makeConversation() {
  const conversation = { id: uuid(), title: 'Новый диалог', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), projectId: state.activeProjectId || null, connectorIds: [...pendingConnectorIds], providerIds: [...pendingProviderIds], messages: [] };
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  scheduleSave();
  return conversation;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveState({ conversations: state.conversations.slice(0, 100), activeId: state.activeId, activeProjectId: state.activeProjectId })
      .catch((error) => showToast(`Не удалось сохранить историю: ${error.message}`, 'error'));
  }, 280);
}

function renderSidebar() {
  view.conversationList.replaceChildren();
  const items = state.conversations.filter((conversation) => {
    const title = conversation.title || 'Новый диалог';
    return !searchQuery || title.toLocaleLowerCase().includes(searchQuery.toLocaleLowerCase());
  });
  if (oldestFirst) items.reverse();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-history';
    empty.textContent = searchQuery ? 'Совпадений не найдено.' : 'Здесь появятся ваши диалоги.';
    view.conversationList.append(empty);
    return;
  }
  for (const conversation of items) {
    const button = document.createElement('button');
    button.className = `conversation-item${conversation.id === state.activeId ? ' active' : ''}`;
    button.type = 'button';
    button.title = conversation.title;
    const icon = document.createElement('span');
    icon.className = 'chat-icon';
    icon.textContent = '◌';
    const title = document.createElement('span');
    title.className = 'conversation-title';
    title.textContent = conversation.title || 'Новый диалог';
    const remove = document.createElement('span');
    remove.className = 'conversation-delete';
    remove.setAttribute('role', 'button');
    remove.setAttribute('tabindex', '0');
    remove.setAttribute('aria-label', 'Удалить диалог');
    remove.title = 'Удалить диалог';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteConversation(conversation.id);
    });
    button.append(icon, title, remove);
    button.addEventListener('click', () => {
      state.activeId = conversation.id;
      render();
      scheduleSave();
    });
    view.conversationList.append(button);
  }
}

function renderProjects() {
  const list = $('#project-list');
  list.replaceChildren();
  if (!projects.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-history';
    empty.textContent = 'Пока нет проектов. Создайте папку проекта для отдельной рабочей среды.';
    list.append(empty);
    return;
  }
  for (const project of projects) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `project-item${project.id === (activeConversation()?.projectId || state.activeProjectId) ? ' active' : ''}`;
    button.title = `${project.name}\n${project.path}`;
    const icon = document.createElement('span'); icon.className = 'project-icon'; icon.textContent = '◧';
    const title = document.createElement('span'); title.textContent = project.name;
    const open = document.createElement('span'); open.className = 'project-open-button'; open.textContent = '↗'; open.title = 'Открыть папку проекта'; open.setAttribute('role', 'button'); open.setAttribute('tabindex', '0');
    open.addEventListener('click', async (event) => {
      event.stopPropagation();
      try { await api.openProject(project.id); } catch (error) { showToast(error.message, 'error'); }
    });
    button.append(icon, title, open);
    button.addEventListener('click', () => {
      state.activeProjectId = project.id;
      const conversation = activeConversation();
      if (conversation && conversation.projectId !== project.id) state.activeId = null;
      render(); scheduleSave(); view.input.focus();
    });
    list.append(button);
  }
}

function actionIcon(name) {
  const icons = { web_search: '⌕', read_webpage: '↗', open_browser: '◎', list_workspace_files: '▧', read_workspace_file: '▤', write_workspace_file: '✎', create_document: '▤', generate_image: '✦', make_video: '▶', run_command: '⌘', remember: '✧' };
  return icons[name] || '•';
}

function activityIconFor(status, kind) {
  if (status === 'success') return '✓';
  if (status === 'denied') return '×';
  if (status === 'error') return '!';
  if (status === 'running') return '…';
  if (kind === 'agent') return '◎';
  if (kind === 'project') return '▧';
  if (kind === 'memory') return '✧';
  return '⌘';
}

function addActivity({ id, label, details = '', status = 'running', kind = 'tool', runId = '', time = new Date().toISOString() }) {
  const activity = Array.isArray(state.activity) ? state.activity : (state.activity = []);
  let existing = id ? activity.find((item) => item.id === id) : null;
  if (existing) Object.assign(existing, { label, details, status, kind, runId, time });
  else activity.push({ id: id || uuid(), label: String(label || 'Действие').slice(0, 260), details: String(details || '').slice(0, 1200), status, kind, runId, time });
  state.activity = activity.slice(-120);
  scheduleSave();
  renderActivity();
}

function renderActivity() {
  const list = $('#activity-list');
  if (!list) return;
  const items = Array.isArray(state.activity) ? state.activity.slice(-60).reverse() : [];
  list.replaceChildren();
  $('#activity-empty').hidden = items.length > 0;
  const indicator = $('#runtime-indicator');
  indicator.classList.toggle('running', runtimeState === 'running');
  indicator.classList.toggle('success', runtimeState === 'success');
  indicator.classList.toggle('error', runtimeState === 'error');
  $('#runtime-title').textContent = runtimeTitle;
  $('#runtime-description').textContent = runtimeDescription;
  $('#runtime-progress').hidden = runtimeState !== 'running';
  const count = items.filter((item) => item.status === 'success').length;
  $('#runtime-step-count').textContent = `${count} шаг${count === 1 ? '' : count > 1 && count < 5 ? 'а' : 'ов'}`;
  for (const item of items) {
    const card = document.createElement('div');
    card.className = `activity-log-item ${item.status || ''}`;
    const icon = document.createElement('span'); icon.className = 'activity-log-icon'; icon.textContent = activityIconFor(item.status, item.kind);
    const copy = document.createElement('div'); copy.className = 'activity-log-copy';
    const title = document.createElement('strong'); title.textContent = item.label;
    const detail = document.createElement('small');
    const time = item.time ? new Date(item.time).toLocaleTimeString(config.uiLanguage === 'en' ? 'en-GB' : config.uiLanguage === 'lv' ? 'lv-LV' : 'ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
    detail.textContent = [time, item.details].filter(Boolean).join(' · ');
    copy.append(title, detail); card.append(icon, copy); list.append(card);
  }
}

function renderMessage(message) {
  let article = document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`);
  if (!article) {
    article = document.createElement('article');
    article.className = `message ${message.role}`;
    article.dataset.messageId = message.id;
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = message.role === 'assistant' ? 'L' : 'Я';
    const main = document.createElement('div');
    main.className = 'message-main';
    const header = document.createElement('div');
    header.className = 'message-heading';
    const name = document.createElement('strong');
    name.textContent = message.role === 'assistant' ? 'Localis' : 'Вы';
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = message.createdAt ? new Date(message.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
    header.append(name, time);
    const body = document.createElement('div');
    body.className = 'message-body';
    const attachments = document.createElement('div');
    attachments.className = 'message-attachments';
    const activities = document.createElement('div');
    activities.className = 'activity-stack';
    const error = document.createElement('div');
    error.className = 'error-note';
    error.hidden = true;
    main.append(header, body, attachments, activities, error);
    article.append(avatar, main);
  }
  const body = article.querySelector('.message-body');
  body.innerHTML = message.role === 'assistant' ? markdownToHtml(message.content || '') : escapeHtml(message.content || '').replace(/\n/g, '<br>');
  if (message.streaming && !message.content) body.innerHTML = '<span class="activity-label">Думаю<span class="typing-dots">…</span></span>';
  const attachments = article.querySelector('.message-attachments');
  attachments.replaceChildren();
  for (const attachment of message.attachments || []) {
    const badge = document.createElement('span');
    badge.className = 'attachment-badge';
    badge.textContent = `${attachment.kind === 'image' ? '▧' : '▤'} ${attachment.name}`;
    attachments.append(badge);
  }
  const activityStack = article.querySelector('.activity-stack');
  activityStack.replaceChildren();
  for (const action of message.actions || []) {
    const row = document.createElement('div');
    row.className = `activity-item ${action.status || ''}`;
    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.textContent = action.status === 'success' ? '✓' : action.status === 'denied' ? '×' : action.status === 'error' ? '!' : action.status === 'running' ? '…' : actionIcon(action.name);
    const text = document.createElement('span');
    text.className = 'activity-label';
    text.textContent = action.label || action.summary || action.name;
    row.append(icon, text);
    activityStack.append(row);
  }
  const errorBox = article.querySelector('.error-note');
  errorBox.hidden = !message.error;
  errorBox.textContent = message.error || '';
  return article;
}

function renderThread({ scroll = false } = {}) {
  const conversation = activeConversation();
  const hasMessages = Boolean(conversation?.messages?.length);
  view.welcome.hidden = hasMessages;
  view.messageList.hidden = !hasMessages;
  view.messageList.replaceChildren();
  view.title.textContent = conversation?.title || activeProject()?.name || 'Новый диалог';
  if (conversation) {
    for (const message of conversation.messages) view.messageList.append(renderMessage(message));
  }
  if (scroll) requestAnimationFrame(() => { view.stage.scrollTop = view.stage.scrollHeight; });
}

function render() {
  renderSidebar();
  renderProjects();
  renderThread();
  const project = activeProject();
  $('#project-mode-pill').hidden = !project;
  $('#project-mode-name').textContent = project?.name || '';
  $('#composer-project-label').textContent = project?.name || 'Общий чат';
  $('#memory-count').textContent = String(memoryCount);
  $('#workspace-label').textContent = basename(config.workspaceDirectory || 'Localis Workspace');
  renderActivity();
  updateConnectorSelectionUi();
  updateComposerState();
}

function updateComposerState() {
  const running = Boolean(activeRunId);
  view.sendButton.classList.toggle('stop', running);
  view.sendButton.title = running ? 'Остановить' : 'Отправить';
  view.sendButton.setAttribute('aria-label', running ? 'Остановить выполнение' : 'Отправить сообщение');
  view.sendButton.innerHTML = running ? '<span class="send-stop"></span>' : '<span class="send-arrow">↑</span>';
  view.input.disabled = running;
  $('#attach-button').disabled = running;
  $('#attach-button').style.opacity = running ? '.45' : '1';
}

function drawAttachments() {
  view.attachmentStrip.replaceChildren();
  view.attachmentStrip.hidden = pendingAttachments.length === 0;
  for (const attachment of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    const label = document.createElement('span');
    label.textContent = `${attachment.kind === 'image' ? '▧' : '▤'} ${attachment.name} · ${formatBytes(attachment.size)}`;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Убрать ${attachment.name}`);
    remove.addEventListener('click', () => { pendingAttachments = pendingAttachments.filter((item) => item.id !== attachment.id); drawAttachments(); });
    chip.append(label, remove);
    view.attachmentStrip.append(chip);
  }
}

function setModelStatus(status) {
  modelStatus = status || { online: false, checking: false, models: [] };
  view.connection.classList.toggle('online', Boolean(modelStatus.online));
  view.connection.classList.toggle('offline', !modelStatus.online && !modelStatus.checking);
  view.connectionLabel.textContent = modelStatus.online
    ? 'LamV1.0 · готова'
    : modelStatus.checking ? 'Запуск LamV1.0…' : 'LamV1.0 не запущена';
  view.connection.title = modelStatus.online
    ? `Подключено: ${modelStatus.engine || 'LamV1.0'} · ${modelStatus.baseUrl || 'локально'}`
    : (modelStatus.error || 'Нажмите, чтобы запустить LamV1.0.');
  config.model = 'lam-v1.0';
  view.modelSelect.value = 'lam-v1.0';
  view.modelSelect.disabled = true;
  const runtimeLabel = $('#model-runtime-result');
  if (runtimeLabel) runtimeLabel.textContent = modelStatus.online
    ? 'LamV1.0 работает локально.'
    : (modelStatus.checking ? 'Запускается встроенная модель…' : (modelStatus.error || 'Модель входит в комплект Localis.'));
  const restartButton = $('#check-model-button');
  if (restartButton) restartButton.disabled = Boolean(modelStatus.checking);
}

async function refreshModelRuntime({ quiet = true } = {}) {
  view.connectionLabel.textContent = 'Запуск LamV1.0…';
  view.connection.classList.remove('offline', 'online');
  try {
    const status = await api.checkModel();
    setModelStatus(status);
    if (!status.online && !quiet) showToast(status.error || 'Не удалось запустить LamV1.0.', 'error', 7000);
    return status;
  } catch (error) {
    const status = { online: false, checking: false, models: [], runtime: 'lam-v1.0', engine: 'LamV1.0', error: error.message || String(error) };
    setModelStatus(status);
    if (!quiet) showToast(status.error, 'error');
    return status;
  }
}

function showToast(message, kind = '', duration = 3400) {
  const region = $('#toast-region');
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = String(message || 'Готово');
  region.append(toast);
  setTimeout(() => toast.remove(), duration);
}

function conversationTitle(text, attachments) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean) return clean.length > 39 ? `${clean.slice(0, 39).trim()}…` : clean;
  return attachments?.length ? `Анализ: ${attachments[0].name}` : 'Новый диалог';
}

function beginAssistantRun(conversation, message, runId) {
  runContexts.set(runId, { conversationId: conversation.id, assistant: message });
  activeRunId = runId;
  updateComposerState();
  renderThread({ scroll: true });
}

function setActivity(context, event, status) {
  if (!context) return;
  let action = context.assistant.actions.find((item) => item.toolId === event.toolId);
  if (!action) {
    action = { toolId: event.toolId, name: event.name, summary: event.summary || '', label: event.summary || event.name, status: 'approval' };
    context.assistant.actions.push(action);
  }
  if (event.summary && event.type === 'tool-complete') action.label = event.summary;
  if (status) action.status = status;
  const conversation = state.conversations.find((item) => item.id === context.conversationId);
  if (conversation?.id === state.activeId) {
    const existing = document.querySelector(`[data-message-id="${CSS.escape(context.assistant.id)}"]`);
    const updated = renderMessage(context.assistant);
    if (existing) existing.replaceWith(updated); else view.messageList.append(updated);
    view.stage.scrollTop = view.stage.scrollHeight;
  }
  scheduleSave();
}

function finishRun(runId) {
  const context = runContexts.get(runId);
  if (context) {
    context.assistant.streaming = false;
    const conversation = state.conversations.find((item) => item.id === context.conversationId);
    if (conversation) conversation.updatedAt = new Date().toISOString();
    if (context.conversationId === state.activeId) renderThread({ scroll: true });
  }
  runContexts.delete(runId);
  if (activeRunId === runId) activeRunId = null;
  updateComposerState();
  scheduleSave();
}

function handleAgentEvent(event) {
  const context = runContexts.get(event.runId);
  if (event.type === 'run-start') {
    runtimeState = 'running'; runtimeTitle = event.project ? `Работа над проектом · ${event.project}` : 'Агент выполняет задачу'; runtimeDescription = `Модель ${event.model || 'LamV1.0'} · наблюдайте за шагами ниже`;
    addActivity({ id: `run:${event.runId}`, label: runtimeTitle, details: runtimeDescription, status: 'running', kind: 'agent', runId: event.runId });
    renderActivity();
    return;
  }
  if (event.type === 'assistant-chunk') {
    if (!context) return;
    context.assistant.content += event.text || '';
    runtimeDescription = 'Модель формирует ответ и обрабатывает результат инструмента…';
    const conversation = state.conversations.find((item) => item.id === context.conversationId);
    if (conversation?.id === state.activeId) {
      const existing = document.querySelector(`[data-message-id="${CSS.escape(context.assistant.id)}"]`);
      const updated = renderMessage(context.assistant);
      if (existing) existing.replaceWith(updated); else view.messageList.append(updated);
      view.stage.scrollTop = view.stage.scrollHeight;
    }
    renderActivity(); scheduleSave();
    return;
  }
  if (event.type === 'tool-start') {
    setActivity(context, event, 'approval');
    addActivity({ id: event.toolId, label: event.summary || event.name, details: 'Ожидает подтверждения пользователя', status: 'approval', kind: 'tool', runId: event.runId });
    runtimeDescription = `Подготовлен инструмент: ${event.name}`; renderActivity(); return;
  }
  if (event.type === 'approval-auto') {
    addActivity({ id: event.toolId || uuid(), label: event.summary || event.name || 'Действие разрешено', details: 'Запущено в сохранённом режиме полного доступа', status: 'running', kind: 'tool', runId: event.runId });
    return;
  }
  if (event.type === 'tool-running') {
    setActivity(context, event, 'running');
    addActivity({ id: event.toolId, label: event.summary || event.name, details: 'Выполняется локально или через подключённый сервис', status: 'running', kind: 'tool', runId: event.runId });
    runtimeDescription = `Выполняется: ${event.name}`; return;
  }
  if (event.type === 'tool-complete') {
    const status = event.approved === false ? 'denied' : event.ok ? 'success' : 'error';
    setActivity(context, event, status);
    addActivity({ id: event.toolId, label: event.summary || event.name, details: event.ok ? 'Результат получен' : event.summary || 'Инструмент сообщил об ошибке', status, kind: 'tool', runId: event.runId });
    runtimeDescription = event.ok ? `Завершено: ${event.name}` : `Нужно обойти ошибку: ${event.name}`;
    if (!event.ok && event.approved !== false) runtimeState = 'running';
    renderActivity(); return;
  }
  if (event.type === 'run-retry') {
    runtimeState = 'running'; runtimeDescription = 'Попытка восстановления после ошибки…';
    addActivity({ id: `retry:${event.runId}:${event.attempt}`, label: 'Повторная попытка модели', details: event.message, status: 'error', kind: 'agent', runId: event.runId }); return;
  }
  if (event.type === 'cloud-fallback') {
    runtimeDescription = `Резервный ответ через ${event.provider} · ${event.model}`;
    addActivity({ id: `fallback:${event.runId}`, label: 'Используется резервный AI-провайдер', details: `${event.provider} · ${event.model}`, status: 'running', kind: 'agent', runId: event.runId }); return;
  }
  if (event.type === 'connector-error') {
    addActivity({ id: `connector-error:${event.runId}:${event.name}`, label: `Ошибка подключения · ${event.name}`, details: event.message, status: 'error', kind: 'tool', runId: event.runId }); return;
  }
  if (event.type === 'agent-install-progress') {
    runtimeState = 'running'; runtimeTitle = 'Установка specialist agent'; runtimeDescription = event.message || 'Скачивание репозитория…';
    addActivity({ id: `agent-install:${event.message}`, label: 'Установка агента', details: event.message, status: 'running', kind: 'agent' }); return;
  }
  if (event.type === 'agent-installed') {
    addActivity({ id: `installed:${event.agent?.id || uuid()}`, label: `Агент подключён · ${event.agent?.name || 'GitHub'}`, details: event.agent?.url || '', status: 'success', kind: 'agent' });
    api.getState().then((loaded) => { agents = loaded.agents || []; renderAgentSettings(); }).catch(() => {});
    return;
  }
  if (event.type === 'turn-complete') {
    if (context) context.assistant.content = event.text || context.assistant.content;
    runtimeState = 'success'; runtimeTitle = 'Задача завершена'; runtimeDescription = 'Результаты и фактически выполненные шаги сохранены локально.';
    addActivity({ id: `run:${event.runId}`, label: runtimeTitle, details: runtimeDescription, status: 'success', kind: 'agent', runId: event.runId });
    finishRun(event.runId); return;
  }
  if (event.type === 'error') {
    if (context) context.assistant.error = event.message || 'Не удалось завершить запрос.';
    runtimeState = 'error'; runtimeTitle = 'Нужна проверка'; runtimeDescription = event.message || 'Операция не завершилась.';
    addActivity({ id: `run:${event.runId}`, label: runtimeTitle, details: runtimeDescription, status: 'error', kind: 'agent', runId: event.runId });
    finishRun(event.runId); showToast(event.message || 'Ошибка агента.', 'error', 6000); return;
  }
  if (event.type === 'cancelled') {
    if (context) context.assistant.error = 'Выполнение остановлено пользователем.';
    runtimeState = 'idle'; runtimeTitle = 'Запрос остановлен'; runtimeDescription = 'Уже выполненные шаги сохранены в журнале.';
    addActivity({ id: `run:${event.runId}`, label: runtimeTitle, details: runtimeDescription, status: 'denied', kind: 'agent', runId: event.runId });
    finishRun(event.runId); showToast('Запрос остановлен.', ''); return;
  }
  if (event.type === 'memory-updated') {
    memoryCount = Number(event.count) || memoryCount;
    if (event.sharedSummary) sharedMemory.summary = event.sharedSummary;
    if (event.updatedAt) sharedMemory.updatedAt = event.updatedAt;
    $('#memory-count').textContent = String(memoryCount);
    $('#memory-description').textContent = `Пользовательских заметок: ${memoryCount}. Общая сводка обновлена локально.`;
    $('#shared-memory-preview').textContent = sharedMemory.summary || 'Общая сводка появится после первой задачи.';
  }
}

async function runGithubInstallMessage(text, repositoryUrl) {
  let conversation = activeConversation();
  if (!conversation) conversation = makeConversation();
  const userMessage = { id: uuid(), role: 'user', content: text, createdAt: new Date().toISOString(), attachments: [] };
  const assistantMessage = { id: uuid(), role: 'assistant', content: '', createdAt: new Date().toISOString(), actions: [], streaming: true };
  conversation.messages.push(userMessage, assistantMessage);
  conversation.title = conversation.messages.filter((message) => message.role === 'user').length === 1 ? conversationTitle(text) : conversation.title;
  conversation.updatedAt = new Date().toISOString();
  state.activeId = conversation.id;
  const runId = uuid(); runContexts.set(runId, { conversationId: conversation.id, assistant: assistantMessage });
  activeRunId = runId; runtimeState = 'running'; runtimeTitle = 'Установка GitHub skill'; runtimeDescription = 'Запрашиваются только текстовые инструкции из публичного репозитория.';
  view.input.value = ''; resizeInput(); render(); beginAssistantRun(conversation, assistantMessage, runId); scheduleSave();
  try {
    const result = await api.installGithubAgent(repositoryUrl, runId);
    assistantMessage.content = `Подключил skill ${result.agent.name}.\n\nИмпортированы файлы: ${(result.agent.skillFiles || []).join(', ')}. В локальном реестре сохранены инструкции, а исходный код репозитория не клонировался и не запускался. Перед использованием можно просмотреть текст навыка в настройках → Агенты.`;
    runtimeState = 'success'; runtimeTitle = `Агент готов · ${result.agent.name}`; runtimeDescription = 'Навыки и метаданные хранятся локально.';
    await reloadLocalState();
    showToast(`Агент ${result.agent.name} подключён.`, 'success', 5000);
  } catch (error) {
    assistantMessage.content = `Не удалось импортировать GitHub skill.\n\n${error.message || String(error)}\n\nПроверьте публичную ссылку GitHub, лимит API и наличие небольшого Markdown-файла с инструкциями. Код репозитория не клонировался и не исполнялся.`;
    assistantMessage.error = error.message || String(error);
    runtimeState = 'error'; runtimeTitle = 'Установка не завершена'; runtimeDescription = error.message || String(error);
    showToast(assistantMessage.error, 'error', 6000);
  } finally {
    finishRun(runId);
  }
}

async function sendMessage() {
  if (activeRunId) {
    const runId = activeRunId;
    await api.cancelTurn(runId).catch(() => {});
    return;
  }
  const text = view.input.value.trim();
  if (!text && !pendingAttachments.length) return;
  const installCommand = text.match(/^install\s+github\s+(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?)(?:\s*)$/i);
  if (installCommand && !pendingAttachments.length) { await runGithubInstallMessage(text, installCommand[1]); return; }
  if (!modelStatus.online) {
    showToast(modelStatus.error || 'Дождитесь запуска LamV1.0.', 'error', 6000);
    return;
  }
  if (pendingAttachments.some((attachment) => attachment.kind === 'image')) {
    showToast('LamV1.0 в этой сборке — текстовая модель; анализ изображений не поддерживается.', 'error', 6500);
    return;
  }
  const model = 'lam-v1.0';
  let conversation = activeConversation();
  if (!conversation) conversation = makeConversation();
  const history = conversation.messages.filter((message) => ['user', 'assistant'].includes(message.role)).map((message) => ({ role: message.role, content: message.content || '' }));
  const attached = pendingAttachments.map(({ id, name, kind, size }) => ({ id, name, kind, size }));
  const userMessage = {
    id: uuid(), role: 'user', content: text, createdAt: new Date().toISOString(),
    attachments: attached.map(({ name, kind }) => ({ name, kind })),
  };
  const assistantMessage = { id: uuid(), role: 'assistant', content: '', createdAt: new Date().toISOString(), actions: [], streaming: true };
  conversation.messages.push(userMessage, assistantMessage);
  conversation.title = conversation.messages.filter((message) => message.role === 'user').length === 1 ? conversationTitle(text, attached) : conversation.title;
  conversation.updatedAt = new Date().toISOString();
  state.activeId = conversation.id;
  const runId = uuid();
  const attachmentIds = attached.map((attachment) => attachment.id);
  pendingAttachments = [];
  view.input.value = '';
  resizeInput();
  drawAttachments();
  render();
  beginAssistantRun(conversation, assistantMessage, runId);
  scheduleSave();
  try {
    await api.sendTurn({ runId, model, history, text, attachmentIds, projectId: conversation.projectId || null, connectorIds: conversation.connectorIds || [], providerIds: conversation.providerIds || [] });
  } catch (error) {
    assistantMessage.error = error.message || 'Не удалось запустить запрос.';
    finishRun(runId);
    showToast(assistantMessage.error, 'error');
  }
}

function resizeInput() {
  view.input.style.height = 'auto';
  view.input.style.height = `${Math.min(view.input.scrollHeight, 150)}px`;
}

function deleteConversation(id) {
  state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
  if (state.activeId === id) state.activeId = state.conversations[0]?.id || null;
  render();
  scheduleSave();
}

function renderApproval() {
  activeApproval = approvals.shift() || null;
  if (!activeApproval) { view.approvalBackdrop.hidden = true; return; }
  view.approvalBackdrop.hidden = false;
  const actionName = String(activeApproval.name || '');
  const isHighRisk = activeApproval.risk === 'high';
  const isNetwork = ['web_search', 'read_webpage', 'open_browser'].includes(actionName);
  const isWrite = ['write_workspace_file', 'create_document', 'generate_image', 'make_video', 'remember'].includes(actionName) || /create|publish|commit|draft|issue/i.test(actionName);
  const title = actionName === 'agent_install' ? 'Установить GitHub skill?' : actionName === 'mcp_connect' ? 'Подключить MCP-сервер?' : actionName === 'cloud_fallback' || actionName === 'ask_specialist' ? 'Передать задачу облачному AI?' : actionName === 'run_command' ? 'Разрешить запуск команды?' : 'Разрешить действие?';
  const warningText = actionName === 'agent_install'
    ? 'Скачивается публичный репозиторий. Localis читает Markdown-инструкции и не исполняет код автоматически; всё равно проверьте источник и skill-текст.'
    : actionName === 'mcp_connect'
      ? 'Подключённый MCP-сервер может возвращать данные и выполнять внешние операции. В обычном режиме каждый вызов инструментов будет отдельно показан.'
      : actionName === 'cloud_fallback' || actionName === 'ask_specialist'
        ? 'Текст задачи и указанный в подробностях контекст будут отправлены выбранному внешнему AI-provider. API-ключ не появится в сообщении, но содержимое покинет этот компьютер.'
        : isHighRisk
          ? 'Команда или внешняя запись исполняется с правами вашей учётной записи Windows. Localis не создаёт OS-песочницу. Проверьте каждую команду и необратимое действие.'
          : 'Запрос отправит поисковый текст или URL в интернет. Содержимое сайтов считается недоверенными данными.';
  $('#approval-icon').textContent = isHighRisk ? '!' : isNetwork ? '↗' : isWrite ? '✎' : '◈';
  $('#approval-kind').textContent = actionName === 'agent_install' ? 'УСТАНОВКА SKILL · ПРОВЕРЬТЕ ИСТОЧНИК' : actionName === 'cloud_fallback' || actionName === 'ask_specialist' ? 'ПЕРЕДАЧА ДАННЫХ В ОБЛАКО' : isHighRisk ? 'ПОВЫШЕННЫЙ РИСК · ПРОВЕРЬТЕ ДЕЙСТВИЕ' : isNetwork ? 'ДОСТУП К ИНТЕРНЕТУ' : isWrite ? 'ЗАПИСЬ ИЛИ СОЗДАНИЕ ДАННЫХ' : 'ДОСТУП К ФАЙЛАМ';
  $('#approval-title').textContent = title;
  $('#approval-summary').textContent = activeApproval.summary || actionName;
  $('#approval-detail').textContent = activeApproval.arguments || '{}';
  const warning = $('#approval-warning');
  warning.hidden = !isHighRisk && !isNetwork && !['cloud_fallback', 'ask_specialist', 'agent_install', 'mcp_connect'].includes(actionName);
  warning.querySelector('p').textContent = warningText;
  $('#approval-accept').innerHTML = actionName === 'cloud_fallback' || actionName === 'ask_specialist' ? 'Передать задачу <span>→</span>' : actionName === 'agent_install' ? 'Установить skill <span>→</span>' : 'Разрешить один раз <span>→</span>';
}

async function answerApproval(approved) {
  if (!activeApproval) return;
  const current = activeApproval;
  activeApproval = null;
  view.approvalBackdrop.hidden = true;
  try { await api.resolveApproval(current.id, approved); }
  catch (error) { showToast(error.message, 'error'); }
  renderApproval();
}

const BUILTIN_PLUGIN_CARDS = [
  { id: 'data-analysis', name: 'Data Analysis', category: 'Данные', icon: '▤', description: 'Локальный анализ CSV/TSV/JSON, пропусков и числовых сводок.' },
  { id: 'design', name: 'Product Design', category: 'Дизайн', icon: '✦', description: 'Дизайн-системы, адаптивность, accessibility и UX-паттерны.' },
  { id: 'motion', name: 'Motion Design', category: 'Motion', icon: '▶', description: 'Тайминг, easing, сцены, веб-анимация и reduced motion.' },
  { id: 'frontend', name: 'Frontend Engineer', category: 'Разработка', icon: '⌘', description: 'Архитектура UI, код, тесты и безопасные изменения.' },
  { id: 'qa', name: 'QA & Debugging', category: 'Качество', icon: '✓', description: 'Воспроизведение, диагностика и повторная проверка ошибок.' },
];

function applyTheme() {
  document.documentElement.dataset.theme = ['midnight', 'graphite', 'forest', 'light'].includes(config.theme) ? config.theme : 'midnight';
  document.documentElement.lang = ['ru', 'en', 'lv'].includes(config.uiLanguage) ? config.uiLanguage : 'ru';
  document.documentElement.dataset.reduceMotion = config.reducedMotion ? 'true' : 'false';
}

function selectSettingsTab(tab = 'general') {
  const valid = ['general', 'api', 'connectors', 'plugins', 'agents', 'memory'];
  const selected = valid.includes(tab) ? tab : 'general';
  document.querySelectorAll('.settings-tab').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === selected));
  document.querySelectorAll('.settings-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.settingsPanel === selected));
}

function renderProviderSettings() {
  const target = $('#provider-list');
  target.replaceChildren();
  for (const provider of providerCatalog) {
    const connected = Boolean(integrationStatus.providers?.[provider.id]);
    const card = document.createElement('div'); card.className = 'provider-card'; card.dataset.providerCard = provider.id;
    card.innerHTML = `<div class="provider-card-header"><div><strong>${escapeHtml(provider.name)}</strong><small>${escapeHtml(provider.defaultModel)} · совместимый API</small></div><span class="status-badge${connected ? ' connected' : ''}">${connected ? 'Ключ сохранён' : 'Не настроен'}</span></div><div class="provider-fields"><label><span>API key</span><input type="password" autocomplete="off" data-provider-key="${escapeHtml(provider.id)}" placeholder="Вставьте ключ для настройки"></label><label><span>Модель (необязательно)</span><input type="text" autocomplete="off" data-provider-model="${escapeHtml(provider.id)}" value="${escapeHtml(provider.defaultModel)}" placeholder="${escapeHtml(provider.defaultModel)}"></label></div><div class="field-help">Ключ сохраняется отдельно и шифруется Windows DPAPI. В чат он не добавляется и доступен только запросу этого провайдера.</div><div class="provider-card-actions"><button class="button-secondary" data-provider-action="test" data-provider="${escapeHtml(provider.id)}">Проверить</button>${connected ? `<button class="button-secondary" data-provider-action="remove" data-provider="${escapeHtml(provider.id)}">Удалить ключ</button>` : ''}<button class="button-primary" data-provider-action="save" data-provider="${escapeHtml(provider.id)}">Сохранить ключ</button></div>`;
    target.append(card);
  }
  const fallback = $('#fallback-provider'); fallback.replaceChildren();
  for (const provider of providerCatalog) {
    const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.name; fallback.append(option);
  }
  fallback.value = config.fallbackProvider || 'openai';
  const chatProvider = $('#chat-provider-select');
  if (chatProvider) {
    const selected = chatProvider.value;
    chatProvider.replaceChildren();
    for (const provider of providerCatalog) {
      const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.name.replace(' / ChatGPT', ''); chatProvider.append(option);
    }
    if (providerCatalog.some((provider) => provider.id === selected)) chatProvider.value = selected;
    else if (providerCatalog[0]) chatProvider.value = providerCatalog[0].id;
  }
  updateConnectorSelectionUi();
}

function renderConnectorSettings() {
  const catalog = $('#connector-catalog');
  catalog.replaceChildren();
  const customMcp = integrationStatus.mcp || [];
  const rows = (integrationStatus.catalog || []).filter((item, index, all) => all.findIndex((row) => row.id === item.id) === index);
  $('#connected-count').textContent = String([integrationStatus.github?.connected, integrationStatus.google?.connected, integrationStatus.instagram?.connected, ...customMcp.map((item) => item.enabled)].filter(Boolean).length);
  const grid = document.createElement('div'); grid.className = 'catalog-grid';
  for (const connector of rows) {
    let connected = false;
    let details = connector.kind === 'mcp' ? 'Подключается через MCP' : 'Нужно авторизовать';
    if (connector.id === 'github') { connected = integrationStatus.github?.connected; details = connected ? `@${integrationStatus.github.account || 'GitHub'}` : 'REST API'; }
    if (['google', 'gmail', 'google-drive', 'google-calendar'].includes(connector.id)) { connected = integrationStatus.google?.connected; details = connected ? integrationStatus.google.account || 'Google OAuth' : connector.kind === 'oauth' ? 'OAuth · Drive, Gmail, Calendar' : details; }
    if (connector.id === 'instagram') { connected = integrationStatus.instagram?.connected; details = connected ? `@${integrationStatus.instagram.account}` : 'Graph API · Business/Creator'; }
    if (connector.kind === 'mcp') {
      const matched = customMcp.find((server) => server.enabled && server.name.toLowerCase().includes(connector.name.toLowerCase()));
      if (matched) { connected = true; details = `${matched.toolCount} MCP tools`; }
    }
    const item = document.createElement('div'); item.className = `catalog-item${connected ? ' connected' : ''}`;
    const name = document.createElement('strong'); name.textContent = connector.name;
    const status = document.createElement('span'); status.textContent = `${connected ? 'Подключён · ' : ''}${details}`;
    item.append(name, status); grid.append(item);
  }
  catalog.append(grid);
  const strip = document.querySelector('.connector-strip');
  strip.querySelectorAll('[data-mcp-connector]').forEach((item) => item.remove());
  for (const server of customMcp.filter((item) => item.enabled)) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'connector-chip mcp-chip'; chip.dataset.mcpConnector = server.id; chip.textContent = server.name;
    chip.title = `${server.toolCount || 0} инструментов MCP · нажмите, чтобы включить в этот чат`;
    chip.addEventListener('click', () => toggleConnectorSelection(server.id));
    strip.insertBefore(chip, $('#chat-provider-select'));
  }
  const github = integrationStatus.github || {};
  const google = integrationStatus.google || {};
  const instagram = integrationStatus.instagram || {};
  $('#github-status').textContent = github.connected ? `Подключён · ${github.account || 'GitHub'}` : 'Не подключён';
  $('#google-status').textContent = google.connected ? `Подключён · ${google.email || 'Google'}` : 'Не подключён';
  $('#instagram-status').textContent = instagram.connected ? `Подключён · @${instagram.account || 'Instagram'}` : 'Не подключён';
}

function renderPluginSettings() {
  const target = $('#plugin-list'); target.replaceChildren();
  const all = [...BUILTIN_PLUGIN_CARDS, ...customPlugins];
  for (const plugin of all) {
    const enabled = (config.enabledPluginIds || []).includes(plugin.id);
    const card = document.createElement('div'); card.className = 'plugin-card';
    const icon = document.createElement('span'); icon.className = 'plugin-icon'; icon.textContent = plugin.icon || '✦';
    const copy = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = plugin.name;
    const description = document.createElement('small'); description.textContent = `${plugin.category || 'Skill'} · ${plugin.description || 'Импортированный skill-инструмент.'}`;
    copy.append(title, description);
    const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = enabled; checkbox.dataset.pluginToggle = plugin.id; label.append(checkbox, document.createTextNode('Вкл.'));
    card.append(icon, copy, label);
    if (!BUILTIN_PLUGIN_CARDS.some((item) => item.id === plugin.id)) {
      const inspect = document.createElement('button'); inspect.type = 'button'; inspect.dataset.pluginInspect = plugin.id; inspect.textContent = 'Просмотр'; card.append(inspect);
      const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.pluginRemove = plugin.id; remove.textContent = 'Удалить'; card.append(remove);
    }
    target.append(card);
  }
}

function renderAgentSettings() {
  const target = $('#agent-list'); if (!target) return;
  target.replaceChildren();
  if (!agents.length) { const note = document.createElement('div'); note.className = 'empty-history'; note.textContent = 'Установленных GitHub skills пока нет. Встроенные Frontend, QA и Data Analysis доступны в Plugins.'; target.append(note); return; }
  for (const agent of agents) {
    const card = document.createElement('div'); card.className = 'agent-card';
    const icon = document.createElement('span'); icon.className = 'agent-icon'; icon.textContent = '◎';
    const copy = document.createElement('div'); const title = document.createElement('strong'); title.textContent = agent.name; const detail = document.createElement('small'); detail.textContent = `Навыки: ${(agent.skillFiles || []).join(', ') || 'README'} · ${agent.execution || 'prompt-skill-only'}`; copy.append(title, detail);
    const toggle = document.createElement('label'); toggle.className = 'plugin-card-toggle'; const check = document.createElement('input'); check.type = 'checkbox'; check.checked = Boolean(agent.enabled); check.dataset.agentToggle = agent.id; toggle.append(check, document.createTextNode('Вкл.'));
    const link = document.createElement('a'); link.href = agent.url || '#'; link.textContent = 'GitHub'; link.dataset.externalLink = '1';
    const inspect = document.createElement('button'); inspect.type = 'button'; inspect.className = 'button-secondary compact'; inspect.dataset.agentInspect = agent.id; inspect.textContent = 'Просмотр';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button-danger compact'; remove.dataset.agentRemove = agent.id; remove.textContent = 'Удалить';
    card.append(icon, copy, toggle, link, inspect, remove); target.append(card);
  }
}

async function inspectAgentText(agentId) {
  try {
    const agent = await api.inspectAgent(agentId);
    $('#agent-inspect-title').textContent = agent.name;
    $('#agent-inspect-source').href = agent.url;
    $('#agent-inspect-source').hidden = false;
    $('#agent-inspect-files').textContent = `Источник: ${agent.url} · ветка: ${agent.defaultBranch || 'по умолчанию'} · файлы: ${(agent.skillFiles || []).join(', ')}`;
    $('#agent-inspect-content').textContent = agent.instructions || '(инструкции отсутствуют)';
    $('#agent-inspect-dialog').showModal();
  } catch (error) { showToast(error.message || 'Не удалось прочитать skill.', 'error'); }
}

function inspectPluginText(pluginId) {
  const plugin = customPlugins.find((item) => item.id === pluginId);
  if (!plugin) return;
  const source = String(plugin.source || 'локальный файл');
  const sourceLink = $('#agent-inspect-source');
  const isUrl = /^https?:\/\//i.test(source);
  sourceLink.hidden = !isUrl;
  if (isUrl) sourceLink.href = source;
  $('#agent-inspect-title').textContent = plugin.name;
  $('#agent-inspect-files').textContent = `Источник: ${source} · категория: ${plugin.category || 'Skill'}`;
  $('#agent-inspect-content').textContent = plugin.instructions || '(инструкции отсутствуют)';
  $('#agent-inspect-dialog').showModal();
}

function updateMemoryPanel() {
  $('#shared-memory-preview').textContent = sharedMemory.summary || 'Общая сводка появится после первой задачи.';
  $('#memory-count').textContent = String(memoryCount);
  $('#memory-description').textContent = `Пользовательских заметок: ${memoryCount}. Общая краткая сводка обновляется после каждого завершённого запроса.`;
}

function fillSettings() {
  config.model = 'lam-v1.0';
  $('#setting-ui-scale').value = String(config.uiScale || 1);
  $('#ui-scale-value').textContent = `${Math.round(Number(config.uiScale || 1) * 100)}%`;
  $('#setting-reduced-motion').checked = Boolean(config.reducedMotion);
  $('#self-learning-enabled').checked = config.selfLearning !== false;
  $('#model-runtime-result').textContent = modelStatus.online
    ? 'LamV1.0 работает локально.'
    : (modelStatus.error || 'Модель входит в комплект Localis.');
  $('#check-model-button').disabled = Boolean(modelStatus.checking);
  $('#image-provider').value = config.imageProvider || 'automatic1111';
  $('#image-endpoint').value = config.imageEndpoint || (config.imageProvider === 'comfyui' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:7860');
  $('#settings-workspace').textContent = config.workspaceDirectory || '';
  $('#setting-language').value = config.uiLanguage || 'ru';
  $('#setting-theme').value = config.theme || 'midnight';
  $('#approval-mode').value = config.approvalMode || 'ask';
  $('#full-access-warning').classList.toggle('visible', config.approvalMode === 'full');
  $('#cloud-fallback-enabled').checked = Boolean(config.cloudFallbackEnabled);
  updateMemoryPanel();
  renderProviderSettings(); renderConnectorSettings(); renderPluginSettings(); renderAgentSettings();
}

async function reloadLocalState() {
  const loaded = await api.getState();
  agents = loaded.agents || []; customPlugins = loaded.plugins || []; integrationStatus = loaded.integrations || {};
  providerCatalog = loaded.providers || []; memoryNotes = loaded.memoryNotes || []; sharedMemory = loaded.sharedMemory || { summary: '', entries: [] };
  projects = loaded.projects || [];
  renderProviderSettings(); renderConnectorSettings(); renderPluginSettings(); renderAgentSettings(); updateMemoryPanel(); renderProjects();
}

async function persistSettings() {
  const saved = await api.saveSettings(config);
  config = saved; applyTheme();
  $('#workspace-label').textContent = basename(config.workspaceDirectory);
  return saved;
}

function openSettings(tab = 'general') {
  fillSettings(); selectSettingsTab(tab);
  view.settingsBackdrop.hidden = false;
}

function closeSettings() { view.settingsBackdrop.hidden = true; }

function openCreateDialog(mode = 'project') {
  createMode = mode;
  $('#create-icon').textContent = mode === 'project' ? '▧' : '▱';
  $('#create-kicker').textContent = mode === 'project' ? 'НОВАЯ РАБОЧАЯ СРЕДА' : 'ПАПКА В WORKSPACE';
  $('#create-title').textContent = mode === 'project' ? 'Создать проект' : 'Создать папку';
  $('#create-goal-wrap').hidden = mode !== 'project';
  $('#create-help').textContent = mode === 'project'
    ? 'Проект создаётся отдельной папкой с README, целью, инструментами и общими подключениями.'
    : 'Новая папка будет создана внутри выбранной рабочей папки.';
  $('#create-confirm').innerHTML = mode === 'project' ? 'Создать проект <span>→</span>' : 'Создать папку <span>→</span>';
  $('#create-name').value = ''; $('#create-goal').value = '';
  view.createBackdrop.hidden = false; $('#create-name').focus();
}

async function confirmCreate() {
  const name = $('#create-name').value.trim();
  if (!name) { showToast('Введите название.', 'error'); return; }
  const button = $('#create-confirm'); button.disabled = true;
  try {
    if (createMode === 'project') {
      const project = await api.createProject({ name, goal: $('#create-goal').value.trim() });
      projects.push(project); state.activeProjectId = project.id; state.activeId = null;
      addActivity({ id: `project:${project.id}`, label: `Создан проект · ${project.name}`, details: project.path, status: 'success', kind: 'project' });
      showToast(`Проект «${project.name}» создан.`, 'success');
    } else {
      const folder = await api.createWorkspaceFolder(name);
      addActivity({ id: `folder:${folder.slug}:${Date.now()}`, label: `Создана папка · ${folder.name}`, details: folder.path, status: 'success', kind: 'project' });
      showToast(`Папка «${folder.name}» создана.`, 'success');
    }
    view.createBackdrop.hidden = true; render(); scheduleSave(); view.input.focus();
  } catch (error) { showToast(error.message || 'Не удалось создать элемент.', 'error', 5500); }
  finally { button.disabled = false; }
}

function setActivityPanelVisible(visible) {
  if (window.matchMedia('(max-width: 1090px)').matches) view.activitySidebar.classList.toggle('open', visible);
  else view.appShell.classList.toggle('activity-hidden', !visible);
}

function bindEvents() {
  $('#new-chat').addEventListener('click', () => {
    state.activeId = null; pendingConnectorIds = []; pendingProviderIds = [];
    render(); scheduleSave(); view.input.focus(); view.sidebar.classList.remove('open');
  });
  $('#create-folder').addEventListener('click', () => openCreateDialog('folder'));
  $('#create-project').addEventListener('click', () => openCreateDialog('project'));
  $('#project-create-inline').addEventListener('click', () => openCreateDialog('project'));
  $('#welcome-create-project').addEventListener('click', () => openCreateDialog('project'));
  $('#create-close').addEventListener('click', () => { view.createBackdrop.hidden = true; });
  $('#create-cancel').addEventListener('click', () => { view.createBackdrop.hidden = true; });
  $('#create-confirm').addEventListener('click', confirmCreate);
  $('#create-name').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); confirmCreate(); } });
  $('#sidebar-open').addEventListener('click', () => view.sidebar.classList.add('open'));
  $('#sidebar-close').addEventListener('click', () => view.sidebar.classList.remove('open'));
  $('#settings-open').addEventListener('click', () => openSettings('general'));
  $('#settings-open-top').addEventListener('click', () => openSettings('general'));
  $('#welcome-connectors').addEventListener('click', () => openSettings('connectors'));
  $('#composer-connectors').addEventListener('click', () => openSettings('connectors'));
  $('#composer-plugins').addEventListener('click', () => openSettings('plugins'));
  $('#composer-agents').addEventListener('click', () => openSettings('agents'));
  document.querySelectorAll('.connector-chip[data-connector]').forEach((button) => button.addEventListener('click', () => toggleConnectorSelection(button.dataset.connector)));
  $('#chat-provider-select').addEventListener('change', updateConnectorSelectionUi);
  $('#chat-provider-toggle').addEventListener('click', toggleProviderSelection);
  $('#composer-project-select').addEventListener('click', () => {
    const current = state.activeProjectId;
    const nextIndex = current ? projects.findIndex((project) => project.id === current) + 1 : 0;
    state.activeProjectId = nextIndex >= projects.length ? null : projects[nextIndex]?.id || null;
    if (activeConversation()) state.activeId = null;
    render(); scheduleSave();
    showToast(state.activeProjectId ? `Следующий диалог будет создан в проекте «${activeProject()?.name}».` : 'Выбран общий чат.', '');
  });
  $('#activity-toggle').addEventListener('click', () => {
    const visible = window.matchMedia('(max-width: 1090px)').matches ? !view.activitySidebar.classList.contains('open') : view.appShell.classList.contains('activity-hidden');
    setActivityPanelVisible(visible);
  });
  $('#activity-close').addEventListener('click', () => setActivityPanelVisible(false));
  $('#activity-clear').addEventListener('click', () => { state.activity = []; runtimeState = 'idle'; runtimeTitle = 'Агент ожидает задачу'; runtimeDescription = 'Здесь появятся шаги, вызовы инструментов и ошибки.'; renderActivity(); scheduleSave(); });

  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-cancel').addEventListener('click', closeSettings);
  document.querySelectorAll('.settings-tab').forEach((button) => button.addEventListener('click', () => selectSettingsTab(button.dataset.settingsTab)));
  document.querySelectorAll('[data-settings-tab="connectors"][data-connector]').forEach((button) => button.addEventListener('dblclick', () => openSettings('connectors')));
  $('#setting-ui-scale').addEventListener('input', (event) => { $('#ui-scale-value').textContent = `${Math.round(Number(event.target.value) * 100)}%`; });
  $('#settings-save').addEventListener('click', async () => {
    config.model = 'lam-v1.0';
    config.uiScale = Number($('#setting-ui-scale').value);
    config.reducedMotion = $('#setting-reduced-motion').checked;
    config.selfLearning = $('#self-learning-enabled').checked;
    config.imageProvider = $('#image-provider').value;
    config.imageEndpoint = $('#image-endpoint').value.trim();
    config.uiLanguage = $('#setting-language').value;
    config.theme = $('#setting-theme').value;
    config.approvalMode = $('#approval-mode').value;
    config.cloudFallbackEnabled = $('#cloud-fallback-enabled').checked;
    config.fallbackProvider = $('#fallback-provider').value;
    try {
      await persistSettings(); render(); closeSettings(); await refreshModelRuntime({ quiet: false });
      showToast('Настройки сохранены на этом компьютере.', 'success');
    } catch (error) { showToast(error.message || 'Не удалось сохранить настройки.', 'error', 6000); }
  });
  $('#approval-mode').addEventListener('change', (event) => $('#full-access-warning').classList.toggle('visible', event.target.value === 'full'));
  $('#image-provider').addEventListener('change', (event) => {
    const value = $('#image-endpoint').value;
    if (value === 'http://127.0.0.1:7860' || value === 'http://127.0.0.1:8188') $('#image-endpoint').value = event.target.value === 'comfyui' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:7860';
  });
  $('#choose-workspace').addEventListener('click', async () => {
    try { const selected = await api.chooseWorkspace(); if (selected) { config.workspaceDirectory = selected; $('#settings-workspace').textContent = selected; } }
    catch (error) { showToast(error.message, 'error'); }
  });
  $('#check-model-button').addEventListener('click', async () => {
    const button = $('#check-model-button');
    button.disabled = true;
    $('#model-runtime-result').textContent = 'Запускается встроенная модель…';
    try {
      const status = await refreshModelRuntime({ quiet: false });
      $('#model-runtime-result').textContent = status.online
        ? `${status.engine || 'LamV1.0'} работает локально.`
        : (status.error || 'Не удалось запустить LamV1.0.');
    } catch (error) {
      $('#model-runtime-result').textContent = error.message || String(error);
      showToast(error.message || 'Не удалось запустить LamV1.0.', 'error');
    } finally {
      button.disabled = Boolean(modelStatus.checking);
    }
  });
  $('#fallback-provider').addEventListener('change', () => { config.fallbackProvider = $('#fallback-provider').value; });
  view.connection.addEventListener('click', () => refreshModelRuntime({ quiet: false }));
  $('#browser-open').addEventListener('click', async () => { try { await api.openBrowser('https://duckduckgo.com'); } catch (error) { showToast(error.message || 'Не удалось открыть браузер.', 'error'); } });
  $('#open-workspace').addEventListener('click', async () => { try { await api.openWorkspace(); } catch (error) { showToast(error.message, 'error'); } });
  $('#memory-button').addEventListener('click', () => openSettings('memory'));
  $('#clear-memory').addEventListener('click', async () => {
    try {
      const cleared = await api.clearMemory();
      if (cleared) { memoryCount = 0; memoryNotes = []; sharedMemory = { summary: '', entries: [] }; updateMemoryPanel(); render(); showToast('Локальная память очищена.', 'success'); }
    } catch (error) { showToast(error.message, 'error'); }
  });
  $('#attach-button').addEventListener('click', async () => {
    try {
      const result = await api.selectAttachments(); const known = new Set(pendingAttachments.map((item) => item.id));
      pendingAttachments.push(...(result.attachments || []).filter((item) => !known.has(item.id))); drawAttachments();
      if (result.errors?.length) showToast(result.errors.join(' · '), 'error', 5000); view.input.focus();
    } catch (error) { showToast(error.message, 'error'); }
  });
  $('#send-button').addEventListener('click', sendMessage);
  view.input.addEventListener('input', resizeInput);
  view.input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
  $('#chat-search').addEventListener('input', (event) => { searchQuery = event.target.value.trim(); renderSidebar(); });
  $('#history-sort').addEventListener('click', (event) => {
    oldestFirst = !oldestFirst; event.currentTarget.textContent = oldestFirst ? '↑' : '•••'; event.currentTarget.title = oldestFirst ? 'Сначала старые' : 'Сначала новые'; renderSidebar();
  });
  document.querySelectorAll('.suggestion-card').forEach((card) => card.addEventListener('click', () => { view.input.value = card.dataset.prompt || ''; resizeInput(); view.input.focus(); }));

  $('#github-connect').addEventListener('click', async () => {
    const button = $('#github-connect'); button.disabled = true;
    try { integrationStatus = await api.connectGithub($('#github-token').value.trim()); $('#github-token').value = ''; await reloadLocalState(); addActivity({ id: `connector:github:${Date.now()}`, label: 'Подключён GitHub', details: integrationStatus.github?.account || '', status: 'success', kind: 'tool' }); showToast('GitHub подключён.', 'success'); }
    catch (error) { showToast(error.message || 'Не удалось подключить GitHub.', 'error', 6000); }
    finally { button.disabled = false; }
  });
  $('#google-connect').addEventListener('click', async () => {
    const button = $('#google-connect'); button.disabled = true; button.textContent = 'Ожидание OAuth…';
    try { integrationStatus = await api.connectGoogle($('#google-client-id').value.trim(), $('#google-client-secret').value.trim()); $('#google-client-secret').value = ''; await reloadLocalState(); showToast(`Google подключён${integrationStatus.google?.account ? ` · ${integrationStatus.google.account}` : ''}.`, 'success', 5000); }
    catch (error) { showToast(error.message || 'Не удалось подключить Google.', 'error', 6500); }
    finally { button.disabled = false; button.textContent = 'Открыть вход Google'; }
  });
  $('#instagram-connect').addEventListener('click', async () => {
    const button = $('#instagram-connect'); button.disabled = true;
    try { integrationStatus = await api.connectInstagram($('#instagram-token').value.trim(), $('#instagram-user-id').value.trim()); $('#instagram-token').value = ''; await reloadLocalState(); showToast('Instagram Graph API подключён.', 'success'); }
    catch (error) { showToast(error.message || 'Не удалось подключить Instagram.', 'error', 6000); }
    finally { button.disabled = false; }
  });
  document.querySelectorAll('[data-disconnect]').forEach((button) => button.addEventListener('click', async () => {
    try { integrationStatus = await api.disconnectConnector(button.dataset.disconnect); await reloadLocalState(); showToast('Подключение удалено.', 'success'); }
    catch (error) { showToast(error.message, 'error'); }
  }));
  $('#mcp-connect').addEventListener('click', async () => {
    const button = $('#mcp-connect'); button.disabled = true;
    try {
      const result = await api.connectMcp($('#mcp-name').value.trim(), $('#mcp-url').value.trim(), $('#mcp-token').value.trim());
      $('#mcp-token').value = ''; integrationStatus = result.integrations; await reloadLocalState();
      showToast(`MCP подключён · ${result.server.toolCount} tools.`, 'success');
    } catch (error) { showToast(error.message || 'Не удалось подключить MCP.', 'error', 6000); }
    finally { button.disabled = false; }
  });

  $('#provider-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-provider-action]'); if (!button) return;
    const provider = button.dataset.provider; const action = button.dataset.providerAction; const card = button.closest('.provider-card');
    const key = card.querySelector(`[data-provider-key="${CSS.escape(provider)}"]`).value.trim();
    const model = card.querySelector(`[data-provider-model="${CSS.escape(provider)}"]`).value.trim();
    button.disabled = true;
    try {
      if (action === 'test') {
        const result = await api.testApiKey(provider, key); showToast(`${providerCatalog.find((item) => item.id === provider)?.name}: соединение работает · ${result.model}`, 'success', 5000);
      } else if (action === 'save') {
        const tested = await api.testApiKey(provider, key);
        integrationStatus = await api.saveApiKey(provider, key, model);
        await reloadLocalState(); showToast(`Ключ сохранён и проверен · ${tested.model}`, 'success');
      } else if (action === 'remove') {
        integrationStatus = await api.removeApiKey(provider); await reloadLocalState(); showToast('API-ключ удалён из зашифрованного хранилища.', 'success');
      }
    } catch (error) { showToast(error.message || 'Ошибка AI-провайдера.', 'error', 6500); }
    finally { button.disabled = false; }
  });

  $('#plugin-import').addEventListener('click', async () => {
    try { const plugin = await api.importPlugin(); if (plugin) { await reloadLocalState(); showToast(`Skill «${plugin.name}» импортирован.`, 'success'); } }
    catch (error) { showToast(error.message || 'Не удалось импортировать skill.', 'error'); }
  });
  $('#plugin-install-url').addEventListener('click', async () => {
    const url = $('#plugin-url').value.trim();
    if (!url) { showToast('Введите прямую ссылку на .md, .txt или .json skill-файл.', 'error'); return; }
    try {
      const plugin = await api.installPluginFromUrl(url);
      if (plugin) { $('#plugin-url').value = ''; await reloadLocalState(); showToast(`Skill «${plugin.name}» импортирован из интернета.`, 'success'); }
    } catch (error) { showToast(error.message || 'Не удалось загрузить plugin.', 'error', 6000); }
  });
  $('#plugin-search').addEventListener('click', async () => {
    const query = $('#plugin-search-query').value.trim(); if (!query) { showToast('Введите поисковый запрос.', 'error'); return; }
    const results = $('#plugin-search-results'); results.textContent = 'Ищу в интернете…';
    try {
      const data = await api.searchPlugins(query); results.replaceChildren();
      for (const item of data.results || []) {
        const card = document.createElement('div'); card.className = 'plugin-search-result';
        const link = document.createElement('a'); link.href = item.url; link.dataset.externalLink = '1'; link.textContent = item.title || item.url;
        const description = document.createElement('p'); description.textContent = item.snippet || '';
        card.append(link, description); results.append(card);
      }
      if (!(data.results || []).length) results.textContent = 'Совпадений нет.';
    } catch (error) { results.textContent = error.message || 'Поиск не выполнен.'; }
  });
  $('#plugin-list').addEventListener('change', async (event) => {
    const checkbox = event.target.closest('[data-plugin-toggle]'); if (!checkbox) return;
    try { config.enabledPluginIds = await api.togglePlugin(checkbox.dataset.pluginToggle, checkbox.checked); scheduleSave(); }
    catch (error) { showToast(error.message, 'error'); checkbox.checked = !checkbox.checked; }
  });
  $('#plugin-list').addEventListener('click', async (event) => {
    const inspect = event.target.closest('[data-plugin-inspect]');
    if (inspect) { inspectPluginText(inspect.dataset.pluginInspect); return; }
    const button = event.target.closest('[data-plugin-remove]'); if (!button) return;
    try { await api.removePlugin(button.dataset.pluginRemove); await reloadLocalState(); showToast('Plugin удалён.', 'success'); }
    catch (error) { showToast(error.message, 'error'); }
  });
  $('#agent-install-button').addEventListener('click', async () => {
    const url = $('#agent-install-url').value.trim();
    if (!url) { showToast('Введите публичную ссылку GitHub repository.', 'error'); return; }
    try { const result = await api.installGithubAgent(url); $('#agent-install-url').value = ''; await reloadLocalState(); showToast(`Агент ${result.agent.name} установлен.`, 'success'); }
    catch (error) { showToast(error.message || 'Не удалось установить агента.', 'error', 6000); }
  });
  $('#agent-list').addEventListener('change', async (event) => {
    const checkbox = event.target.closest('[data-agent-toggle]'); if (!checkbox) return;
    try { agents = await api.toggleAgent(checkbox.dataset.agentToggle, checkbox.checked); renderAgentSettings(); }
    catch (error) { showToast(error.message, 'error'); checkbox.checked = !checkbox.checked; }
  });
  $('#agent-list').addEventListener('click', async (event) => {
    const inspect = event.target.closest('[data-agent-inspect]');
    if (inspect) { await inspectAgentText(inspect.dataset.agentInspect); return; }
    const remove = event.target.closest('[data-agent-remove]');
    if (!remove) return;
    const agent = agents.find((item) => item.id === remove.dataset.agentRemove);
    if (!agent || !window.confirm(`Удалить локальные инструкции агента «${agent.name}»? Исходный GitHub-репозиторий не затрагивается.`)) return;
    try { agents = await api.removeAgent(agent.id); renderAgentSettings(); showToast('Локальные инструкции удалены.', 'success'); }
    catch (error) { showToast(error.message || 'Не удалось удалить агента.', 'error'); }
  });
  const inspector = $('#agent-inspect-dialog');
  $('#agent-inspect-close').addEventListener('click', () => inspector.close());
  $('#agent-inspect-done').addEventListener('click', () => inspector.close());
  inspector.addEventListener('click', (event) => { if (event.target === inspector) inspector.close(); });

  $('#approval-accept').addEventListener('click', () => answerApproval(true));
  $('#approval-deny').addEventListener('click', () => answerApproval(false));
  $('#approval-close').addEventListener('click', () => answerApproval(false));
  view.approvalBackdrop.addEventListener('click', (event) => { if (event.target === view.approvalBackdrop) answerApproval(false); });
  view.settingsBackdrop.addEventListener('click', (event) => { if (event.target === view.settingsBackdrop) closeSettings(); });
  view.createBackdrop.addEventListener('click', (event) => { if (event.target === view.createBackdrop) view.createBackdrop.hidden = true; });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#new-chat').click(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); sendMessage(); }
    if (event.key === 'Escape') {
      if (activeApproval) answerApproval(false);
      else if (!view.settingsBackdrop.hidden) closeSettings();
      else if (!view.createBackdrop.hidden) view.createBackdrop.hidden = true;
      else { view.sidebar.classList.remove('open'); setActivityPanelVisible(false); }
    }
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-external-link]');
    if (!link) return;
    event.preventDefault(); api.openBrowser(link.getAttribute('href')).catch((error) => showToast(error.message, 'error'));
  });
  api.onAgentEvent(handleAgentEvent);
  api.onApproval((approval) => { approvals.push(approval); if (!activeApproval) renderApproval(); });
  api.onModelStatus(setModelStatus);
}

async function bootstrap() {
  bindEvents();
  try {
    const loaded = await api.getState();
    config = loaded.config || {};
    integrationStatus = loaded.integrations || {};
    providerCatalog = loaded.providers || [];
    memoryNotes = loaded.memoryNotes || [];
    memoryCount = memoryNotes.length;
    sharedMemory = loaded.sharedMemory || { summary: '', entries: [] };
    projects = loaded.projects || [];
    agents = loaded.agents || [];
    customPlugins = loaded.plugins || [];
    state = loaded.appState && Array.isArray(loaded.appState.conversations)
      ? loaded.appState : { conversations: [], activeId: null, activeProjectId: null, activity: [] };
    state.projects = projects;
    state.activity = Array.isArray(state.activity) ? state.activity.slice(-120) : [];
    state.activeProjectId = projects.some((project) => project.id === state.activeProjectId) ? state.activeProjectId : null;
    state.conversations = state.conversations.filter((conversation) => conversation && typeof conversation.id === 'string' && Array.isArray(conversation.messages)).slice(0, 100);
    for (const conversation of state.conversations) {
      conversation.connectorIds = Array.isArray(conversation.connectorIds) ? conversation.connectorIds : [];
      conversation.providerIds = Array.isArray(conversation.providerIds) ? conversation.providerIds : [];
      if (conversation.projectId && !projects.some((project) => project.id === conversation.projectId)) conversation.projectId = null;
      conversation.messages = conversation.messages.filter((message) => message && ['user', 'assistant'].includes(message.role)).slice(-200);
      for (const message of conversation.messages) {
        message.actions = Array.isArray(message.actions) ? message.actions : [];
        message.streaming = false;
      }
    }
    if (!state.conversations.some((item) => item.id === state.activeId)) state.activeId = state.conversations[0]?.id || null;
    memoryCount = Number(loaded.memoryCount) || 0;
    initialized = true;
    fillSettings();
    render();
    await refreshModelRuntime({ quiet: true });
  } catch (error) {
    showToast(`Не удалось загрузить состояние приложения: ${error.message}`, 'error', 7000);
  }
}

bootstrap();
