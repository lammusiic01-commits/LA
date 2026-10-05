'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isPathInside, resolveWorkspacePath } = require('./security');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.venv', 'release', 'dist', 'coverage']);

async function realWorkspace(workspaceRoot) {
  await fs.mkdir(workspaceRoot, { recursive: true });
  return fs.realpath(workspaceRoot);
}

async function assertRealPathInside(root, target) {
  if (!isPathInside(root, target)) throw new Error('Путь выходит за пределы рабочей папки.');
  const realRoot = await realWorkspace(root);
  const realTarget = await fs.realpath(target);
  if (!isPathInside(realRoot, realTarget)) throw new Error('Путь через символьную ссылку выходит за пределы рабочей папки.');
  return realTarget;
}

async function safeExistingPath(workspaceRoot, relativePath) {
  const root = await realWorkspace(workspaceRoot);
  const target = resolveWorkspacePath(root, relativePath);
  return assertRealPathInside(root, target);
}

async function safeWriteTarget(workspaceRoot, relativePath) {
  const root = await realWorkspace(workspaceRoot);
  const target = resolveWorkspacePath(root, relativePath);
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  if (!isPathInside(root, realParent)) throw new Error('Родительская папка выходит за пределы рабочей папки.');
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink()) await assertRealPathInside(root, target);
    else if (!isPathInside(root, target)) throw new Error('Путь выходит за пределы рабочей папки.');
    if (existing.isDirectory()) throw new Error('Вместо файла указан каталог.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

async function listWorkspaceFiles(workspaceRoot, relativeDirectory = '') {
  const root = await realWorkspace(workspaceRoot);
  const start = relativeDirectory ? await safeExistingPath(root, relativeDirectory) : root;
  const startStat = await fs.stat(start);
  if (!startStat.isDirectory()) throw new Error('Указанный путь не является папкой.');
  const results = [];
  const maxEntries = 500;

  async function visit(directory, depth) {
    if (depth > 5 || results.length >= maxEntries) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxEntries) break;
      if (entry.isDirectory() && HIDDEN_DIRS.has(entry.name.toLowerCase())) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        results.push({ path: `${relative}/`, type: 'folder' });
        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        results.push({ path: relative, type: 'file', size: stat.size });
      }
    }
  }

  await visit(start, 0);
  return { root, directory: path.relative(root, start).split(path.sep).join('/'), files: results, truncated: results.length >= maxEntries };
}

async function readWorkspaceFile(workspaceRoot, relativePath) {
  const filePath = await safeExistingPath(workspaceRoot, relativePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('Можно читать только файлы.');
  if (stat.size > MAX_TEXT_BYTES) throw new Error('Файл больше лимита чтения 2 МБ.');
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) throw new Error('Похоже, это бинарный файл. Чтение бинарных файлов как текста запрещено.');
  return { path: String(relativePath), size: stat.size, text: buffer.toString('utf8') };
}

async function writeWorkspaceFile(workspaceRoot, relativePath, content) {
  if (typeof content !== 'string') throw new Error('Содержимое файла должно быть текстом.');
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength > MAX_TEXT_BYTES) throw new Error('Текстовый файл больше лимита 2 МБ.');
  const root = await realWorkspace(workspaceRoot);
  const filePath = await safeWriteTarget(root, relativePath);
  await fs.writeFile(filePath, buffer, { flag: 'w' });
  return { path: path.relative(root, filePath).split(path.sep).join('/'), size: buffer.byteLength };
}

async function writeWorkspaceBuffer(workspaceRoot, relativePath, buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.byteLength > 100 * 1024 * 1024) throw new Error('Бинарный файл больше лимита 100 МБ.');
  const root = await realWorkspace(workspaceRoot);
  const filePath = await safeWriteTarget(root, relativePath);
  await fs.writeFile(filePath, buffer, { flag: 'w' });
  return { path: path.relative(root, filePath).split(path.sep).join('/'), size: buffer.byteLength };
}

module.exports = {
  listWorkspaceFiles,
  realWorkspace,
  readWorkspaceFile,
  safeExistingPath,
  safeWriteTarget,
  writeWorkspaceBuffer,
  writeWorkspaceFile,
};
