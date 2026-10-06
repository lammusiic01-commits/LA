'use strict';

const { assertPublicHttpUrl } = require('./security');

const GRAPH_API_VERSION = 'v26.0';
const CONNECTOR_CATALOG = Object.freeze([
  { id: 'github', name: 'GitHub', kind: 'direct', category: 'Разработка', description: 'Репозитории, файлы, поиск и issues через GitHub REST API.' },
  { id: 'google', name: 'Google Workspace', kind: 'oauth', category: 'Офис', description: 'Drive, Gmail и Calendar через Google OAuth.' },
  { id: 'instagram', name: 'Instagram', kind: 'direct', category: 'Соцсети', description: 'Профиль, публикации, статистика и публикация через Instagram Graph API.' },
  { id: 'telegram', name: 'Telegram bot', kind: 'direct', category: 'Сообщения', description: 'Отправка сообщений через ваш Telegram bot token и сохранённый chat ID.' },
  { id: 'notion', name: 'Notion', kind: 'mcp', category: 'Рабочее пространство', description: 'Подключение официального или community MCP-сервера.' },
  { id: 'slack', name: 'Slack', kind: 'mcp', category: 'Коммуникации', description: 'Подключение MCP-сервера Slack с выданными вами правами.' },
  { id: 'google-calendar', name: 'Google Calendar', kind: 'oauth', category: 'Офис', description: 'Календарь Google в общем OAuth-подключении Google Workspace.' },
  { id: 'google-drive', name: 'Google Drive', kind: 'oauth', category: 'Офис', description: 'Drive в общем OAuth-подключении Google Workspace.' },
  { id: 'gmail', name: 'Gmail', kind: 'oauth', category: 'Офис', description: 'Gmail в общем OAuth-подключении Google Workspace.' },
  { id: 'stripe', name: 'Stripe', kind: 'mcp', category: 'Платежи', description: 'Подключение MCP-сервера Stripe; ключ задаётся на стороне сервера.' },
  { id: 'hubspot', name: 'HubSpot', kind: 'mcp', category: 'CRM', description: 'Подключение MCP-сервера HubSpot.' },
  { id: 'huggingface', name: 'Hugging Face', kind: 'mcp', category: 'AI и модели', description: 'Подключение Hugging Face MCP или собственных API tools.' },
  { id: 'zapier', name: 'Zapier', kind: 'mcp', category: 'Автоматизация', description: 'Подключение Zapier MCP для рабочих процессов в тысячах сервисов.' },
  { id: 'custom-mcp', name: 'Свой MCP-сервер', kind: 'mcp', category: 'Другое', description: 'Любой совместимый MCP Streamable HTTP сервер.' },
]);

const CONNECTOR_TOOL_DEFINITIONS = Object.freeze([
  tool('github_list_repositories', 'Список доступных пользователю репозиториев GitHub.', { type: 'object', properties: { visibility: { type: 'string', enum: ['all', 'public', 'private'] } } }),
  tool('github_search_repositories', 'Поиск публичных или доступных пользователю репозиториев GitHub.', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
  tool('github_read_file', 'Чтение файла из репозитория GitHub.', { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } }, required: ['owner', 'repo', 'path'] }),
  tool('github_create_issue', 'Создание issue в репозитории GitHub. Изменение внешнего сервиса.', { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] }),
  tool('github_commit_file', 'Создание или обновление текстового файла в репозитории GitHub. Изменение внешнего сервиса.', { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' }, content: { type: 'string' }, branch: { type: 'string' } }, required: ['owner', 'repo', 'path', 'message', 'content'] }),
  tool('google_drive_search', 'Поиск файлов в Google Drive, подключённом пользователем.', { type: 'object', properties: { query: { type: 'string' } } }),
  tool('google_drive_read', 'Чтение доступного текстового Google Docs или файла из Drive.', { type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'] }),
  tool('google_docs_create', 'Создание Google Docs документа в Google Drive. Изменение внешнего сервиса.', { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] }),
  tool('gmail_search', 'Поиск писем в Gmail. Возвращает только ограниченные заголовки и выдержки.', { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] }),
  tool('gmail_create_draft', 'Создание черновика письма в Gmail без его отправки.', { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] }),
  tool('google_calendar_list', 'Просмотр предстоящих событий основного Google Calendar.', { type: 'object', properties: { days: { type: 'integer' } } }),
  tool('google_calendar_create_event', 'Создание события в Google Calendar. Изменение внешнего сервиса.', { type: 'object', properties: { summary: { type: 'string' }, description: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, time_zone: { type: 'string' } }, required: ['summary', 'start', 'end'] }),
  tool('instagram_get_profile', 'Получение публичных сведений подключённого Instagram Business/Creator профиля.', { type: 'object', properties: {} }),
  tool('instagram_list_media', 'Список последних публикаций подключённого Instagram Business/Creator аккаунта.', { type: 'object', properties: { limit: { type: 'integer' } } }),
  tool('instagram_get_insights', 'Получение доступной статистики подключённого Instagram Business/Creator аккаунта.', { type: 'object', properties: { period: { type: 'string', enum: ['day', 'week', 'days_28'] } } }),
  tool('instagram_publish_image', 'Публикация фотографии из публичного HTTPS URL в Instagram. Изменение внешнего сервиса.', { type: 'object', properties: { image_url: { type: 'string' }, caption: { type: 'string' } }, required: ['image_url', 'caption'] }),
  tool('telegram_send_message', 'Отправить текст в Telegram-чат, указанный пользователем в настройках. Внешнее сообщение; всегда требует разрешения в текущем режиме доступа.', { type: 'object', properties: { text: { type: 'string', description: 'Текст сообщения, максимум 4096 символов.' } }, required: ['text'] }),
]);

function tool(name, description, parameters) { return { type: 'function', function: { name, description, parameters } }; }
function clean(value, field, max = 4000) {
  const result = String(value || '').trim();
  if (!result || result.length > max) throw new Error(`Параметр «${field}» пустой или превышает лимит ${max} символов.`);
  return result;
}
function repoPart(value, field) {
  const cleanValue = clean(value, field, 100);
  if (!/^[A-Za-z0-9_.-]+$/.test(cleanValue) || cleanValue === '.' || cleanValue === '..') throw new Error(`Некорректное значение ${field}.`);
  return cleanValue;
}

async function readResponse(response, label) {
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw.slice(0, 1000) }; }
  if (!response.ok) {
    const message = data.message || data.error?.message || response.statusText;
    throw new Error(`${label} вернул HTTP ${response.status}: ${String(message).slice(0, 1000)}`);
  }
  return data;
}

async function githubRequest(token, pathname, options = {}) {
  const url = new URL(pathname.replace(/^\/+/, ''), 'https://api.github.com/');
  const response = await fetch(url, {
    method: options.method || 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'Localis-Desktop',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  return readResponse(response, 'GitHub API');
}

async function testGithub(token) {
  const data = await githubRequest(clean(token, 'GitHub token', 5000), '/user');
  return { connected: true, account: data.login, name: data.name || data.login };
}

async function getGoogleAccessToken(vault) {
  const google = await vault.get(['connectors', 'google'], {});
  if (!google?.refreshToken && !google?.accessToken) throw new Error('Сначала подключите Google Workspace в настройках → Коннекторы.');
  if (google.accessToken && Number(google.expiresAt || 0) > Date.now() + 60_000) return google.accessToken;
  if (!google.refreshToken || !google.clientId) throw new Error('Срок токена Google истёк. Переподключите Google Workspace.');
  const form = new URLSearchParams({ client_id: google.clientId, refresh_token: google.refreshToken, grant_type: 'refresh_token' });
  if (google.clientSecret) form.set('client_secret', google.clientSecret);
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const token = await readResponse(response, 'Google OAuth');
  const updated = { ...google, accessToken: token.access_token, expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000 };
  await vault.set(['connectors', 'google'], updated);
  return updated.accessToken;
}

async function googleRequest(accessToken, endpoint, options = {}) {
  const response = await fetch(endpoint, {
    method: options.method || 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${accessToken}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  return readResponse(response, 'Google API');
}

function encodeBase64Url(value) { return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

async function executeGithubTool(name, args, token, signal) {
  if (!token) throw new Error('GitHub не подключён. Добавьте fine-grained PAT в настройках → Коннекторы.');
  if (name === 'github_list_repositories') {
    const visibility = ['public', 'private'].includes(args.visibility) ? args.visibility : 'all';
    const repos = await githubRequest(token, `/user/repos?per_page=50&sort=updated&visibility=${visibility}`, { signal });
    return { repositories: (Array.isArray(repos) ? repos : []).map((repo) => ({ name: repo.full_name, description: repo.description, url: repo.html_url, private: repo.private, defaultBranch: repo.default_branch, updatedAt: repo.updated_at })) };
  }
  if (name === 'github_search_repositories') {
    const query = encodeURIComponent(clean(args.query, 'query', 300));
    const data = await githubRequest(token, `/search/repositories?q=${query}&per_page=20&sort=updated`, { signal });
    return { total: data.total_count, repositories: (data.items || []).map((repo) => ({ name: repo.full_name, description: repo.description, url: repo.html_url, stars: repo.stargazers_count, language: repo.language })) };
  }
  const owner = repoPart(args.owner, 'owner');
  const repo = repoPart(args.repo, 'repo');
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  if (name === 'github_read_file') {
    const filePath = clean(args.path, 'path', 800).split('/').map(encodeURIComponent).join('/');
    const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref).slice(0, 200))}` : '';
    const data = await githubRequest(token, `${base}/contents/${filePath}${ref}`, { signal });
    if (Array.isArray(data)) return { files: data.map((item) => ({ name: item.name, path: item.path, type: item.type, url: item.html_url })) };
    if (data.encoding !== 'base64' || typeof data.content !== 'string') return { path: data.path, downloadUrl: data.download_url, note: 'Файл не возвращён как base64-текст.' };
    return { path: data.path, text: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8').slice(0, 30_000), url: data.html_url };
  }
  if (name === 'github_create_issue') {
    const body = { title: clean(args.title, 'title', 200), body: String(args.body || '').slice(0, 20_000) };
    if (Array.isArray(args.labels)) body.labels = args.labels.slice(0, 10).map((label) => String(label).slice(0, 50));
    const issue = await githubRequest(token, `${base}/issues`, { method: 'POST', body, signal });
    return { number: issue.number, title: issue.title, url: issue.html_url, state: issue.state };
  }
  if (name === 'github_commit_file') {
    const filePath = clean(args.path, 'path', 800);
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const branch = String(args.branch || '').trim();
    let sha;
    try {
      const existing = await githubRequest(token, `${base}/contents/${encodedPath}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`, { signal });
      sha = existing.sha;
    } catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
    const body = { message: clean(args.message, 'message', 200), content: Buffer.from(clean(args.content, 'content', 900_000), 'utf8').toString('base64') };
    if (sha) body.sha = sha;
    if (branch) body.branch = branch;
    const saved = await githubRequest(token, `${base}/contents/${encodedPath}`, { method: 'PUT', body, signal });
    return { path: saved.content?.path || filePath, commit: saved.commit?.sha, url: saved.content?.html_url };
  }
  throw new Error(`Неизвестный GitHub-инструмент «${name}».`);
}

async function executeGoogleTool(name, args, vault, signal) {
  const accessToken = await getGoogleAccessToken(vault);
  if (name === 'google_drive_search') {
    const q = String(args.query || '').trim();
    const query = q ? `name contains '${q.replace(/'/g, "\\'")}' and trashed = false` : 'trashed = false';
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('pageSize', '30');
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,webViewLink,size)');
    const data = await googleRequest(accessToken, url, { signal });
    return { files: data.files || [] };
  }
  if (name === 'google_drive_read') {
    const id = clean(args.file_id, 'file_id', 200);
    const metadata = await googleRequest(accessToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,webViewLink`, { signal });
    let endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
    if (metadata.mimeType === 'application/vnd.google-apps.document') endpoint = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text/plain`;
    const response = await fetch(endpoint, { redirect: 'error', headers: { authorization: `Bearer ${accessToken}` }, signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`Google Drive вернул HTTP ${response.status}: ${body.slice(0, 800)}`);
    return { name: metadata.name, url: metadata.webViewLink, text: body.slice(0, 24_000) };
  }
  if (name === 'google_docs_create') {
    const title = clean(args.title, 'title', 200);
    const content = clean(args.content, 'content', 50_000);
    const document = await googleRequest(accessToken, 'https://docs.googleapis.com/v1/documents', { method: 'POST', body: { title }, signal });
    await googleRequest(accessToken, `https://docs.googleapis.com/v1/documents/${encodeURIComponent(document.documentId)}:batchUpdate`, {
      method: 'POST', body: { requests: [{ insertText: { location: { index: 1 }, text: content } }] }, signal,
    });
    return { title, documentId: document.documentId, url: `https://docs.google.com/document/d/${document.documentId}/edit` };
  }
  if (name === 'gmail_search') {
    const q = encodeURIComponent(clean(args.query, 'query', 500));
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
    const listed = await googleRequest(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${limit}`, { signal });
    const messages = [];
    for (const row of (listed.messages || []).slice(0, limit)) {
      const message = await googleRequest(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(row.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, { signal });
      const headers = Object.fromEntries((message.payload?.headers || []).map((header) => [header.name.toLowerCase(), header.value]));
      messages.push({ id: row.id, threadId: message.threadId, from: headers.from, to: headers.to, subject: headers.subject, date: headers.date, snippet: message.snippet });
    }
    return { messages };
  }
  if (name === 'gmail_create_draft') {
    const to = clean(args.to, 'to', 500);
    const subject = clean(args.subject, 'subject', 500);
    const body = clean(args.body, 'body', 30_000);
    const raw = encodeBase64Url(`To: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`);
    const data = await googleRequest(accessToken, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', { method: 'POST', body: { message: { raw } }, signal });
    return { draftId: data.id, messageId: data.message?.id, note: 'Черновик создан; письмо не отправлялось.' };
  }
  if (name === 'google_calendar_list') {
    const days = Math.min(90, Math.max(1, Number(args.days) || 14));
    const now = new Date();
    const end = new Date(now.getTime() + days * 86_400_000);
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', now.toISOString());
    url.searchParams.set('timeMax', end.toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '100');
    const data = await googleRequest(accessToken, url, { signal });
    return { events: (data.items || []).map((event) => ({ id: event.id, summary: event.summary, start: event.start?.dateTime || event.start?.date, end: event.end?.dateTime || event.end?.date, location: event.location, link: event.htmlLink })) };
  }
  if (name === 'google_calendar_create_event') {
    const start = new Date(clean(args.start, 'start', 100));
    const end = new Date(clean(args.end, 'end', 100));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error('У события должны быть корректные даты ISO, а конец позже начала.');
    const data = await googleRequest(accessToken, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST', signal, body: { summary: clean(args.summary, 'summary', 300), description: String(args.description || '').slice(0, 8000), start: { dateTime: start.toISOString(), timeZone: String(args.time_zone || 'UTC').slice(0, 80) }, end: { dateTime: end.toISOString(), timeZone: String(args.time_zone || 'UTC').slice(0, 80) } },
    });
    return { id: data.id, summary: data.summary, link: data.htmlLink, start: data.start?.dateTime };
  }
  throw new Error(`Неизвестный Google-инструмент «${name}».`);
}

async function instagramRequest(token, userId, pathname, options = {}) {
  const base = `https://graph.facebook.com/${GRAPH_API_VERSION}/`;
  const url = new URL(pathname.replace(/^\/+/, ''), base);
  if (userId) url.searchParams.set('user_id', userId);
  if (options.params) for (const [key, value] of Object.entries(options.params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: options.method || 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: options.body ? new URLSearchParams(options.body) : undefined,
    signal: options.signal,
  });
  return readResponse(response, 'Instagram Graph API');
}

async function testInstagram({ token, instagramUserId }) {
  const accessToken = clean(token, 'Instagram access token', 5000);
  const id = clean(instagramUserId, 'Instagram User ID', 100);
  const profile = await instagramRequest(accessToken, '', id, { params: { fields: 'id,username,account_type' } });
  return { connected: true, account: profile.username || profile.id, accountType: profile.account_type || 'professional' };
}

async function executeInstagramTool(name, args, connector, signal) {
  const token = String(connector?.token || '').trim();
  const userId = String(connector?.instagramUserId || '').trim();
  if (!token || !userId) throw new Error('Instagram не подключён. Нужен Meta access token и ID профессионального Instagram-аккаунта.');
  if (name === 'instagram_get_profile') return instagramRequest(token, '', userId, { params: { fields: 'id,username,account_type,media_count,followers_count,follows_count' }, signal });
  if (name === 'instagram_list_media') {
    const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
    const data = await instagramRequest(token, '', `${userId}/media`, { params: { fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count', limit: String(limit) }, signal });
    return { media: data.data || [] };
  }
  if (name === 'instagram_get_insights') {
    const period = ['day', 'week', 'days_28'].includes(args.period) ? args.period : 'week';
    const data = await instagramRequest(token, '', `${userId}/insights`, { params: { metric: 'reach,profile_views', period }, signal });
    return { insights: data.data || [] };
  }
  if (name === 'instagram_publish_image') {
    const url = await assertPublicHttpUrl(clean(args.image_url, 'image_url', 2000));
    if (!['jpg', 'jpeg', 'png'].includes(url.pathname.split('.').pop().toLowerCase())) throw new Error('Instagram Graph API ожидает публичный JPEG или PNG URL.');
    const created = await instagramRequest(token, '', `${userId}/media`, { method: 'POST', body: { image_url: url.href, caption: String(args.caption || '').slice(0, 2000) }, signal });
    if (!created.id) throw new Error('Instagram не вернул ID контейнера для публикации.');
    const published = await instagramRequest(token, '', `${userId}/media_publish`, { method: 'POST', body: { creation_id: created.id }, signal });
    return { id: published.id, note: 'Публикация отправлена в Instagram.' };
  }
  throw new Error(`Неизвестный Instagram-инструмент «${name}».`);
}

function validateTelegramCredentials(token, chatId) {
  const safeToken = String(token || '').trim();
  const safeChatId = String(chatId || '').trim();
  if (!/^\d{5,15}:[A-Za-z0-9_-]{20,100}$/.test(safeToken)) throw new Error('Bot token имеет неверный формат. Получите токен у официального @BotFather.');
  if (!/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(safeChatId)) throw new Error('Chat ID должен быть числовым ID чата или @username канала.');
  return { token: safeToken, chatId: safeChatId };
}

async function telegramRequest(token, method, parameters = {}, { signal, fetchImpl = fetch } = {}) {
  const endpoint = new URL(`/bot${token}/${method}`, 'https://api.telegram.org');
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parameters),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    throw new Error('Не удалось связаться с Telegram. Проверьте интернет-соединение и попробуйте ещё раз.');
  }
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error(`Telegram вернул некорректный ответ (HTTP ${response.status}).`); }
  if (!response.ok || payload?.ok !== true) {
    const description = String(payload?.description || response.statusText || 'запрос отклонён').replace(/bot\d{5,15}:[A-Za-z0-9_-]+/g, '[bot token]').slice(0, 300);
    throw new Error(`Telegram API: ${description} (HTTP ${response.status}).`);
  }
  return payload.result;
}

async function testTelegram({ token, chatId }, options = {}) {
  const credentials = validateTelegramCredentials(token, chatId);
  const bot = await telegramRequest(credentials.token, 'getMe', {}, options);
  const chat = await telegramRequest(credentials.token, 'getChat', { chat_id: credentials.chatId }, options);
  return {
    connected: true,
    botUsername: String(bot.username || ''),
    chatId: String(chat.id || credentials.chatId),
    chatName: String(chat.title || chat.username || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || credentials.chatId),
  };
}

async function executeTelegramTool(name, args, connector, signal) {
  if (name !== 'telegram_send_message') throw new Error(`Неизвестный Telegram-инструмент «${name}».`);
  const { token, chatId } = validateTelegramCredentials(connector?.botToken, connector?.chatId);
  const text = clean(args.text, 'text', 4096);
  const result = await telegramRequest(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }, { signal });
  return { sent: true, messageId: result.message_id, chatId: String(result.chat?.id || chatId), textLength: text.length };
}

async function executeConnectorTool(name, args, context) {
  const githubToken = await context.vault.get(['connectors', 'github', 'token'], '');
  const google = await context.vault.get(['connectors', 'google'], {});
  const instagram = await context.vault.get(['connectors', 'instagram'], {});
  const telegram = await context.vault.get(['connectors', 'telegram'], {});
  if (name.startsWith('github_')) return executeGithubTool(name, args, githubToken, context.signal);
  if (name.startsWith('google_') || name.startsWith('gmail_')) return executeGoogleTool(name, args, context.vault, context.signal);
  if (name.startsWith('instagram_')) return executeInstagramTool(name, args, instagram, context.signal);
  if (name.startsWith('telegram_')) return executeTelegramTool(name, args, telegram, context.signal);
  throw new Error(`Неизвестный connector tool «${name}».`);
}

async function availableConnectorTools(vault, selectedIds = ['github', 'google', 'instagram', 'telegram']) {
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const [github, google, instagram, telegram] = await Promise.all([
    vault.get(['connectors', 'github', 'token'], ''),
    vault.get(['connectors', 'google'], {}),
    vault.get(['connectors', 'instagram'], {}),
    vault.get(['connectors', 'telegram'], {}),
  ]);
  const ready = {
    github: selected.has('github') && Boolean(github),
    google: selected.has('google') && (Boolean(google?.refreshToken || google?.accessToken) || ['gmail', 'google-drive', 'google-calendar'].some((id) => selected.has(id))),
    instagram: selected.has('instagram') && Boolean(instagram?.token && instagram?.instagramUserId),
    telegram: selected.has('telegram') && Boolean(telegram?.botToken && telegram?.chatId),
  };
  return CONNECTOR_TOOL_DEFINITIONS.filter(({ function: fn }) => fn.name.startsWith('github_') ? ready.github
    : fn.name.startsWith('google_') || fn.name.startsWith('gmail_') ? ready.google
      : fn.name.startsWith('instagram_') ? ready.instagram
        : fn.name.startsWith('telegram_') ? ready.telegram : false);
}

module.exports = {
  CONNECTOR_CATALOG, CONNECTOR_TOOL_DEFINITIONS, GRAPH_API_VERSION,
  availableConnectorTools, executeConnectorTool, getGoogleAccessToken, testGithub, testInstagram, testTelegram, validateTelegramCredentials,
};
