'use strict';

const { redactSensitive } = require('./memory');

const PROVIDERS = Object.freeze({
  openai: { name: 'OpenAI / ChatGPT', endpoint: 'https://api.openai.com/v1/chat/completions', defaultModel: 'gpt-4.1-mini', models: ['gpt-4.1-mini', 'gpt-4.1', 'o4-mini'] },
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] },
  openrouter: { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', defaultModel: 'openai/gpt-4.1-mini', models: ['openai/gpt-4.1-mini', 'deepseek/deepseek-chat-v3-0324:free', 'anthropic/claude-3.7-sonnet'] },
  xai: { name: 'xAI / Grok', endpoint: 'https://api.x.ai/v1/chat/completions', defaultModel: 'grok-3-mini-latest', models: ['grok-3-mini-latest', 'grok-3-latest'] },
});

function providerInfo(id) {
  const provider = PROVIDERS[String(id || '')];
  if (!provider) throw new Error('Неизвестный AI-провайдер.');
  return provider;
}

function safeMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('Провайдеру нужен список сообщений.');
  return messages.slice(-32).map((message) => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role)) return null;
    const content = redactSensitive(message.content || '').slice(0, 24_000);
    return content ? { role: message.role, content } : null;
  }).filter(Boolean);
}

async function callProvider({ providerId, apiKey, model, messages, signal, timeoutMs = 90_000 }) {
  const provider = providerInfo(providerId);
  const key = String(apiKey || '').trim();
  if (!key) throw new Error(`Сначала сохраните API-ключ ${provider.name} в настройках.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${provider.name}: превышен лимит ожидания.`)), timeoutMs);
  const onAbort = () => controller.abort(signal.reason || new Error('Запрос отменён.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(providerId === 'openrouter' ? { 'http-referer': 'https://localis.desktop', 'x-title': 'Localis Desktop' } : {}) },
      signal: controller.signal,
      body: JSON.stringify({ model: String(model || provider.defaultModel).slice(0, 140), messages: safeMessages(messages), temperature: 0.35, stream: false }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${provider.name} вернул HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`${provider.name} вернул некорректный JSON.`); }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(`${provider.name} не вернул текстовый ответ.`);
    return { provider: providerId, model: data.model || model || provider.defaultModel, content: content.slice(0, 64_000), usage: data.usage || null };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw controller.signal.reason || new Error(`${provider.name}: запрос превысил лимит ожидания.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { PROVIDERS, callProvider, providerInfo, safeMessages };
