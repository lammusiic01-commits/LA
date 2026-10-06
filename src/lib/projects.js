'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { isPathInside } = require('./security');

function slugify(value) {
  const slug = String(value || '').normalize('NFC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!slug || slug === '.' || slug === '..') throw new Error('Название должно содержать буквы или цифры.');
  return slug;
}

async function createWorkspaceFolder(workspaceRoot, name) {
  const slug = slugify(name);
  const root = await fs.realpath(workspaceRoot).catch(async () => { await fs.mkdir(workspaceRoot, { recursive: true }); return fs.realpath(workspaceRoot); });
  const target = path.resolve(root, slug);
  if (!isPathInside(root, target) || target === root) throw new Error('Папка должна находиться внутри рабочего пространства.');
  await fs.mkdir(target, { recursive: false });
  return { name: String(name).trim().slice(0, 100), slug, path: target, createdAt: new Date().toISOString() };
}

async function createWorkspaceProject(workspaceRoot, name, goal, projects = []) {
  const folder = await createWorkspaceFolder(workspaceRoot, name);
  const project = {
    id: `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: folder.name,
    slug: folder.slug,
    path: folder.path,
    goal: String(goal || '').trim().slice(0, 2000),
    createdAt: folder.createdAt,
    pluginIds: ['data-analysis', 'design', 'motion', 'frontend', 'qa'],
    connectorIds: [],
  };
  const readme = `# ${project.name}\n\n${project.goal ? `## Цель проекта\n\n${project.goal}\n\n` : ''}## Работа с Localis\n\nВсе файлы проекта находятся в этой папке. Уточняйте планы и проверяйте результаты перед публикацией.\n`;
  await fs.writeFile(path.join(folder.path, 'README.md'), readme, { flag: 'wx' });
  await fs.writeFile(path.join(folder.path, '.localis-project.json'), JSON.stringify({ id: project.id, goal: project.goal, createdAt: project.createdAt }, null, 2), { flag: 'wx' });
  return { project, projects: [...projects, project] };
}

function projectById(projects, id) {
  if (!id) return null;
  return (Array.isArray(projects) ? projects : []).find((project) => project?.id === id) || null;
}

function validateProjectRoot(workspaceRoot, project) {
  if (!project || typeof project.path !== 'string' || !path.isAbsolute(project.path)) throw new Error('Проект не найден.');
  const root = path.resolve(workspaceRoot);
  const projectRoot = path.resolve(project.path);
  if (!isPathInside(root, projectRoot) || projectRoot === root) throw new Error('Папка проекта вышла за пределы workspace.');
  return projectRoot;
}

module.exports = { createWorkspaceFolder, createWorkspaceProject, projectById, slugify, validateProjectRoot };
