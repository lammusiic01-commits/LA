'use strict';

const path = require('node:path');
const { assertPublicHttpUrl } = require('./security');

const BUILTIN_PLUGINS = Object.freeze([
  {
    id: 'data-analysis', name: 'Data Analysis', category: 'Данные', icon: '▤',
    description: 'Анализ CSV, TSV и JSON, сводки, проверка данных и расчёт статистик.',
    instructions: 'Когда задача связана с данными, сначала проверь структуру и пропуски через analyze_data_file. Объясняй метод, отделяй наблюдения от выводов, перепроверь числа и не изменяй исходный файл без отдельного запроса.',
  },
  {
    id: 'design', name: 'Product Design', category: 'Дизайн', icon: '✦',
    description: 'Дизайн-системы, иерархия, адаптивность, доступность и UX.',
    instructions: 'Работай как продуктовый дизайнер: определи пользователя, задачу и визуальную иерархию. Для интерфейсов предложи согласованную палитру, типографику, состояния и responsive layout; учитывай клавиатурную навигацию и контраст.',
  },
  {
    id: 'motion', name: 'Motion Design', category: 'Видео и анимация', icon: '▶',
    description: 'Сценарии движения и веб-анимация с учётом reduced motion.',
    instructions: 'Работай как motion-дизайнер: планируй тайминг, ключевые кадры, easing, последовательность сцен и читаемость. Для веба предпочитай CSS animations/Web Animations API и всегда уважай prefers-reduced-motion.',
  },
  {
    id: 'frontend', name: 'Frontend Engineer', category: 'Разработка', icon: '⌘',
    description: 'Архитектура UI, доступность, тесты и исправление ошибок.',
    instructions: 'Работай как senior frontend инженер: сначала изучи структуру, затем делай небольшие проверяемые изменения, избегай лишних зависимостей, добавляй тесты и запускай их. При ошибке попробуй альтернативный безопасный подход и сообщи проверяемый результат.',
  },
  {
    id: 'qa', name: 'QA & Debugging', category: 'Разработка', icon: '✓',
    description: 'Воспроизведение ошибок, диагностика и регрессионные проверки.',
    instructions: 'Работай как QA-инженер: сначала воспроизведи проблему, зафиксируй фактический и ожидаемый результат, проверь несколько причин, исправь минимально и повтори тест. Не заявляй об успехе без вывода теста.',
  },
]);

function normalizeImportedPlugin(input, source = 'local') {
  const plugin = typeof input === 'string' ? { instructions: input, name: source } : input;
  if (!plugin || typeof plugin !== 'object') throw new Error('Манифест плагина должен быть текстом или JSON-объектом.');
  const name = String(plugin.name || plugin.title || '').trim().slice(0, 100);
  const instructions = String(plugin.instructions || plugin.prompt || plugin.content || '').trim();
  if (!name || instructions.length < 20 || instructions.length > 24_000) throw new Error('У плагина должно быть имя и инструкции объёмом от 20 до 24 000 символов.');
  const id = String(plugin.id || name.normalize('NFC').toLocaleLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '-'))
    .normalize('NFC').replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 80);
  if (!id) throw new Error('Не удалось сформировать идентификатор плагина.');
  return { id: `custom-${id}`, name, category: String(plugin.category || 'Импортированные').slice(0, 60), description: String(plugin.description || '').slice(0, 300), instructions, source: String(source).slice(0, 250), builtin: false, enabled: true, installedAt: new Date().toISOString() };
}

async function installPluginFromUrl(value, { signal, fetchImpl = fetch, assertUrl = assertPublicHttpUrl } = {}) {
  let candidate;
  try { candidate = new URL(String(value || '').trim()); } catch { throw new Error('Введите полный URL на .md, .txt или .json skill-файл.'); }
  if (!['http:', 'https:'].includes(candidate.protocol) || candidate.username || candidate.password) throw new Error('Для plugin разрешена только публичная HTTP(S)-ссылка без логина и пароля.');
  const extension = path.posix.extname(candidate.pathname).toLowerCase();
  if (!['.md', '.txt', '.json'].includes(extension)) throw new Error('Онлайн-import принимает только файлы .md, .txt или .json; HTML и исполняемые файлы запрещены.');
  const url = await assertUrl(candidate.href);
  const timeout = AbortSignal.timeout(25_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: requestSignal, headers: { accept: 'text/markdown, text/plain, application/json;q=0.9' } });
  if (!response.ok) throw new Error(`Plugin URL вернул HTTP ${response.status}.`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > 40_000) throw new Error('Онлайн-plugin больше лимита 40 КБ.');
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !/(text\/|application\/json|application\/octet-stream)/i.test(contentType)) throw new Error(`Ожидался текстовый skill-файл, сервер вернул ${contentType}.`);
  if (!response.body) throw new Error('Plugin URL вернул пустое тело.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > 40_000) {
        await reader.cancel();
        throw new Error('Онлайн-plugin больше лимита 40 КБ.');
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally { reader.releaseLock?.(); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.includes('\0')) throw new Error('Plugin должен быть обычным текстовым файлом.');
  let manifest = { name: path.posix.basename(candidate.pathname, extension), instructions: text };
  if (extension === '.json') {
    try { manifest = JSON.parse(text); } catch { throw new Error('JSON plugin не удалось прочитать.'); }
  }
  return normalizeImportedPlugin(manifest, candidate.href);
}

function activePlugins(custom = [], enabledIds = null) {
  const all = [...BUILTIN_PLUGINS, ...(Array.isArray(custom) ? custom : [])];
  const enabled = enabledIds ? new Set(enabledIds) : null;
  return all.filter((plugin) => plugin && (!enabled || enabled.has(plugin.id)));
}

module.exports = { BUILTIN_PLUGINS, activePlugins, installPluginFromUrl, normalizeImportedPlugin };
