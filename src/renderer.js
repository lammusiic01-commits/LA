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
};

let state = { conversations: [], activeId: null };
let config = {};
let memoryCount = 0;
let ollamaStatus = { online: false, models: [] };
let pendingAttachments = [];
let activeRunId = null;
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
  const conversation = { id: uuid(), title: 'Новый диалог', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  scheduleSave();
  return conversation;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.saveState({ conversations: state.conversations.slice(0, 100), activeId: state.activeId })
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

function actionIcon(name) {
  const icons = { web_search: '⌕', read_webpage: '↗', open_browser: '◎', list_workspace_files: '▧', read_workspace_file: '▤', write_workspace_file: '✎', create_document: '▤', generate_image: '✦', make_video: '▶', run_command: '⌘', remember: '✧' };
  return icons[name] || '•';
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
  view.title.textContent = conversation?.title || 'Новый диалог';
  if (conversation) {
    for (const message of conversation.messages) view.messageList.append(renderMessage(message));
  }
  if (scroll) requestAnimationFrame(() => { view.stage.scrollTop = view.stage.scrollHeight; });
}

function render() {
  renderSidebar();
  renderThread();
  $('#memory-count').textContent = String(memoryCount);
  $('#workspace-label').textContent = basename(config.workspaceDirectory || 'Localis Workspace');
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

function setOllamaStatus(status) {
  ollamaStatus = status || { online: false, models: [] };
  view.connection.classList.toggle('online', Boolean(ollamaStatus.online));
  view.connection.classList.toggle('offline', !ollamaStatus.online && !ollamaStatus.checking);
  if (ollamaStatus.online) view.connectionLabel.textContent = `Ollama · ${ollamaStatus.models.length} ${ollamaStatus.models.length === 1 ? 'модель' : 'моделей'}`;
  else view.connectionLabel.textContent = ollamaStatus.checking ? 'Подключение…' : 'Ollama не найдена';
  view.connection.title = ollamaStatus.online ? `Подключено: ${ollamaStatus.baseUrl}` : `${ollamaStatus.error || 'Запустите Ollama и проверьте адрес в настройках.'}`;

  const selected = config.model || '';
  view.modelSelect.replaceChildren();
  if (ollamaStatus.online && ollamaStatus.models.length) {
    for (const model of ollamaStatus.models) {
      const option = document.createElement('option');
      option.value = model.name;
      const detail = [model.parameterSize, model.quantization].filter(Boolean).join(' · ');
      option.textContent = detail ? `${model.name}  ·  ${detail}` : model.name;
      view.modelSelect.append(option);
    }
    const exists = ollamaStatus.models.some((model) => model.name === selected);
    const modelName = exists ? selected : ollamaStatus.models[0].name;
    view.modelSelect.value = modelName;
    view.modelSelect.disabled = false;
    if (modelName !== selected) {
      config.model = modelName;
      if (initialized) persistSettings().catch(() => {});
    }
  } else {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = ollamaStatus.online ? 'Сначала загрузите модель' : 'Модель не найдена';
    view.modelSelect.append(option);
    view.modelSelect.disabled = true;
  }
}

async function refreshOllama({ quiet = true } = {}) {
  view.connectionLabel.textContent = 'Подключение…';
  view.connection.classList.remove('offline', 'online');
  try {
    const status = await api.checkOllama();
    setOllamaStatus(status);
    if (!status.online && !quiet) showToast(`${status.error || 'Не удалось подключиться к Ollama.'} Запустите Ollama и нажмите «Проверить».`, 'error', 5200);
    if (status.online && !status.models.length && !quiet) showToast('Ollama работает, но моделей не найдено. Загрузите модель через команду ollama pull.', 'error', 5200);
    return status;
  } catch (error) {
    setOllamaStatus({ online: false, models: [], error: error.message });
    if (!quiet) showToast(error.message, 'error');
    return { online: false, models: [] };
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
  if (event.type === 'assistant-chunk') {
    if (!context) return;
    context.assistant.content += event.text || '';
    const conversation = state.conversations.find((item) => item.id === context.conversationId);
    if (conversation?.id === state.activeId) {
      const existing = document.querySelector(`[data-message-id="${CSS.escape(context.assistant.id)}"]`);
      const updated = renderMessage(context.assistant);
      if (existing) existing.replaceWith(updated); else view.messageList.append(updated);
      view.stage.scrollTop = view.stage.scrollHeight;
    }
    scheduleSave();
    return;
  }
  if (event.type === 'tool-start') { setActivity(context, event, 'approval'); return; }
  if (event.type === 'tool-running') { setActivity(context, event, 'running'); return; }
  if (event.type === 'tool-complete') {
    const status = event.approved === false ? 'denied' : event.ok ? 'success' : 'error';
    setActivity(context, event, status);
    return;
  }
  if (event.type === 'turn-complete') {
    if (context) context.assistant.content = event.text || context.assistant.content;
    finishRun(event.runId);
    return;
  }
  if (event.type === 'error') {
    if (context) context.assistant.error = event.message || 'Не удалось завершить запрос.';
    finishRun(event.runId);
    showToast(event.message || 'Ошибка агента.', 'error', 6000);
    return;
  }
  if (event.type === 'cancelled') {
    if (context) context.assistant.error = 'Выполнение остановлено пользователем.';
    finishRun(event.runId);
    showToast('Запрос остановлен.', '');
    return;
  }
  if (event.type === 'memory-updated') {
    memoryCount = event.count || memoryCount + 1;
    $('#memory-count').textContent = String(memoryCount);
    $('#memory-description').textContent = `Сохранено заметок: ${memoryCount}. Это локальная память-контекст, не дообучение модели.`;
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
  if (!ollamaStatus.online || !ollamaStatus.models.length) {
    showToast('Сначала запустите Ollama с установленной моделью. Нажмите на статус вверху, чтобы проверить подключение.', 'error', 5200);
    return;
  }
  const model = view.modelSelect.value || config.model;
  if (!model) { showToast('Выберите установленную модель Ollama.', 'error'); return; }
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
    await api.sendTurn({ runId, model, history, text, attachmentIds });
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
  const isHighRisk = activeApproval.risk === 'high';
  const isNetwork = ['web_search', 'read_webpage', 'open_browser'].includes(activeApproval.name);
  const isWrite = ['write_workspace_file', 'create_document', 'generate_image', 'make_video', 'remember'].includes(activeApproval.name);
  $('#approval-icon').textContent = isHighRisk ? '!' : isNetwork ? '↗' : isWrite ? '✎' : '◈';
  $('#approval-kind').textContent = isHighRisk ? 'КОМАНДА · ПРОВЕРЬТЕ ПЕРЕД ЗАПУСКОМ' : isNetwork ? 'ДОСТУП К ИНТЕРНЕТУ' : isWrite ? 'ЗАПИСЬ ИЛИ СОЗДАНИЕ ДАННЫХ' : 'ДОСТУП К ФАЙЛАМ';
  $('#approval-title').textContent = isHighRisk ? 'Разрешить запуск команды?' : 'Разрешить это действие?';
  $('#approval-summary').textContent = activeApproval.summary || activeApproval.name;
  $('#approval-detail').textContent = activeApproval.arguments || '{}';
  const warning = $('#approval-warning');
  warning.hidden = !isHighRisk && !isNetwork;
  warning.querySelector('p').textContent = isHighRisk
    ? 'Команда выполняется в рабочей папке с правами вашей учётной записи Windows. Приложение не создаёт системную песочницу. Не разрешайте неизвестные или разрушительные команды.'
    : 'Запрос отправит поисковый текст или URL в интернет. Содержимое сайтов будет считаться недоверенными данными.';
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

function fillSettings() {
  $('#ollama-url').value = config.ollamaBaseUrl || 'http://127.0.0.1:11434';
  $('#image-provider').value = config.imageProvider || 'automatic1111';
  $('#image-endpoint').value = config.imageEndpoint || (config.imageProvider === 'comfyui' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:7860');
  $('#settings-workspace').textContent = config.workspaceDirectory || '';
  $('#memory-description').textContent = `Сохранено заметок: ${memoryCount}. Это локальная память-контекст, не дообучение модели.`;
  $('#ollama-result').textContent = 'Совместим с локальным Ollama API. Если указать удалённый сервер, переписка будет отправляться туда.';
}

async function persistSettings() {
  const saved = await api.saveSettings(config);
  config = saved;
  $('#workspace-label').textContent = basename(config.workspaceDirectory);
  return saved;
}

function openSettings() {
  fillSettings();
  view.settingsBackdrop.hidden = false;
}

function closeSettings() { view.settingsBackdrop.hidden = true; }

function bindEvents() {
  $('#new-chat').addEventListener('click', () => {
    state.activeId = null;
    render();
    scheduleSave();
    view.input.focus();
    view.sidebar.classList.remove('open');
  });
  $('#sidebar-open').addEventListener('click', () => view.sidebar.classList.add('open'));
  $('#sidebar-close').addEventListener('click', () => view.sidebar.classList.remove('open'));
  $('#settings-open').addEventListener('click', openSettings);
  $('#settings-open-top').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-cancel').addEventListener('click', closeSettings);
  $('#settings-save').addEventListener('click', async () => {
    config.ollamaBaseUrl = $('#ollama-url').value.trim();
    config.imageProvider = $('#image-provider').value;
    config.imageEndpoint = $('#image-endpoint').value.trim();
    try {
      await persistSettings();
      closeSettings();
      await refreshOllama({ quiet: false });
      showToast('Настройки сохранены на этом компьютере.', 'success');
    } catch (error) {
      showToast(error.message || 'Не удалось сохранить настройки.', 'error');
    }
  });
  $('#image-provider').addEventListener('change', (event) => {
    const value = $('#image-endpoint').value;
    if (value === 'http://127.0.0.1:7860' || value === 'http://127.0.0.1:8188') {
      $('#image-endpoint').value = event.target.value === 'comfyui' ? 'http://127.0.0.1:8188' : 'http://127.0.0.1:7860';
    }
  });
  $('#choose-workspace').addEventListener('click', async () => {
    try {
      const selected = await api.chooseWorkspace();
      if (selected) { config.workspaceDirectory = selected; $('#settings-workspace').textContent = selected; }
    } catch (error) { showToast(error.message, 'error'); }
  });
  $('#test-ollama').addEventListener('click', async () => {
    config.ollamaBaseUrl = $('#ollama-url').value.trim();
    try {
      await api.saveSettings(config);
      const status = await refreshOllama({ quiet: false });
      $('#ollama-result').textContent = status.online
        ? `Подключено · установлено моделей: ${status.models.length}${status.version ? ` · Ollama ${status.version}` : ''}`
        : `${status.error || 'Нет соединения'}. Проверьте, что Ollama запущена.`;
    } catch (error) { $('#ollama-result').textContent = error.message; showToast(error.message, 'error'); }
  });
  $('#model-select').addEventListener('change', async () => {
    config.model = view.modelSelect.value;
    try { await persistSettings(); } catch (error) { showToast(error.message, 'error'); }
  });
  view.connection.addEventListener('click', () => refreshOllama({ quiet: false }));
  $('#browser-open').addEventListener('click', async () => {
    try { await api.openBrowser('https://duckduckgo.com'); }
    catch (error) { showToast(error.message || 'Не удалось открыть браузер.', 'error'); }
  });
  $('#open-workspace').addEventListener('click', async () => {
    try { await api.openWorkspace(); } catch (error) { showToast(error.message, 'error'); }
  });
  $('#memory-button').addEventListener('click', () => openSettings());
  $('#clear-memory').addEventListener('click', async () => {
    try {
      const cleared = await api.clearMemory();
      if (cleared) { memoryCount = 0; fillSettings(); render(); showToast('Локальная память очищена.', 'success'); }
    } catch (error) { showToast(error.message, 'error'); }
  });
  $('#attach-button').addEventListener('click', async () => {
    try {
      const result = await api.selectAttachments();
      const known = new Set(pendingAttachments.map((item) => item.id));
      pendingAttachments.push(...(result.attachments || []).filter((item) => !known.has(item.id)));
      drawAttachments();
      if (result.errors?.length) showToast(result.errors.join(' · '), 'error', 5000);
      view.input.focus();
    } catch (error) { showToast(error.message, 'error'); }
  });
  $('#send-button').addEventListener('click', sendMessage);
  view.input.addEventListener('input', resizeInput);
  view.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
  });
  $('#chat-search').addEventListener('input', (event) => { searchQuery = event.target.value.trim(); renderSidebar(); });
  $('#history-sort').addEventListener('click', (event) => {
    oldestFirst = !oldestFirst;
    event.currentTarget.textContent = oldestFirst ? '↑' : '•••';
    event.currentTarget.title = oldestFirst ? 'Сначала старые' : 'Сначала новые';
    renderSidebar();
  });
  document.querySelectorAll('.suggestion-card').forEach((card) => card.addEventListener('click', () => {
    view.input.value = card.dataset.prompt || '';
    resizeInput();
    view.input.focus();
  }));
  $('#approval-accept').addEventListener('click', () => answerApproval(true));
  $('#approval-deny').addEventListener('click', () => answerApproval(false));
  $('#approval-close').addEventListener('click', () => answerApproval(false));
  view.approvalBackdrop.addEventListener('click', (event) => { if (event.target === view.approvalBackdrop) answerApproval(false); });
  view.settingsBackdrop.addEventListener('click', (event) => { if (event.target === view.settingsBackdrop) closeSettings(); });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#new-chat').click(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); sendMessage(); }
    if (event.key === 'Escape') {
      if (activeApproval) answerApproval(false);
      else if (!view.settingsBackdrop.hidden) closeSettings();
      else view.sidebar.classList.remove('open');
    }
  });
  view.messageList.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-external-link]');
    if (!link) return;
    event.preventDefault();
    api.openBrowser(link.getAttribute('href')).catch((error) => showToast(error.message, 'error'));
  });
  api.onAgentEvent(handleAgentEvent);
  api.onApproval((approval) => { approvals.push(approval); if (!activeApproval) renderApproval(); });
  api.onOllamaStatus(setOllamaStatus);
}

async function bootstrap() {
  bindEvents();
  try {
    const loaded = await api.getState();
    config = loaded.config || {};
    state = loaded.appState && Array.isArray(loaded.appState.conversations)
      ? loaded.appState : { conversations: [], activeId: null };
    state.conversations = state.conversations.filter((conversation) => conversation && typeof conversation.id === 'string' && Array.isArray(conversation.messages)).slice(0, 100);
    for (const conversation of state.conversations) {
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
    const status = await refreshOllama({ quiet: true });
    if (status.online && !status.models.length) showToast('Ollama запущена, но не видит загруженных моделей. В терминале выполните ollama list.', '');
  } catch (error) {
    showToast(`Не удалось загрузить состояние приложения: ${error.message}`, 'error', 7000);
  }
}

bootstrap();
