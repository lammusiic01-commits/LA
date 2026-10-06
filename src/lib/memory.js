'use strict';

const MAX_ENTRIES = 80;
const MAX_SUMMARY_CHARS = 10_000;

function redactSensitive(value) {
  return String(value || '')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[\w-]{20,}|xai-[A-Za-z0-9_-]{16,})\b/gi, '[секрет удалён]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [секрет удалён]')
    .replace(/\b(api[_ -]?key|(?:access|refresh)?[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[секрет удалён]');
}

function cleanSnippet(value, max = 700) {
  return redactSensitive(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function rebuildSummary(entries) {
  const lines = entries.slice(-25).map((entry) => {
    const when = String(entry.savedAt || '').slice(0, 10);
    const project = entry.project ? ` · ${cleanSnippet(entry.project, 60)}` : '';
    return `${when}${project}\nЗадача: ${cleanSnippet(entry.request, 440)}\nИтог: ${cleanSnippet(entry.outcome, 440)}`;
  });
  let summary = lines.join('\n\n');
  if (summary.length > MAX_SUMMARY_CHARS) summary = summary.slice(-MAX_SUMMARY_CHARS);
  return summary;
}

function appendTurn(snapshot, { request, outcome, project, savedAt = new Date().toISOString() }) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries.slice(-MAX_ENTRIES + 1) : [];
  const entry = {
    savedAt: String(savedAt),
    project: cleanSnippet(project, 100),
    request: cleanSnippet(request, 1200),
    outcome: cleanSnippet(outcome, 1200),
  };
  if (!entry.request && !entry.outcome) return normalizeMemory(snapshot);
  entries.push(entry);
  return { updatedAt: entry.savedAt, entries, summary: rebuildSummary(entries) };
}

function normalizeMemory(value) {
  if (Array.isArray(value)) {
    return appendLegacy(value);
  }
  if (!value || typeof value !== 'object') return { updatedAt: null, entries: [], summary: '' };
  const entries = Array.isArray(value.entries) ? value.entries.slice(-MAX_ENTRIES).map((entry) => ({
    savedAt: String(entry.savedAt || ''),
    project: cleanSnippet(entry.project, 100),
    request: cleanSnippet(entry.request, 1200),
    outcome: cleanSnippet(entry.outcome, 1200),
  })) : [];
  return { updatedAt: String(value.updatedAt || '') || null, entries, summary: rebuildSummary(entries) };
}

function appendLegacy(notes) {
  const entries = notes.filter((note) => note && typeof note.note === 'string').slice(-MAX_ENTRIES).map((note) => ({
    savedAt: String(note.savedAt || ''), project: '', request: 'Пользовательская заметка', outcome: cleanSnippet(note.note, 1200),
  }));
  return { updatedAt: entries.at(-1)?.savedAt || null, entries, summary: rebuildSummary(entries) };
}

module.exports = { appendTurn, normalizeMemory, rebuildSummary, redactSensitive };
