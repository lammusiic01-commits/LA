'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceFolder, createWorkspaceProject, projectById, slugify, validateProjectRoot } = require('../src/lib/projects');

test('project and folder creation support Unicode names and keep paths inside the workspace', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'localis-project-test-'));
  const root = path.join(parent, 'workspace');
  await fs.mkdir(root);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));

  const { project, projects } = await createWorkspaceProject(root, 'Мой проект', 'Собрать сайт-портфолио', []);
  assert.equal(project.slug, 'мой-проект');
  assert.equal(projectById(projects, project.id), project);
  assert.equal(validateProjectRoot(root, project), project.path);
  assert.match(await fs.readFile(path.join(project.path, 'README.md'), 'utf8'), /Собрать сайт-портфолио/);
  assert.equal((await fs.readFile(path.join(project.path, '.localis-project.json'), 'utf8')).includes(project.id), true);

  const folder = await createWorkspaceFolder(root, 'Дизайн-система');
  assert.equal(folder.slug, 'дизайн-система');
  assert.equal(path.dirname(folder.path), await fs.realpath(root));
  assert.throws(() => slugify('***'), /буквы или цифры/);
  assert.throws(() => validateProjectRoot(root, { path: parent }), /workspace/);
});
