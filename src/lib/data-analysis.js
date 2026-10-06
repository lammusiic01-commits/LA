'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { safeExistingPath } = require('./files');

function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell.length === 0) quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((item) => item.some((value) => String(value).trim() !== ''));
}

function chooseDelimiter(text) {
  const first = String(text || '').split(/\r?\n/, 1)[0] || '';
  return ['\t', ',', ';', '|'].map((delimiter) => ({ delimiter, count: first.split(delimiter).length })).sort((a, b) => b.count - a.count)[0].delimiter;
}

function rowsFromJson(value) {
  if (!Array.isArray(value)) throw new Error('JSON для анализа должен быть массивом объектов или строк.');
  if (!value.length) return { headers: [], records: [] };
  if (value.every((item) => Array.isArray(item))) return { headers: value[0].map(String), records: value.slice(1) };
  if (value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    const headers = [...new Set(value.flatMap((item) => Object.keys(item)))].slice(0, 100);
    return { headers, records: value.map((item) => headers.map((header) => item[header])) };
  }
  return { headers: ['value'], records: value.map((item) => [item]) };
}

function analyzeRows(headers, records) {
  const columns = headers.slice(0, 100).map((header, columnIndex) => {
    const values = records.slice(0, 50_000).map((row) => row?.[columnIndex]);
    const present = values.map((value) => value === null || value === undefined ? '' : String(value).trim()).filter(Boolean);
    const numbers = present.map(Number).filter(Number.isFinite);
    const numeric = present.length > 0 && numbers.length >= Math.ceil(present.length * 0.8);
    const unique = new Set(present);
    const result = { name: String(header).slice(0, 150), present: present.length, missing: values.length - present.length, unique: unique.size, type: numeric ? 'numeric' : 'text' };
    if (numeric) {
      const sorted = numbers.toSorted((a, b) => a - b);
      result.sum = Number(numbers.reduce((sum, value) => sum + value, 0).toFixed(6));
      result.mean = Number((result.sum / numbers.length).toFixed(6));
      result.min = sorted[0];
      result.max = sorted.at(-1);
      result.median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Number(((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2).toFixed(6));
    } else {
      const counts = new Map();
      for (const value of present) counts.set(value, (counts.get(value) || 0) + 1);
      result.topValues = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value: value.slice(0, 100), count }));
    }
    return result;
  });
  return { rows: records.length, columns: headers.length, sampleRows: records.slice(0, 3).map((row) => row.slice(0, 12)), statistics: columns };
}

async function analyzeDataFile(workspaceRoot, requestedPath, { allowOutside = false } = {}) {
  const filePath = await safeExistingPath(workspaceRoot, requestedPath, { allowOutside });
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw new Error('Для анализа нужен файл до 12 МБ.');
  const text = await fs.readFile(filePath, 'utf8');
  if (text.includes('\0')) throw new Error('Нельзя анализировать бинарный файл как данные.');
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json' || extension === '.jsonl' || extension === '.ndjson') {
    let value;
    if (extension === '.json') value = JSON.parse(text);
    else value = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const parsed = rowsFromJson(value);
    return { path: String(requestedPath), format: extension.slice(1), ...analyzeRows(parsed.headers, parsed.records) };
  }
  if (!['.csv', '.tsv', '.txt'].includes(extension)) throw new Error('Data Analysis поддерживает CSV, TSV, JSON и JSONL.');
  const delimiter = extension === '.tsv' ? '\t' : chooseDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) return { path: String(requestedPath), format: extension.slice(1), rows: 0, columns: 0, statistics: [] };
  return { path: String(requestedPath), format: delimiter === '\t' ? 'tsv' : 'csv', delimiter: delimiter === '\t' ? '\\t' : delimiter, ...analyzeRows(rows[0], rows.slice(1)) };
}

module.exports = { analyzeDataFile, analyzeRows, parseDelimited, rowsFromJson };
