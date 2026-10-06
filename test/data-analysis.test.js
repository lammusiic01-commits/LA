'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { analyzeDataFile, parseDelimited, rowsFromJson } = require('../src/lib/data-analysis');

test('CSV parser handles quoted delimiters, escaped quotes and missing values', () => {
  assert.deepEqual(parseDelimited('name,score,note\n"Ada, Lovelace",10,"said ""hello"""\nLin,20,', ','), [
    ['name', 'score', 'note'],
    ['Ada, Lovelace', '10', 'said "hello"'],
    ['Lin', '20', ''],
  ]);
});

test('JSON normalization converts object rows into a stable table', () => {
  assert.deepEqual(rowsFromJson([{ name: 'Ada', score: 10 }, { name: 'Lin', extra: true }]), {
    headers: ['name', 'score', 'extra'],
    records: [['Ada', 10, undefined], ['Lin', undefined, true]],
  });
});

test('Data Analysis reports real local summaries without modifying the source', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'localis-data-test-'));
  const root = path.join(parent, 'workspace');
  await fs.mkdir(root);
  const filename = path.join(root, 'scores.csv');
  const original = 'name,score\nAda,10\nLin,20\nNoor,\n';
  await fs.writeFile(filename, original);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));

  const result = await analyzeDataFile(root, 'scores.csv');
  assert.equal(result.rows, 3);
  assert.equal(result.columns, 2);
  assert.equal(result.statistics[1].mean, 15);
  assert.equal(result.statistics[1].missing, 1);
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  await assert.rejects(analyzeDataFile(root, '../outside.csv'), /рабочей папки/);
});
