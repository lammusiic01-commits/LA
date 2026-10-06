'use strict';

const { assertPublicHttpUrl } = require('./security');

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = 'LocalisDesktop/1.0 (local-first browser agent)';

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const hex = entity[1].toLowerCase() === 'x';
    const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(number) || number < 0 || number > 0x10ffff) return match;
    try { return String.fromCodePoint(number); } catch { return match; }
  });
}

function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|article|section|main|blockquote|pre|table)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[\t\u00a0 ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

async function readResponseLimited(response, maxBytes = MAX_PAGE_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Сайт вернул слишком большой документ (лимит 2 МБ).');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Сайт вернул слишком большой документ (лимит 2 МБ).');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

async function fetchPublicHtml(startUrl, { signal, maxBytes = MAX_PAGE_BYTES } = {}) {
  let current = new URL(startUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    current = await assertPublicHttpUrl(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Таймаут запроса к сайту.')), 18_000);
    const onAbort = () => controller.abort(signal.reason || new Error('Запрос отменён.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.2',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new Error('Слишком много перенаправлений.');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`Сайт ответил HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !/(text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
        throw new Error(`Этот инструмент читает текст и HTML, а не ${contentType}.`);
      }
      const html = await readResponseLimited(response, maxBytes);
      return { html, finalUrl: current.href, contentType };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new Error('Не удалось открыть страницу.');
}

async function readWebpage(url, options = {}) {
  const { html, finalUrl, contentType } = await fetchPublicHtml(url, options);
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 240) : finalUrl;
  return { url: finalUrl, title, contentType, text: htmlToText(html).slice(0, 18_000) };
}

function unwrapDuckDuckGoUrl(href) {
  const decoded = decodeEntities(href);
  try {
    const url = new URL(decoded.startsWith('//') ? `https:${decoded}` : decoded, 'https://html.duckduckgo.com');
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg');
      if (target) return target;
    }
    return url.href;
  } catch {
    return decoded;
  }
}

function extractSearchResults(html, limit = 8) {
  const results = [];
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while ((match = anchors.exec(html)) && results.length < limit) {
    const attributes = match[1];
    const classMatch = attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
    if (!classMatch || !/(result__a|result-link)/i.test(classMatch[2])) continue;
    const hrefMatch = attributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    if (!hrefMatch) continue;
    const title = htmlToText(match[2]).trim();
    const url = unwrapDuckDuckGoUrl(hrefMatch[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const tail = html.slice(anchors.lastIndex, anchors.lastIndex + 1600);
    const snippetMatch = tail.match(/class\s*=\s*(["'])[^"']*(?:result__snippet|result-snippet)[^"']*\1[^>]*>([\s\S]*?)(?:<\/div|<\/td|<\/a)/i);
    const snippet = snippetMatch ? htmlToText(snippetMatch[2]).slice(0, 500) : '';
    if (results.some((entry) => entry.url === url)) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

async function searchWeb(query, { signal } = {}) {
  const cleanQuery = String(query || '').trim().slice(0, 400);
  if (!cleanQuery) throw new Error('Поисковый запрос пустой.');
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', cleanQuery);
  const { html } = await fetchPublicHtml(url.href, { signal, maxBytes: 2 * 1024 * 1024 });
  const results = extractSearchResults(html);
  if (!results.length) return { query: cleanQuery, results: [], note: 'Поиск не вернул распознаваемых результатов.' };
  return { query: cleanQuery, results };
}

module.exports = { decodeEntities, extractSearchResults, fetchPublicHtml, htmlToText, readWebpage, searchWeb };
