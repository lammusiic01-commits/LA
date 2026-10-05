'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDocument } = require('../src/lib/documents');

test('creates DOCX, PDF, XLSX, and PPTX files in the workspace', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'localis-documents-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const cases = [
    ['docx', { content: '# Заголовок\nТекст документа.' }, '504b0304'],
    ['pdf', { content: 'Локальный PDF-документ.' }, '255044462d'],
    ['xlsx', { sheets: [{ name: 'План', rows: [['Задача', 'Срок'], ['Прототип', '10 дней']] }] }, '504b0304'],
    ['pptx', { slides: [{ title: 'План', bullets: ['Первый шаг', 'Второй шаг'] }] }, '504b0304'],
  ];
  for (const [format, extras, magic] of cases) {
    const result = await createDocument(workspace, {
      format, path: `artifacts/sample.${format}`, title: 'Проверка Localis', ...extras,
    });
    const data = await fs.readFile(path.join(workspace, result.path));
    assert.equal(result.format, format);
    assert.ok(data.length > 1000);
    assert.equal(data.subarray(0, magic.length / 2).toString('hex'), magic);
  }
});
